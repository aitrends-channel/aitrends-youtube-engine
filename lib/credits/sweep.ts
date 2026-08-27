import "server-only";
import { supabase } from "@/lib/supabase/client";
import { releaseHeclusCredits } from "@/lib/heclus-credits";

// Give back credits held for work that never finished.
//
// Reserving before the work is what stops two submits spending the same
// credits. Its failure mode is the opposite one: a hold whose task died, whose
// webhook never arrived, or whose process was killed between reserving and
// submitting, sits open forever. The balance reads as spent, the credits are in
// `reserved` rather than `credits`, and nothing ever answers for them.
//
// So the hold needs an expiry, and this is it. Anything open longer than any
// plausible generation is released and logged. Logged at error level rather
// than info: a swept reservation is not routine housekeeping, it means a task
// went missing, and the count is the signal for whether the finishers are
// working.
//
// Two callers share this: the hourly cron, which sweeps everyone, and the
// workflow pages, which sweep the person looking at them every five minutes.
// The second exists because the first is not fast enough to be believed. A
// customer mid-project watches their own balance, and "your credits come back
// within two hours" is not an answer when the number on screen is what decides
// whether they can start the next step.

/** The default window, sized for the slowest thing the wallet buys: a video
 *  clip that queues at the provider and is settled by a worker minutes or
 *  hours later. Releasing one of those early would hand back the credits for
 *  work that then completes, and charge nothing for it. */
export const STALE_HOURS = 6;

/**
 * Per-provider windows, where the default is the wrong shape.
 *
 * An Anthropic hold is taken and settled inside a single request, and the
 * longest of them, a prompts run over a long script, is minutes. One still open
 * an hour later belongs to a request that died.
 */
export const STALE_HOURS_BY_PROVIDER: Record<string, number> = {
  anthropic: 1,
};

const MAX_PER_RUN = 200;

export interface SweepResult {
  found: number;
  released: number;
  credits: number;
}

/**
 * Release every hold that has outlived its provider's window.
 *
 * Pass a userId to sweep one account, which is what the workflow pages do:
 * a signed-in customer may reclaim their own abandoned holds, and nobody
 * else's.
 */
export async function sweepStaleHolds(opts?: { userId?: string }): Promise<SweepResult> {
  const byAge = await sweepByAge(opts);
  const byEvidence = await sweepFinishedBeats(opts);
  return {
    found: byAge.found + byEvidence.found,
    released: byAge.released + byEvidence.released,
    credits: byAge.credits + byEvidence.credits,
  };
}

/**
 * Release holds on beats whose work has demonstrably finished.
 *
 * Age is a poor proxy when the answer is already knowable. A hold on beat 21
 * whose image is sitting in R2 with no task outstanding is not work in
 * progress, it is debris from a submit that was superseded or a finisher that
 * settled a different hold. Waiting six hours to conclude that is theatre.
 *
 * The minimum age exists to avoid racing a submit: the hold is taken before the
 * beat row flips to queued, so for a few seconds a live generation looks idle.
 */
const FINISHED_BEAT_MIN_AGE_MS = 2 * 60_000;

const IMAGE_BUSY = new Set(["queued", "generating"]);
const VIDEO_BUSY = new Set(["queued", "submitting", "rendering"]);
const VOICE_BUSY = new Set(["queued", "generating"]);

async function sweepFinishedBeats(opts?: { userId?: string }): Promise<SweepResult> {
  let query = supabase
    .from("credit_reservations")
    .select("id, user_id, credits, provider, project_id, beat_number, created_at")
    .eq("state", "open")
    .not("beat_number", "is", null)
    .lt("created_at", new Date(Date.now() - FINISHED_BEAT_MIN_AGE_MS).toISOString())
    .limit(MAX_PER_RUN);
  if (opts?.userId) query = query.eq("user_id", opts.userId);

  const { data, error } = await query;
  if (error || !data?.length) return { found: 0, released: 0, credits: 0 };

  let found = 0;
  let released = 0;
  let credits = 0;
  for (const row of data as Array<{
    id: string; user_id: string; credits: number | string;
    provider: string | null; project_id: string | null; beat_number: number; created_at: string;
  }>) {
    if (!row.project_id) continue;
    const { data: beat } = await supabase
      .from("project_beats")
      .select("image_status, image_task_id, video_status, video_job_id, voiceover_status, voiceover_job_id")
      .eq("project_id", row.project_id)
      .eq("beat_number", row.beat_number)
      .maybeSingle();
    if (!beat) continue;

    const b = beat as {
      image_status: string | null; image_task_id: string | null;
      video_status: string | null; video_job_id: string | null;
      voiceover_status: string | null; voiceover_job_id: string | null;
    };
    // Busy means a status that is waiting AND something outstanding to wait on.
    // A "queued" with no task id is a beat that never got submitted, which is
    // exactly the case this is here to clean up.
    const busy =
      (IMAGE_BUSY.has(b.image_status ?? "") && !!b.image_task_id) ||
      (VIDEO_BUSY.has(b.video_status ?? "") && !!b.video_job_id) ||
      (VOICE_BUSY.has(b.voiceover_status ?? "") && !!b.voiceover_job_id);
    if (busy) continue;

    found++;
    const ok = await releaseHeclusCredits(row.id, "released: the beat's work had already finished");
    if (!ok) continue;
    released++;
    credits += Number(row.credits);
    console.warn(
      `[credits/sweep] released ${row.credits} credits held since ${row.created_at} on ` +
      `project=${row.project_id} beat=${row.beat_number}: nothing is outstanding for that beat.`,
    );
  }

  return { found, released, credits };
}

async function sweepByAge(opts?: { userId?: string }): Promise<SweepResult> {
  // Queried at the shortest window, then filtered to each row's own, so one
  // round trip covers every threshold.
  const shortest = Math.min(STALE_HOURS, ...Object.values(STALE_HOURS_BY_PROVIDER));
  const cutoff = new Date(Date.now() - shortest * 3_600_000).toISOString();

  let query = supabase
    .from("credit_reservations")
    .select("id, user_id, credits, provider, project_id, beat_number, created_at")
    .eq("state", "open")
    .lt("created_at", cutoff)
    .limit(MAX_PER_RUN);
  if (opts?.userId) query = query.eq("user_id", opts.userId);

  const { data, error } = await query;
  if (error) {
    console.error("[credits/sweep] query failed:", error.message);
    throw new Error(error.message);
  }

  const candidates = (data ?? []) as Array<{
    id: string; user_id: string; credits: number | string;
    provider: string | null; project_id: string | null; beat_number: number | null; created_at: string;
  }>;
  const stale = candidates.filter((row) => {
    const hours = STALE_HOURS_BY_PROVIDER[row.provider ?? ""] ?? STALE_HOURS;
    return Date.now() - Date.parse(row.created_at) >= hours * 3_600_000;
  });

  let released = 0;
  let credits = 0;
  for (const row of stale) {
    const hours = STALE_HOURS_BY_PROVIDER[row.provider ?? ""] ?? STALE_HOURS;
    const ok = await releaseHeclusCredits(row.id, `swept after ${hours}h with no result`);
    if (!ok) continue;
    released++;
    credits += Number(row.credits);
    console.error(
      `[credits/sweep] released ${row.credits} credits held since ${row.created_at} ` +
      `for user=${row.user_id} provider=${row.provider ?? "?"} project=${row.project_id ?? "?"} beat=${row.beat_number ?? "?"}. ` +
      "A hold this old means its task never reported back.",
    );
  }

  return { found: stale.length, released, credits };
}
