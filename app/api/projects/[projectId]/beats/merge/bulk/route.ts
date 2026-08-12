export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { planBulkMerge, findStubs, type MergeDirection } from "@/lib/text/mergePlan";
import { decideMergeSides } from "@/lib/text/autoMergeSide";
import { deleteObject, r2KeyFromUrl } from "@/lib/supabase/storage";
import type { User } from "@supabase/supabase-js";
import { GENAIPRO_QUEUED_STATUS } from "@/lib/genaipro/client";

export const maxDuration = 120;

// Sweep every stub beat in one go, using the rules the user set in the dialog.
// The plan comes from planBulkMerge — the same function the dialog previewed
// with — so the count they approved is the count that runs.
//
// Each step is its own transaction (merge_project_beats). The sweep as a whole
// is therefore resumable rather than atomic: a failure midway leaves the
// earlier merges in place, which is fine because every one of them lands the
// project in a consistent state. The response reports what actually ran.
export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  let body: { minWords?: number; direction?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const minWords = body.minWords;
  const direction = body.direction;
  if (typeof minWords !== "number" || !Number.isInteger(minWords) || minWords < 1 || minWords > 50) {
    return NextResponse.json({ error: "minWords must be a whole number between 1 and 50" }, { status: 400 });
  }
  if (direction !== "up" && direction !== "down" && direction !== "auto") {
    return NextResponse.json({ error: 'direction must be "up", "down" or "auto"' }, { status: 400 });
  }

  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const { data: rawBeats, error: beatsErr } = await supabase
    .from("project_beats")
    .select("beat_number, script_segment, image_status, image_url, image_task_id, video_status, video_url, video_job_id, voiceover_status, voiceover_url, voiceover_job_id")
    .eq("project_id", projectId)
    .order("beat_number");
  if (beatsErr) {
    return NextResponse.json({ error: `Failed to load beats: ${beatsErr.message}` }, { status: 500 });
  }
  const beats = (rawBeats ?? []) as {
    beat_number: number;
    script_segment: string | null;
    image_status: string | null;
    image_url: string | null;
    image_task_id: string | null;
    video_status: string | null;
    video_url: string | null;
    video_job_id: string | null;
    voiceover_status: string | null;
    voiceover_url: string | null;
    voiceover_job_id: string | null;
  }[];
  if (beats.length < 2) {
    return NextResponse.json({ ok: true, merged: 0, remainingBeats: beats.length });
  }

  // Same in-flight rule as the single merge, but project-wide: a sweep can
  // renumber anywhere, so any outstanding job is a hazard. See that route for
  // why a busy status alone doesn't count.
  const IMAGE_BUSY = new Set(["queued", "generating"]);
  const VIDEO_BUSY = new Set([GENAIPRO_QUEUED_STATUS, "queued", "submitting", "rendering"]);
  const VOICE_BUSY = new Set(["queued", "generating"]);
  const busy = beats.find((b) =>
    (IMAGE_BUSY.has(b.image_status ?? "") && !b.image_url && !!b.image_task_id) ||
    (VIDEO_BUSY.has(b.video_status ?? "") && !b.video_url && !!b.video_job_id) ||
    (VOICE_BUSY.has(b.voiceover_status ?? "") && !b.voiceover_url && !!b.voiceover_job_id)
  );
  if (busy) {
    return NextResponse.json(
      { error: `Beat ${busy.beat_number} is generating. Wait or stop the run.` },
      { status: 409 },
    );
  }

  const planBeats = beats.map((b) => ({ beatNumber: b.beat_number, scriptSegment: b.script_segment ?? "" }));

  // "auto": ask Claude which side each stub belongs on. Anything it doesn't
  // answer for falls back to "up", so a failed call still merges sensibly.
  let resolve: MergeDirection | ((n: number) => MergeDirection) = direction === "auto" ? "up" : direction;
  if (direction === "auto") {
    const sides = await decideMergeSides(user.id, planBeats, findStubs(planBeats, minWords));
    resolve = (beatNumber: number) => sides.get(beatNumber) ?? "up";
  }

  const plan = planBulkMerge(planBeats, minWords, resolve);
  if (plan.steps.length === 0) {
    return NextResponse.json({ ok: true, merged: 0, remainingBeats: beats.length });
  }

  const orphans: string[] = [];
  let merged = 0;
  for (const step of plan.steps) {
    const { data: result, error } = await supabase.rpc("merge_project_beats", {
      p_project_id: projectId,
      p_keep: step.keep,
      p_absorb: step.absorb,
      p_segment: step.segment,
    });
    if (error) {
      console.error(`[beats/merge/bulk] project=${projectId} step ${merged + 1}/${plan.steps.length} (keep=${step.keep}) failed:`, error.message);
      return NextResponse.json(
        { error: `Stopped after ${merged} of ${plan.steps.length} merges: ${error.message}`, merged },
        { status: 500 },
      );
    }
    merged++;
    const out = (result ?? {}) as { orphan_image_url?: string | null; orphan_video_url?: string | null; orphan_voiceover_url?: string | null };
    for (const url of [out.orphan_image_url, out.orphan_video_url, out.orphan_voiceover_url]) {
      if (url) orphans.push(url);
    }
  }

  for (const url of orphans) {
    const key = r2KeyFromUrl(url);
    if (!key) continue;
    deleteObject(key).catch((e) =>
      console.warn(`[beats/merge/bulk] failed to delete orphaned ${key}:`, e instanceof Error ? e.message : e));
  }

  console.log(`[beats/merge/bulk] project=${projectId} merged ${merged} beats away; ${plan.finalCount} remain`);

  return NextResponse.json({ ok: true, merged, remainingBeats: plan.finalCount });
}
