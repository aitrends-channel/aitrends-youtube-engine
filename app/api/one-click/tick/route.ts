import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { advanceProject, sendAttentionEmail } from "@/lib/one-click/orchestrator";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { OneClickConfig } from "@/lib/one-click/config";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 1Click driver. Finds running autopilot projects and advances each by
// one step, then updates status/error. Runs on a Vercel cron (backstop)
// and can be nudged after a step completes for faster progress.
//
// Protected by CRON_SECRET (bearer) when set, matching the other crons.
// One step per project per tick keeps each invocation bounded and makes
// long async work (media generation, assembly) poll across ticks.

const BATCH = 25;

async function handle(req: Request) {
  // Cron authenticates with the CRON_SECRET bearer; a logged-in user
  // may also nudge (the post-kickoff fire-and-forget) — either is fine
  // since the driver only ever touches auto_pilot=running projects.
  const cronSecret = process.env.CRON_SECRET;
  const bearerOk = !cronSecret || req.headers.get("authorization") === `Bearer ${cronSecret}`;
  if (!bearerOk) {
    try { await getRequiredUser(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  }

  const { data, error } = await supabase
    .from("projects")
    .select("id, user_id, current_state, selected_topic, script, channel_analysis, content_type, auto_pilot_config")
    .eq("auto_pilot", true)
    .eq("auto_pilot_status", "running")
    .order("auto_pilot_last_tick", { ascending: true, nullsFirst: true })
    .limit(BATCH);

  if (error) {
    // 42703/42P01 = migration 097 not applied — nothing to do, don't 500.
    if (error.code === "42703" || error.code === "42P01") {
      return NextResponse.json({ ok: true, ticked: 0, note: "1Click tables not present yet." });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const projects = data ?? [];
  const results: { id: string; outcome: string; note?: string }[] = [];

  // Per-project lock. A single pipeline step (script / visuals / prompts
  // generation) routinely runs longer than the 12s UI self-nudge, so
  // without a lock two overlapping ticks call advanceProject on the SAME
  // project concurrently. For the prompts step that's fatal: generateImages
  // claims a run_id at start and the second run's claim makes the first
  // abort with "cancelled — the step was cleared while in flight". It also
  // risks double KIE spend on the generate / thumbnail steps.
  //
  // We lease the project using auto_pilot_last_tick AS the lock:
  //   • claim = a conditional UPDATE that only matches when the row is
  //     free (last_tick NULL) or the previous lease is stale (older than
  //     LEASE_MS — recovers a tick that crashed or timed out mid-step).
  //   • the auto_pilot_status='running' guard in the same UPDATE makes a
  //     Pause/Stop between the batch read and the claim take effect (the
  //     claim matches nothing and we skip).
  //   • release = null the column when the step returns, so the next
  //     scheduled tick advances immediately instead of waiting the lease.
  // The UPDATE…WHERE is atomic at the row level, so exactly one concurrent
  // tick wins the claim; the losers get an empty result and skip.
  const LEASE_MS = 6 * 60 * 1000; // > tick maxDuration (300s): only a dead tick's lease goes stale
  const staleCutoff = new Date(Date.now() - LEASE_MS).toISOString();

  for (const p of projects) {
    const { data: claimed } = await supabase
      .from("projects")
      .update({ auto_pilot_last_tick: new Date().toISOString() })
      .eq("id", p.id)
      .eq("auto_pilot", true)
      .eq("auto_pilot_status", "running")
      .or(`auto_pilot_last_tick.is.null,auto_pilot_last_tick.lt.${staleCutoff}`)
      .select("id");
    if (!claimed || claimed.length === 0) {
      // Someone else holds the lock, or the run was paused/stopped since
      // the batch was read.
      results.push({ id: p.id, outcome: "skipped", note: "locked or not running" });
      continue;
    }

    // Notification preference for this run (default on). This runs at the
    // running → needs_attention transition, which happens once (the next
    // tick skips a non-running project), so the email isn't repeated.
    const notifyOnAttention = (p.auto_pilot_config as OneClickConfig | null)?.notifications?.onAttention !== false;

    try {
      const r = await advanceProject(p);
      const patch: Record<string, unknown> =
        r.kind === "attention"
          ? { auto_pilot_status: "needs_attention", auto_pilot_error: r.note || "This step couldn't be completed automatically. Open the project to finish it." }
          : r.kind === "done"
            ? { auto_pilot_status: "completed", auto_pilot_error: null }
            : { auto_pilot_error: null }; // advanced / waiting stay "running"
      // Release the lock (null last_tick) alongside the outcome write so
      // the next tick can pick this project up right away.
      await supabase.from("projects").update({ ...patch, auto_pilot_last_tick: null }).eq("id", p.id);
      if (r.kind === "attention" && notifyOnAttention) {
        void sendAttentionEmail(p.id, p.user_id, patch.auto_pilot_error as string)
          .catch((e) => console.error(`[one-click] attention email failed for ${p.id}:`, e instanceof Error ? e.message : e));
      }
      results.push({ id: p.id, outcome: r.kind, note: "note" in r ? r.note : undefined });
    } catch (err) {
      const note = err instanceof Error ? err.message : "Step failed";
      await supabase.from("projects")
        .update({ auto_pilot_status: "needs_attention", auto_pilot_error: note, auto_pilot_last_tick: null })
        .eq("id", p.id);
      if (notifyOnAttention) {
        void sendAttentionEmail(p.id, p.user_id, note)
          .catch((e) => console.error(`[one-click] attention email failed for ${p.id}:`, e instanceof Error ? e.message : e));
      }
      results.push({ id: p.id, outcome: "error", note });
    }
  }

  return NextResponse.json({ ok: true, ticked: projects.length, results });
}

export const GET = handle;   // cron
export const POST = handle;  // nudge
