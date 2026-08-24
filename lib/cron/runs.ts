import { supabase } from "@/lib/supabase/client";
import { parseExpression } from "cron-parser";

// When each scheduled job last ran, and when it runs next.
//
// Vercel owns the schedule and nothing owned the outcome, so "did the sweeper
// run last night" meant reading logs and "when does the reconciler fire next"
// meant reading vercel.json and doing arithmetic. withCronRun wraps a job's
// body and records both ends of it; the schedule table below is what turns a
// cron expression into a date an admin can read.
//
// The schedules are duplicated here rather than read from vercel.json, which is
// not available at runtime on Vercel. A schedule changed in one place and not
// the other shows as a next-run time that never arrives, so they are listed
// side by side in the same order as the file to make a mismatch visible.

export interface CronJobSpec {
  /** Stable key, also the row's primary key. */
  name: string;
  path: string;
  /** The expression in vercel.json. Keep in step with it. */
  schedule: string;
  /** What it is for, in one line, for an admin who did not write it. */
  purpose: string;
}

export const CRON_JOBS: CronJobSpec[] = [
  { name: "genaipro-video", path: "/api/cron/genaipro-video", schedule: "*/1 * * * *", purpose: "Advances free-lane video clips" },
  { name: "finish-images", path: "/api/cron/finish-images", schedule: "*/2 * * * *", purpose: "Finishes image tasks the page stopped polling" },
  { name: "one-click-tick", path: "/api/one-click/tick", schedule: "*/2 * * * *", purpose: "Advances 1Click runs a step at a time" },
  { name: "support-auto-reply", path: "/api/cron/support-auto-reply", schedule: "*/5 * * * *", purpose: "Answers support mail the agent can handle" },
  { name: "worker-keepalive", path: "/api/cron/worker-keepalive", schedule: "*/10 * * * *", purpose: "Keeps the video worker awake" },
  { name: "sweep-reservations", path: "/api/cron/sweep-reservations", schedule: "17 * * * *", purpose: "Returns credits held by work that never finished" },
  { name: "snapshot-provider-balances", path: "/api/cron/snapshot-provider-balances", schedule: "7 * * * *", purpose: "Records the KIE and PoYo account balances" },
  { name: "storage-usage", path: "/api/cron/storage-usage", schedule: "35 */6 * * *", purpose: "Recomputes per-account storage" },
  { name: "refresh-model-cost-and-speed", path: "/api/cron/refresh-model-cost-and-speed", schedule: "0 3 * * *", purpose: "Refreshes observed model cost and speed" },
  { name: "cleanup-logs", path: "/api/cron/cleanup-logs", schedule: "0 4 * * *", purpose: "Trims the system log" },
  { name: "reconcile-rates", path: "/api/cron/reconcile-rates", schedule: "0 6 1 * *", purpose: "Checks billed rates against provider invoices" },
];

export interface CronRunRow {
  name: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: string | null;
  last_detail: string | null;
  last_ms: number | null;
  runs: number;
  failures: number;
}

export interface CronStatus extends CronJobSpec {
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lastDetail: string | null;
  lastMs: number | null;
  runs: number;
  failures: number;
  /** Computed from the schedule, in UTC, which is what Vercel fires on. */
  nextRunAt: string | null;
  /** True when the job has not run within two of its own intervals. Late is
   *  the useful signal: a job with a valid schedule and no recent run is
   *  either failing before it can stamp, or not being fired at all. */
  late: boolean;
}

function nextRun(schedule: string): Date | null {
  try {
    return parseExpression(schedule, { utc: true }).next().toDate();
  } catch {
    return null;
  }
}

/** Roughly how often this fires, for deciding whether a job is late. */
function intervalMs(schedule: string): number | null {
  try {
    const it = parseExpression(schedule, { utc: true });
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    return b - a;
  } catch {
    return null;
  }
}

/**
 * Record that a job ran, around the job itself.
 *
 * Stamps "running" before the body and the outcome after, so a row that still
 * says running long after its interval is a job that died mid-flight rather
 * than one that never started. Never throws: a status board must not be able
 * to take down the work it describes.
 */
export async function withCronRun<T>(
  name: string,
  run: (ctx: { detail: (line: string) => void }) => Promise<T>,
): Promise<T> {
  const startedAt = new Date();
  await stamp(name, { last_started_at: startedAt.toISOString(), last_status: "running", last_detail: null });

  let detail: string | null = null;
  try {
    const result = await run({ detail: (line) => { detail = line.slice(0, 500); } });
    await stamp(name, {
      last_finished_at: new Date().toISOString(),
      last_status: "ok",
      last_detail: detail,
      last_ms: Date.now() - startedAt.getTime(),
    }, { countRun: true });
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await stamp(name, {
      last_finished_at: new Date().toISOString(),
      last_status: "error",
      last_detail: message.slice(0, 500),
      last_ms: Date.now() - startedAt.getTime(),
    }, { countRun: true, countFailure: true });
    throw e;
  }
}

async function stamp(
  name: string,
  fields: Record<string, unknown>,
  counters?: { countRun?: boolean; countFailure?: boolean },
): Promise<void> {
  try {
    if (counters?.countRun) {
      // Read then write rather than an RPC: the counters are a convenience on a
      // status board, and a lost increment under concurrency costs nothing. Two
      // instances of the same cron firing at once is itself the bug to look at.
      const { data } = await supabase.from("cron_runs").select("runs, failures").eq("name", name).maybeSingle();
      const row = data as { runs?: number; failures?: number } | null;
      fields.runs = Number(row?.runs ?? 0) + 1;
      fields.failures = Number(row?.failures ?? 0) + (counters.countFailure ? 1 : 0);
    }
    const { error } = await supabase.from("cron_runs").upsert({ name, ...fields }, { onConflict: "name" });
    if (error) console.warn(`[cron/runs] could not stamp ${name}: ${error.message}`);
  } catch (e) {
    console.warn(`[cron/runs] stamp threw for ${name}:`, e instanceof Error ? e.message : e);
  }
}

/** Every scheduled job with its last run and its next, for the admin view. */
export async function listCronStatus(): Promise<CronStatus[]> {
  const { data } = await supabase.from("cron_runs").select("*");
  const byName = new Map((data ?? []).map((r) => [(r as CronRunRow).name, r as CronRunRow]));

  return CRON_JOBS.map((job) => {
    const row = byName.get(job.name);
    const next = nextRun(job.schedule);
    const interval = intervalMs(job.schedule);
    const last = row?.last_finished_at ?? row?.last_started_at ?? null;

    // Two intervals of slack. One is too tight: a job that takes a minute and
    // fires every two would read as late on every other poll.
    const late = interval !== null
      ? Date.now() - (last ? new Date(last).getTime() : 0) > interval * 2
      : false;

    return {
      ...job,
      lastStartedAt: row?.last_started_at ?? null,
      lastFinishedAt: row?.last_finished_at ?? null,
      lastStatus: row?.last_status ?? null,
      lastDetail: row?.last_detail ?? null,
      lastMs: row?.last_ms ?? null,
      runs: Number(row?.runs ?? 0),
      failures: Number(row?.failures ?? 0),
      nextRunAt: next ? next.toISOString() : null,
      late,
    };
  });
}
