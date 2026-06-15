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
    const { projectId, beats, modelId, duration, aspectRatio = "16:9" } = await req.json() as {
      projectId: string; beats: Beat[]; modelId: string; duration?: string | number; aspectRatio?: string;
    };

    if (!projectId || !beats?.length || !modelId) {
      return NextResponse.json({ error: "projectId, beats, and modelId are required" }, { status: 400 });
    }

    // Store job config on the project so the worker can read it
    await supabase.from("projects").update({
      video_model_id: modelId,
      video_duration: duration ?? null,
      video_aspect_ratio: aspectRatio,
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

    // Conditional update — only flip the row to "queued" if it's
    // NOT currently in-flight. Without the .not("video_status", "in",
    // ...) guard, a user clicking Regen while the worker is still
    // processing this beat would reset status to queued mid-render,
    // and the next worker tick would re-claim the same beat → two
    // KIE calls + two job IDs for one user action (the "double-
    // submit" case we saw in worker logs). The conditional update
    // returns 0 rows in that case, which we surface as a failure
    // so the UI can tell the user "this beat is already rendering."
    for (const beat of beats) {
      const { data, error } = await supabase
        .from("project_beats")
        .update({ video_status: "queued", video_job_id: null, video_error: null })
        .eq("project_id", projectId)
        .eq("beat_number", beat.beatNumber)
        .not("video_status", "in", "(queued,submitting,rendering)")
        .select("beat_number");

      if (error) {
        failures.push({ beatNumber: beat.beatNumber, error: error.message });
      } else if (!data || data.length === 0) {
        failures.push({
          beatNumber: beat.beatNumber,
          error: "Beat is already in flight — wait for the current render to finish.",
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
