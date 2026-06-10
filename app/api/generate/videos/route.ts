import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { deleteObject, r2KeyFromUrl } from "@/lib/supabase/storage";
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

    // Pre-fetch each beat's existing video_url so we can delete the
    // R2 object before nulling the column. Worker uploads new renders
    // to a unique timestamped key, so the prior file is otherwise
    // orphaned. Failures during delete don't block queueing — the
    // orphan costs almost nothing and re-queues are idempotent.
    const beatNumbers = beats.map((b) => b.beatNumber);
    const { data: existing } = await supabase
      .from("project_beats")
      .select("beat_number, video_url")
      .eq("project_id", projectId)
      .in("beat_number", beatNumbers);
    const urlsToDelete = (existing ?? [])
      .map((r) => r.video_url as string | null)
      .filter((u): u is string => !!u);
    if (urlsToDelete.length > 0) {
      await Promise.all(urlsToDelete.map(async (url) => {
        const key = r2KeyFromUrl(url);
        if (!key) return;
        try { await deleteObject(key); }
        catch (e) { console.warn(`[video-submit] R2 delete failed for ${key}:`, e instanceof Error ? e.message : e); }
      }));
      console.log(`[video-submit] project=${projectId} cleaned ${urlsToDelete.length} prior video file(s) from R2 before requeue`);
    }

    // Mark each beat as queued
    let submitted = 0;
    const failures: { beatNumber: number; error: string }[] = [];

    for (const beat of beats) {
      const { error } = await supabase
        .from("project_beats")
        .update({ video_status: "queued", video_url: null, video_job_id: null, video_error: null })
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
