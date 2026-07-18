import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { advanceProject } from "@/lib/one-click/orchestrator";
import { getRequiredUser } from "@/lib/supabase/auth";

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

  for (const p of projects) {
    // Re-check status right before advancing: the batch was fetched a
    // moment ago, and the user may have hit Pause/Stop since. This makes
    // Pause take effect immediately instead of one step late.
    const { data: fresh } = await supabase
      .from("projects")
      .select("auto_pilot, auto_pilot_status")
      .eq("id", p.id)
      .single();
    if (!fresh?.auto_pilot || fresh.auto_pilot_status !== "running") {
      results.push({ id: p.id, outcome: "skipped", note: fresh?.auto_pilot_status ?? "not running" });
      continue;
    }

    // Claim the tick immediately so overlapping cron runs don't
    // double-process the same project.
    await supabase.from("projects").update({ auto_pilot_last_tick: new Date().toISOString() }).eq("id", p.id);

    try {
      const r = await advanceProject(p);
      const patch: Record<string, unknown> =
        r.kind === "attention"
          ? { auto_pilot_status: "needs_attention", auto_pilot_error: r.note || "This step couldn't be completed automatically. Open the project to finish it." }
          : r.kind === "done"
            ? { auto_pilot_status: "completed", auto_pilot_error: null }
            : { auto_pilot_error: null }; // advanced / waiting stay "running"
      await supabase.from("projects").update(patch).eq("id", p.id);
      results.push({ id: p.id, outcome: r.kind, note: "note" in r ? r.note : undefined });
    } catch (err) {
      const note = err instanceof Error ? err.message : "Step failed";
      await supabase.from("projects")
        .update({ auto_pilot_status: "needs_attention", auto_pilot_error: note })
        .eq("id", p.id);
      results.push({ id: p.id, outcome: "error", note });
    }
  }

  return NextResponse.json({ ok: true, ticked: projects.length, results });
}

export const GET = handle;   // cron
export const POST = handle;  // nudge
