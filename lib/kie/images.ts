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
    error?: string;
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function listImageModels(): Promise<KieModel[]> {
  return IMAGE_MODELS;
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
    if (res.code !== 200) throw new Error(res.msg ?? "Failed to create image task");
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
    if (res.code !== 200) throw new Error(res.msg ?? "Failed to create image task");
    if (!res.data?.taskId) throw new Error("No task ID returned from image API");
    taskId = res.data.taskId;
  } else {
    const input: Record<string, unknown> = { prompt, aspect_ratio: aspectRatio };
    if (resolution) input.resolution = resolution;
    const res = await kieRequest<KieTaskResponse>("/api/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify({ model: modelId, input }),
    }, userId);
    if (res.code !== 200) throw new Error(res.msg ?? "Failed to create image task");
    if (!res.data?.taskId) throw new Error("No task ID returned from image API");
    taskId = res.data.taskId;
  }

  const DONE = ["succeed", "success", "completed", "done", "finish", "finished", "complete"];
  const FAIL = ["failed", "error", "fail"];

  for (let i = 0; i < 15; i++) {
    await sleep(3000);

    const statusRes = await kieRequest<KieRecordResponse>(
      `/api/v1/jobs/recordInfo?taskId=${taskId}`,
      {},
      userId
    );
    if (!statusRes.data) continue;
    const d = statusRes.data;
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
      if (!url) throw new Error("Image task completed but no URL in response");
      return url;
    }

    if (FAIL.includes(normalized)) {
      throw new Error(d.failReason ?? d.error ?? "Image generation failed");
    }
  }

  throw new Error("Image generation timed out after 5 minutes");
}
