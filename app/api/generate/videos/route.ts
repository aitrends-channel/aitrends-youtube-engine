import { NextResponse } from "next/server";
import { submitVideoJob } from "@/lib/kie/videos";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 60;

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

    let submitted = 0;
    const failures: { beatNumber: number; error: string }[] = [];

    for (const beat of beats) {
      try {
        await supabase.from("project_beats").update({ video_status: "rendering", video_url: null, video_job_id: null }).eq("project_id", projectId).eq("beat_number", beat.beatNumber);

        const taskId = await submitVideoJob(beat.videoPrompt, modelId, beat.imageUrl, duration, aspectRatio, user.id);

        await supabase.from("project_beats").update({ video_job_id: `${modelId}::${taskId}` }).eq("project_id", projectId).eq("beat_number", beat.beatNumber);

        submitted++;
      } catch (err) {
        const error = err instanceof Error ? err.message : "Failed to submit";
        console.error(`[video-submit] beat ${beat.beatNumber} failed:`, error);
        failures.push({ beatNumber: beat.beatNumber, error });
        await supabase.from("project_beats").update({ video_status: "failed" }).eq("project_id", projectId).eq("beat_number", beat.beatNumber);
      }
    }

    return NextResponse.json({ submitted, failures, total: beats.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to submit video jobs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
