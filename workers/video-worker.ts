import "dotenv/config";
import { Worker } from "bullmq";
import { getQueueConnection } from "../lib/queue/client";
import { submitVideoJob, pollVideoJob } from "../lib/kie/videos";
import { uploadFromUrl } from "../lib/supabase/storage";
import { supabase } from "../lib/supabase/client";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const worker = new Worker(
  "video-generation",
  async (job) => {
    const { projectId, beatNumber, videoPrompt, imageUrl, modelId, duration, aspectRatio } = job.data as {
      projectId: string;
      beatNumber: number;
      videoPrompt: string;
      imageUrl?: string;
      modelId: string;
      duration?: string | number;
      aspectRatio?: string;
    };

    await supabase
      .from("project_beats")
      .update({ video_status: "rendering" })
      .eq("project_id", projectId)
      .eq("beat_number", beatNumber);

    // Submit to kie.ai video generation
    const jobId = await submitVideoJob(videoPrompt, modelId, imageUrl, duration, aspectRatio);

    // Poll until complete
    let videoUrl: string | undefined;
    let attempts = 0;
    const maxAttempts = 60; // 10 minutes at 10s intervals

    while (!videoUrl && attempts < maxAttempts) {
      await sleep(10000);
      attempts++;

      const status = await pollVideoJob(jobId, modelId);

      if (status.status === "done" && status.videoUrl) {
        videoUrl = status.videoUrl;
      } else if (status.status === "failed") {
        throw new Error(`kie.ai video job failed: ${status.error}`);
      }

      await job.updateProgress(Math.min(Math.round((attempts / maxAttempts) * 100), 99));
    }

    if (!videoUrl) {
      throw new Error("Video generation timed out after 10 minutes");
    }

    // Upload to Supabase Storage
    const storagePath = `${projectId}/videos/beat-${beatNumber}.mp4`;
    const publicUrl = await uploadFromUrl(storagePath, videoUrl, "video/mp4");

    // Update DB
    await supabase
      .from("project_beats")
      .update({ video_url: publicUrl, video_status: "done" })
      .eq("project_id", projectId)
      .eq("beat_number", beatNumber);

    // Update project progress
    const { data: doneBeat } = await supabase
      .from("project_beats")
      .select("beat_number")
      .eq("project_id", projectId)
      .eq("video_status", "done");

    await supabase
      .from("projects")
      .update({ videos_progress: doneBeat?.length ?? 0 })
      .eq("id", projectId);

    return { url: publicUrl, beatNumber };
  },
  {
    connection: getQueueConnection(),
    concurrency: 3,
  }
);

worker.on("failed", async (job, err) => {
  if (!job) return;
  const { projectId, beatNumber } = job.data;
  await supabase
    .from("project_beats")
    .update({ video_status: "failed" })
    .eq("project_id", projectId)
    .eq("beat_number", beatNumber);
  console.error(`Job ${job.id} failed:`, err.message);
});

worker.on("ready", () => {
  console.log("Video worker ready — concurrency: 3");
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
