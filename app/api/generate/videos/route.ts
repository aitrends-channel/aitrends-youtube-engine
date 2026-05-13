import { NextResponse } from "next/server";
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

    const redisHost = process.env.UPSTASH_REDIS_HOST;
    if (!redisHost || redisHost === "localhost") {
      console.error("[video-submit] Redis env vars not configured");
      return NextResponse.json({ error: "Redis not configured — set UPSTASH_REDIS_HOST, UPSTASH_REDIS_PASSWORD, UPSTASH_REDIS_TLS in Vercel environment variables" }, { status: 500 });
    }

    console.log(`[video-submit] Connecting to Redis: ${redisHost}`);
    const { getVideoQueue } = await import("@/lib/queue/client");
    const queue = await getVideoQueue();
    console.log(`[video-submit] Queue ready, submitting ${beats.length} jobs`);
    let submitted = 0;
    const failures: { beatNumber: number; error: string }[] = [];

    for (const beat of beats) {
      try {
        await supabase
          .from("project_beats")
          .update({ video_status: "queued", video_url: null, video_job_id: null })
          .eq("project_id", projectId)
          .eq("beat_number", beat.beatNumber);

        await queue.add("generate-video", {
          projectId,
          beatNumber: beat.beatNumber,
          videoPrompt: beat.videoPrompt,
          imageUrl: beat.imageUrl,
          modelId,
          duration,
          aspectRatio,
          userId: user.id,
        });

        submitted++;
      } catch (err) {
        const error = err instanceof Error ? err.message : "Failed to queue";
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
