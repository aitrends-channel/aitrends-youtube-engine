import { kieRequest } from "./client";
import type { KieModel } from "@/lib/types";
import { VIDEO_MODELS, VIDEO_MODEL_CONFIGS, getVideoModelConfig } from "./videoModels";

export type { DurationOption, VideoModelConfig } from "./videoModels";
export { VIDEO_MODELS, VIDEO_MODEL_CONFIGS, getVideoModelConfig } from "./videoModels";

interface KieTaskResponse {
  code: number;
  msg: string;
  data: { taskId: string };
}

interface KieRecordResponse {
  code: number;
  data: {
    state?: string;
    status?: string;
    resultJson?: string;
    output?: string | string[];
    failReason?: string;
    error?: string;
    // Runway-specific
    videoInfo?: { videoUrl?: string };
    // Veo-specific
    successFlag?: number;
    videoUrl?: string;
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function listVideoModels(): Promise<KieModel[]> {
  return VIDEO_MODELS;
}

export async function submitVideoJob(
  prompt: string,
  modelId: string,
  imageUrl?: string,
  duration?: string | number,
  aspectRatio = "16:9",
  userId?: string
): Promise<string> {
  const config = getVideoModelConfig(modelId);

  // ── Veo ───────────────────────────────────────────────────────────
  if (modelId === "veo3" || modelId === "veo3_fast") {
    const body: Record<string, unknown> = { prompt };
    if (!imageUrl) body.aspect_ratio = aspectRatio;
    if (imageUrl) body.imageUrls = [imageUrl];
    const res = await kieRequest<KieTaskResponse>("/api/v1/veo/generate", {
      method: "POST",
      body: JSON.stringify(body),
    }, userId);
    if (res.code !== 200) throw new Error(res.msg ?? "Failed to submit Veo job");
    return res.data.taskId;
  }

  // ── Runway ────────────────────────────────────────────────────────
  if (modelId === "runway") {
    const body: Record<string, unknown> = { prompt };
    if (!imageUrl) body.aspectRatio = aspectRatio;
    if (duration) body.duration = duration;
    if (imageUrl) body.imageUrl = imageUrl;
    const res = await kieRequest<KieTaskResponse>("/api/v1/runway/generate", {
      method: "POST",
      body: JSON.stringify(body),
    }, userId);
    if (res.code !== 200) throw new Error(res.msg ?? "Failed to submit Runway job");
    return res.data.taskId;
  }

  // ── Generic createTask models ──────────────────────────────────────
  const input: Record<string, unknown> = { prompt };
  if (!imageUrl) input.aspect_ratio = aspectRatio;
  if (duration !== undefined) {
    const key = config.durationKey ?? "duration";
    input[key] = duration;
  }
  if (imageUrl) {
    if (modelId === "grok-imagine/image-to-video") {
      input.image_urls = [imageUrl];
    } else if (modelId === "wan/2-7-image-to-video") {
      input.first_frame_url = imageUrl;
    } else if (modelId === "sora-2-image-to-video") {
      input.image_urls = [imageUrl];
    } else {
      input.image_url = imageUrl;
    }
  }

  const res = await kieRequest<KieTaskResponse>("/api/v1/jobs/createTask", {
    method: "POST",
    body: JSON.stringify({ model: modelId, input }),
  }, userId);
  if (res.code !== 200) throw new Error(res.msg ?? "Failed to submit video job");
  return res.data.taskId;
}

export async function pollVideoJob(taskId: string, modelId?: string, userId?: string): Promise<{
  status: "pending" | "processing" | "done" | "failed";
  videoUrl?: string;
  error?: string;
}> {
  // ── Veo uses its own status endpoint ─────────────────────────────
  if (modelId === "veo3" || modelId === "veo3_fast") {
    const data = await kieRequest<KieRecordResponse>(
      `/api/v1/veo/record-info?taskId=${taskId}`,
      {},
      userId
    );
    const flag = data.data?.successFlag;
    if (flag === 1 || flag === 2 || flag === 3) {
      // Cost recon — see comment in pollVideoJob's generic branch.
      console.log(`[kie-cost-recon] video-veo model=${modelId} flag=${flag} response=`, JSON.stringify(data));
    }
    if (flag === 1) {
      const url = data.data?.videoUrl ?? data.data?.resultJson;
      return { status: "done", videoUrl: typeof url === "string" ? url : undefined };
    }
    if (flag === 2 || flag === 3) return { status: "failed", error: "Veo generation failed" };
    return { status: "processing" };
  }

  // ── Runway uses its own status endpoint ───────────────────────────
  if (modelId === "runway") {
    const data = await kieRequest<KieRecordResponse>(
      `/api/v1/runway/record-detail?taskId=${taskId}`,
      {},
      userId
    );
    const d = data.data;
    const raw = (d?.state ?? "").toLowerCase();
    if (raw === "success" || raw === "fail") {
      console.log(`[kie-cost-recon] video-runway model=${modelId} state=${raw} response=`, JSON.stringify(data));
    }
    if (raw === "success") {
      return { status: "done", videoUrl: d?.videoInfo?.videoUrl };
    }
    if (raw === "fail") return { status: "failed", error: d?.failReason ?? "Runway job failed" };
    if (raw === "generating") return { status: "processing" };
    return { status: "pending" };
  }

  // ── Generic recordInfo ────────────────────────────────────────────
  const data = await kieRequest<KieRecordResponse>(
    `/api/v1/jobs/recordInfo?taskId=${taskId}`,
    {},
    userId
  );
  const d = data.data;
  const raw = (d?.state ?? d?.status ?? "").toLowerCase();

  const DONE = ["succeed", "success", "completed", "done", "finish", "finished", "complete"];
  const FAIL = ["failed", "error", "fail"];
  const PROCESSING = ["generating", "running", "processing", "active"];

  let status: "pending" | "processing" | "done" | "failed" = "pending";
  if (DONE.includes(raw)) status = "done";
  else if (FAIL.includes(raw)) status = "failed";
  else if (PROCESSING.includes(raw)) status = "processing";

  if (status === "done" || status === "failed") {
    // Reconnaissance log for cost tracking — dumps the full KIE
    // recordInfo payload at terminal state so we can identify which
    // field carries credits consumed (the static-catalog approach
    // was rejected in favor of reading credits directly from the
    // response). Fires once per task, never on pending. Remove
    // once lib/pricing.ts knows the credit field.
    console.log(`[kie-cost-recon] video-generic model=${modelId} verdict=${status} response=`, JSON.stringify(data));
  }

  let videoUrl: string | undefined;
  if (status === "done") {
    if (typeof d?.resultJson === "string") {
      try {
        const parsed = JSON.parse(d.resultJson) as { resultUrls?: string[]; url?: string };
        videoUrl = parsed.resultUrls?.[0] ?? parsed.url;
      } catch {
        if (d.resultJson.startsWith("http")) videoUrl = d.resultJson;
      }
    }
    if (!videoUrl && Array.isArray(d?.output)) videoUrl = d.output[0];
    if (!videoUrl && typeof d?.output === "string") videoUrl = d.output;
  }

  return {
    status,
    videoUrl,
    error: status === "failed" ? (d?.failReason ?? d?.error ?? "Video generation failed") : undefined,
  };
}

export { sleep };
