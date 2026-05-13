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

    // Mark each beat as queued
    let submitted = 0;
    const failures: { beatNumber: number; error: string }[] = [];

    for (const beat of beats) {
      const { error } = await supabase
        .from("project_beats")
        .update({ video_status: "queued", video_url: null, video_job_id: null })
        .eq("project_id", projectId)
        .eq("beat_number", beat.beatNumber);

      if (error) {
        failures.push({ beatNumber: beat.beatNumber, error: error.message });
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
