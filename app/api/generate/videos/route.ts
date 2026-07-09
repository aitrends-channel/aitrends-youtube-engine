import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 30;

interface Beat {
  beatNumber: number;
  videoPrompt: string;
  imageUrl?: string;
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { projectId, beats, modelId, duration, aspectRatio = "16:9", resolution } = await req.json() as {
      projectId: string; beats: Beat[]; modelId: string; duration?: string | number; aspectRatio?: string; resolution?: string;
    };

    if (!projectId || !beats?.length || !modelId) {
      return NextResponse.json({ error: "projectId, beats, and modelId are required" }, { status: 400 });
    }

    // Store job config on the project so the worker can read it.
    // video_resolution is always written — NULL when the client omitted
    // resolution (either the picker chose null for a no-resolution
    // model, or the field was left untouched). Previously we skipped
    // the key when resolution was falsy, which meant a submit against
    // a no-resolution model kept the previous submit's video_resolution
    // in the DB and the worker forwarded that stale value as an extra
    // KIE input the new model didn't accept.
    await supabase.from("projects").update({
      video_model_id: modelId,
      video_duration: duration ?? null,
      video_aspect_ratio: aspectRatio,
      video_resolution: resolution ?? null,
    }).eq("id", projectId).eq("user_id", user.id);

    // Mark each beat as queued. We deliberately do NOT null
    // video_url here — keeping the previous URL means the UI
    // continues to show the old clip while the new one renders,
    // and if the new render fails the user doesn't lose what they
    // had. The worker reads the existing video_url before its
    // upload and best-effort deletes the old R2 object only after
    // the new URL has been written successfully (see worker
    // processBeat).
    let submitted = 0;
    const failures: { beatNumber: number; error: string }[] = [];

    // Unconditional re-queue. The previous in-flight guard
    // (`.not("video_status", "in", ...)`) created false-positive
    // "Beat is already in flight" errors when the UI showed an
    // actionable icon (Retry / Generate) but the DB row had
    // transiently moved into "submitting" / "rendering" — usually
    // because the worker's startup re-queue or a prior sweep had
    // changed state faster than SWR's refresh interval could
    // observe. The user's intent in clicking is unambiguous: retry
    // this beat. Honoring that intent matters more than preventing
    // the rare double-KIE-call race, because the worker's commit
    // guard (worker.processBeat:209) already discards orphan
    // uploads from a stale in-flight job (it requires status in
    // ["submitting", "rendering"] to commit, and the new claim
    // gives the next worker tick a fresh job_id). Worst case is
    // one extra KIE billing for the abandoned poll — acceptable
    // for an explicit user retry.
    for (const beat of beats) {
      const { data, error } = await supabase
        .from("project_beats")
        .update({
          video_status: "queued",
          video_job_id: null,
          video_error: null,
          // Snapshot the config on the beat itself so a later settings
          // change on the project row can't rewrite an already-queued
          // beat. Worker reads beat-level values first and only falls
          // back to projects.* when these are NULL (legacy rows). All
          // four write unconditionally — a NULL from the client (e.g.
          // no-resolution model) is the correct value to persist.
          video_model_id: modelId,
          video_aspect_ratio: aspectRatio,
          video_duration: duration != null ? String(duration) : null,
          video_resolution: resolution ?? null,
          // Persist the prompt from the payload — the worker generates
          // from the DB row, so without this an edited prompt (preview
          // dialog's Save & regenerate) was silently ignored. Normal
          // regens pass the unchanged current prompt, so this is a
          // value no-op for them.
          ...(beat.videoPrompt?.trim() ? { video_prompt: beat.videoPrompt.trim() } : {}),
        })
        .eq("project_id", projectId)
        .eq("beat_number", beat.beatNumber)
        .select("beat_number");

      if (error) {
        failures.push({ beatNumber: beat.beatNumber, error: error.message });
      } else if (!data || data.length === 0) {
        failures.push({
          beatNumber: beat.beatNumber,
          error: `Beat ${beat.beatNumber} not found.`,
        });
      } else {
        submitted++;
      }
    }

    return NextResponse.json({ submitted, failures, total: beats.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to submit video jobs";
    console.error("[video-submit]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
