import { NextResponse } from "next/server";
import { pollVideoJob } from "@/lib/kie/videos";
import { uploadFromUrl } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function GET(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");

  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const { data: beats } = await supabase
    .from("project_beats")
    .select("beat_number, video_job_id")
    .eq("project_id", projectId)
    .eq("video_status", "rendering")
    .not("video_job_id", "is", null);

  if (!beats?.length) return NextResponse.json({ pending: 0 });

  await Promise.allSettled(
    beats.map(async (beat) => {
      const raw = beat.video_job_id as string;
      const sep = raw.indexOf("::");
      const modelId = sep >= 0 ? raw.slice(0, sep) : undefined;
      const taskId = sep >= 0 ? raw.slice(sep + 2) : raw;

      const result = await pollVideoJob(taskId, modelId, user.id);

      if (result.status === "done" && result.videoUrl) {
        const storagePath = `${projectId}/videos/beat-${beat.beat_number}.mp4`;
        const publicUrl = await uploadFromUrl(storagePath, result.videoUrl, "video/mp4");
        await supabase.from("project_beats").update({ video_url: publicUrl, video_status: "done" }).eq("project_id", projectId).eq("beat_number", beat.beat_number);
      } else if (result.status === "failed") {
        console.error(`[video-poll] beat ${beat.beat_number} failed:`, result.error);
        await supabase.from("project_beats").update({ video_status: "failed" }).eq("project_id", projectId).eq("beat_number", beat.beat_number);
      }
    })
  );

  return NextResponse.json({ pending: beats.length });
}
