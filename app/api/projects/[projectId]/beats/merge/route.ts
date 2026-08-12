export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { dedupeOverlap } from "@/lib/text/dedupeOverlap";
import { joinSegments } from "@/lib/text/joinSegments";
import { deleteObject, r2KeyFromUrl } from "@/lib/supabase/storage";
import type { User } from "@supabase/supabase-js";
import { GENAIPRO_QUEUED_STATUS } from "@/lib/genaipro/client";

// Fold a beat into its neighbour. The script splitter sometimes leaves a
// beat holding one or two words, which doesn't deserve its own image and
// clip; this is the manual fix on the prompts step.
//
// direction "up" merges the beat into the one before it, "down" merges the
// one after it into this beat. Either way the LOWER-numbered beat survives
// and keeps its prompts and media, so the surviving prompt may no longer
// describe the whole segment — the response says so and the UI tells the
// user to reread it.
//
// Everything past the absorbed beat shifts down one; that renumber plus
// the delete run inside merge_project_beats (migration 113) so a failure
// can't leave duplicate or gapped beat_numbers behind.
export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  let body: { beatNumber?: number; direction?: string; segment?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { beatNumber, direction } = body;
  // The dialog sends the text the user actually approved; joinSegments only
  // supplies the default it started from.
  const override = (body.segment ?? "").trim();
  if (typeof beatNumber !== "number" || !Number.isInteger(beatNumber)) {
    return NextResponse.json({ error: "beatNumber (integer) is required" }, { status: 400 });
  }
  if (direction !== "up" && direction !== "down") {
    return NextResponse.json({ error: 'direction must be "up" or "down"' }, { status: 400 });
  }

  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const keep = direction === "up" ? beatNumber - 1 : beatNumber;
  const absorb = keep + 1;
  if (keep < 1) {
    return NextResponse.json({ error: "Beat 1 has nothing above it." }, { status: 400 });
  }

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

  const keepRow = beats.find((b) => b.beat_number === keep);
  const absorbRow = beats.find((b) => b.beat_number === absorb);
  if (!keepRow || !absorbRow) {
    return NextResponse.json(
      { error: direction === "down" ? `Beat ${beatNumber} is the last beat.` : `Beat ${absorb} not found.` },
      { status: 400 },
    );
  }

  // Refuse only for work that could actually land on the wrong row: the
  // completion paths address beats by number (finishImageTask, videos/route,
  // the video webhook), and the renumber only moves beats from `absorb`
  // onward — anything before it keeps its number and is unaffected.
  //
  // In flight = an outstanding upstream job: a task/job id with no asset yet.
  // Status alone is too loose in both directions — the completion paths often
  // write the asset without clearing the status (185 of 195 "generating"
  // beats on staging already had their file), and a run that dies before
  // submitting leaves "generating" with no task id and nothing ever coming
  // back. Either one would block merging forever.
  const IMAGE_BUSY = new Set(["queued", "generating"]);
  const VIDEO_BUSY = new Set([GENAIPRO_QUEUED_STATUS, "queued", "submitting", "rendering"]);
  const VOICE_BUSY = new Set(["queued", "generating"]);
  const busy = beats.find((b) => b.beat_number >= absorb && (
    (IMAGE_BUSY.has(b.image_status ?? "") && !b.image_url && !!b.image_task_id) ||
    (VIDEO_BUSY.has(b.video_status ?? "") && !b.video_url && !!b.video_job_id) ||
    (VOICE_BUSY.has(b.voiceover_status ?? "") && !b.voiceover_url && !!b.voiceover_job_id)
  ));
  if (busy) {
    return NextResponse.json(
      { error: `Beat ${busy.beat_number} is generating. Wait or stop the run.` },
      { status: 409 },
    );
  }

  // Consecutive segments occasionally repeat a few words across the seam;
  // dedupeOverlap strips the repeat so the merged narration reads once.
  const keepText = (keepRow.script_segment ?? "").trim();
  const absorbText = (absorbRow.script_segment ?? "").trim();
  const tail = dedupeOverlap(absorbText, keepText);
  const merged = override || joinSegments(keepText, tail);

  const { data: result, error: rpcErr } = await supabase.rpc("merge_project_beats", {
    p_project_id: projectId,
    p_keep: keep,
    p_absorb: absorb,
    p_segment: merged,
  });
  if (rpcErr) {
    console.error(`[beats/merge] project=${projectId} keep=${keep} absorb=${absorb} failed:`, rpcErr.message);
    return NextResponse.json({ error: `Merge failed: ${rpcErr.message}` }, { status: 500 });
  }

  const out = (result ?? {}) as {
    kept_beat_number?: number;
    remaining_beats?: number;
    orphan_image_url?: string | null;
    orphan_video_url?: string | null;
    orphan_voiceover_url?: string | null;
  };

  // Best-effort cleanup of the absorbed beat's media, after the merge is
  // committed. A missed delete just orphans a file; a delete before the
  // commit could lose media the merge didn't actually free.
  for (const url of [out.orphan_image_url, out.orphan_video_url, out.orphan_voiceover_url]) {
    if (!url) continue;
    const key = r2KeyFromUrl(url);
    if (!key) continue;
    deleteObject(key).catch((e) =>
      console.warn(`[beats/merge] failed to delete orphaned ${key}:`, e instanceof Error ? e.message : e));
  }

  console.log(`[beats/merge] project=${projectId} merged ${absorb} into ${keep}; ${out.remaining_beats} beats remain`);

  return NextResponse.json({
    ok: true,
    keptBeatNumber: out.kept_beat_number ?? keep,
    remainingBeats: out.remaining_beats ?? null,
    scriptSegment: merged,
    // The surviving prompts describe only the survivor's original half.
    promptsMayNeedReview: true,
  });
}
