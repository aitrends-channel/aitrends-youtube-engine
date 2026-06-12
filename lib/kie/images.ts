import { kieRequest } from "./client";
import type { KieModel } from "@/lib/types";
import {
  IMAGE_MODELS, MODEL_CONFIGS, IMAGE_SIZE_MAP, IMAGE_SIZE_MODELS,
} from "./imageModels";

export type { ModelConfig } from "./imageModels";
export { IMAGE_MODELS, MODEL_CONFIGS, getModelConfig } from "./imageModels";

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
    output?: string | { url?: string; image_url?: string };
    failReason?: string;
    failMsg?: string;
    failCode?: string;
    error?: string;
    // flux-kontext shape
    successFlag?: number;
    response?: { resultImageUrl?: string; originImageUrl?: string } | null;
    errorMessage?: string | null;
    errorCode?: string | number | null;
  };
}

// Normalize KIE's two response shapes into a single decision.
//   • jobs/recordInfo uses `state`/`status` strings.
//   • flux/kontext/record-info uses `successFlag` (0=pending, 1=success,
//     others=fail) plus `response.resultImageUrl` and `errorMessage`.
function classifyImageRecord(d: KieRecordResponse["data"]):
  | { kind: "done"; url: string }
  | { kind: "failed"; error: string }
  | { kind: "pending" } {
  const DONE = ["succeed", "success", "completed", "done", "finish", "finished", "complete"];
  const FAIL = ["failed", "error", "fail"];

  // flux-kontext path — recognized by presence of successFlag.
  if (typeof d.successFlag === "number") {
    if (d.successFlag === 1) {
      const url = d.response?.resultImageUrl;
      if (!url) return { kind: "failed", error: "Image task completed but no URL in response" };
      return { kind: "done", url };
    }
    if (d.successFlag === 0) return { kind: "pending" };
    return { kind: "failed", error: d.errorMessage ?? `flux error code ${d.errorCode ?? d.successFlag}` };
  }

  // jobs/recordInfo path — string state/status.
  const normalized = (d.state ?? d.status ?? "").toLowerCase();
  if (DONE.includes(normalized)) {
    let url: string | undefined;
    if (typeof d.resultJson === "string") {
      if (d.resultJson.startsWith("http")) {
        url = d.resultJson;
      } else {
        try {
          const parsed = JSON.parse(d.resultJson) as { url?: string; resultUrls?: string[] };
          url = parsed.url ?? parsed.resultUrls?.[0];
        } catch { /* fall through */ }
      }
    }
    if (!url && typeof d.output === "string") url = d.output;
    if (!url && d.output && typeof d.output === "object") url = d.output.url ?? d.output.image_url;
    if (!url) return { kind: "failed", error: "Image task completed but no URL in response" };
    return { kind: "done", url };
  }
  if (FAIL.includes(normalized)) {
    const detail = d.failMsg ?? d.failReason ?? d.error ?? `fail code ${d.failCode ?? "unknown"}`;
    return { kind: "failed", error: detail };
  }
  return { kind: "pending" };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function listImageModels(): Promise<KieModel[]> {
  return IMAGE_MODELS;
}

export async function submitImageTask(
  prompt: string,
  modelId: string,
  aspectRatio = "16:9",
  resolution?: string,
  userId?: string,
  callBackUrl?: string
): Promise<string> {
  if (modelId.startsWith("flux-kontext")) {
    const body: Record<string, unknown> = { prompt, model: modelId, aspectRatio, outputFormat: "jpeg" };
    if (callBackUrl) body.callBackUrl = callBackUrl;
    const res = await kieRequest<KieTaskResponse>("/api/v1/flux/kontext/generate", {
      method: "POST",
      body: JSON.stringify(body),
    }, userId);
    if (res.code !== 200) throw new Error(`KIE ${res.code}: ${res.msg ?? "Failed to create image task"}`);
    if (!res.data?.taskId) throw new Error("No task ID returned from image API");
    return res.data.taskId;
  } else if (IMAGE_SIZE_MODELS.has(modelId)) {
    const image_size = IMAGE_SIZE_MAP[aspectRatio] ?? "landscape_16_9";
    const input: Record<string, unknown> = { prompt, image_size };
    if (modelId === "bytedance/seedream-v4-text-to-image" && resolution) {
      input.image_resolution = resolution;
    }
    const body: Record<string, unknown> = { model: modelId, input };
    if (callBackUrl) body.callBackUrl = callBackUrl;
    const res = await kieRequest<KieTaskResponse>("/api/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify(body),
    }, userId);
    if (res.code !== 200) throw new Error(`KIE ${res.code}: ${res.msg ?? "Failed to create image task"}`);
    if (!res.data?.taskId) throw new Error("No task ID returned from image API");
    return res.data.taskId;
  } else {
    const input: Record<string, unknown> = { prompt, aspect_ratio: aspectRatio };
    if (resolution) input.resolution = resolution;
    const body: Record<string, unknown> = { model: modelId, input };
    if (callBackUrl) body.callBackUrl = callBackUrl;
    const res = await kieRequest<KieTaskResponse>("/api/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify(body),
    }, userId);
    if (res.code !== 200) throw new Error(`KIE ${res.code}: ${res.msg ?? "Failed to create image task"}`);
    if (!res.data?.taskId) throw new Error("No task ID returned from image API");
    return res.data.taskId;
  }
}

