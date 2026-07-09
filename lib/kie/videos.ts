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

// Pull a playable video URL out of a KIE record-info payload, tolerating
// the several shapes different model families use: a direct videoUrl, a
// resultJson blob (JSON with resultUrls/url/videoUrl, or a bare http
// string), or an output array/string. Returns undefined when no usable
// URL is present yet — callers must treat that as "not ready", NOT done.
function extractVideoUrl(d: KieRecordResponse["data"] | undefined): string | undefined {
  if (!d) return undefined;
  if (typeof d.videoUrl === "string" && d.videoUrl.startsWith("http")) return d.videoUrl;
  if (typeof d.resultJson === "string") {
    try {
      const parsed = JSON.parse(d.resultJson) as { resultUrls?: string[]; url?: string; videoUrl?: string };
      const u = parsed.resultUrls?.[0] ?? parsed.url ?? parsed.videoUrl;
      if (typeof u === "string" && u.startsWith("http")) return u;
    } catch {
      if (d.resultJson.startsWith("http")) return d.resultJson;
    }
  }
  if (Array.isArray(d.output) && typeof d.output[0] === "string") return d.output[0];
  if (typeof d.output === "string" && d.output.startsWith("http")) return d.output;
  return undefined;
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
    if (flag === 1) {
      const url = extractVideoUrl(data.data);
      // Veo reports success (flag 1) for the base render, then kicks off a
      // separate upscale pass (e.g. 720p → 1080p) before the final URL is
      // populated. Report "done" ONLY once a URL is actually present;
      // otherwise stay "processing" and keep polling — returning done with
      // no URL is what made the caller fail with "completed but no url".
      if (url) return { status: "done", videoUrl: url };
      return { status: "processing" };
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

  let videoUrl: string | undefined;
  if (status === "done") {
    videoUrl = extractVideoUrl(d);
    // A terminal "done" state with no URL yet (some providers flip state
    // before the asset is written) is treated as still-processing so we
    // keep polling rather than reporting a completion with nothing to show.
    if (!videoUrl) status = "processing";
  }

  return {
    status,
    videoUrl,
    error: status === "failed" ? (d?.failReason ?? d?.error ?? "Video generation failed") : undefined,
  };
}

export { sleep };