export async function checkImageTask(
  taskId: string,
  userId?: string,
  modelId?: string
): Promise<{ status: "pending" | "done" | "failed"; url?: string; error?: string }> {
  const pollEndpoint = modelId?.startsWith("flux-kontext")
    ? `/api/v1/flux/kontext/record-info?taskId=${taskId}`
    : `/api/v1/jobs/recordInfo?taskId=${taskId}`;

  const statusRes = await kieRequest<KieRecordResponse>(pollEndpoint, {}, userId);

  if (!statusRes.data) {
    console.log(`[images] no data from poll — raw=${JSON.stringify(statusRes).slice(0, 300)}`);
    return { status: "pending" };
  }

  const verdict = classifyImageRecord(statusRes.data);
  if (verdict.kind === "done") return { status: "done", url: verdict.url };
  if (verdict.kind === "failed") {
    console.error(`[images] task failed: ${verdict.error}`);
    return { status: "failed", error: verdict.error };
  }
  console.log(`[images] poll pending raw=${JSON.stringify(statusRes.data).slice(0, 300)}`);
  return { status: "pending" };
}

export async function generateImage(
  prompt: string,
  modelId: string,
  aspectRatio = "16:9",
  resolution?: string,
  userId?: string
): Promise<string> {
  let taskId: string;

  if (modelId.startsWith("flux-kontext")) {
    const res = await kieRequest<KieTaskResponse>("/api/v1/flux/kontext/generate", {
      method: "POST",
      body: JSON.stringify({ prompt, model: modelId, aspectRatio, outputFormat: "jpeg" }),
    }, userId);
    if (res.code !== 200) throw new Error(`KIE ${res.code}: ${res.msg ?? "Failed to create image task"}`);
    if (!res.data?.taskId) throw new Error("No task ID returned from image API");
    taskId = res.data.taskId;
  } else if (IMAGE_SIZE_MODELS.has(modelId)) {
    const image_size = IMAGE_SIZE_MAP[aspectRatio] ?? "landscape_16_9";
    const input: Record<string, unknown> = { prompt, image_size };
    if (modelId === "bytedance/seedream-v4-text-to-image" && resolution) {
      input.image_resolution = resolution;
    }
    const res = await kieRequest<KieTaskResponse>("/api/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify({ model: modelId, input }),
    }, userId);
    if (res.code !== 200) throw new Error(`KIE ${res.code}: ${res.msg ?? "Failed to create image task"}`);
    if (!res.data?.taskId) throw new Error("No task ID returned from image API");
    taskId = res.data.taskId;
  } else {
    const input: Record<string, unknown> = { prompt, aspect_ratio: aspectRatio };
    if (resolution) input.resolution = resolution;
    const res = await kieRequest<KieTaskResponse>("/api/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify({ model: modelId, input }),
    }, userId);
    if (res.code !== 200) throw new Error(`KIE ${res.code}: ${res.msg ?? "Failed to create image task"}`);
    if (!res.data?.taskId) throw new Error("No task ID returned from image API");
    taskId = res.data.taskId;
  }

  const pollEndpoint = modelId.startsWith("flux-kontext")
    ? `/api/v1/flux/kontext/record-info?taskId=${taskId}`
    : `/api/v1/jobs/recordInfo?taskId=${taskId}`;

  // 80 × 3s = 4 min per task. Kie image gen typically lands in
  // 30–90s; outliers run 2–3 min under load. The previous 15 × 3s = 45s
  // budget was tripping false failures for routine slow generations and
  // orphaning the upstream task (Kie kept working, but the result had
  // nowhere to land since thumbnails don't have a webhook/cron sweeper
  // like beats do). 4 min covers the long tail without pushing the
  // route past its 800s maxDuration: callers batch thumbnails in
  // groups of 2, so worst-case wall time for N thumbnails is
  // ceil(N/2) × 4 min — fine up to ~6 thumbnails per request.
  for (let i = 0; i < 80; i++) {
    await sleep(3000);

    const statusRes = await kieRequest<KieRecordResponse>(pollEndpoint, {}, userId);
    if (!statusRes.data) continue;

    const verdict = classifyImageRecord(statusRes.data);
    if (verdict.kind === "done") return verdict.url;
    if (verdict.kind === "failed") throw new Error(verdict.error);
  }

  throw new Error("Image generation timed out after 4 minutes");
}
