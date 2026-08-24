import { poyoRequest, poyoEnvelopeError, type PoyoEnvelope } from "./client";
import { poyoImageInput, poyoPromptMax } from "./imageModels";
import { capPrompt } from "@/lib/kie/promptLength";

// Image submit and poll against PoYo. Deliberately the same shape as
// lib/kie/images.ts (submit returns a task id, check returns done/failed/
// pending) so lib/operators/image.ts can hold both behind one interface
// without either provider's quirks leaking into it.

interface PoyoSubmitData {
  task_id: string;
  status?: string;
  created_time?: string;
}

interface PoyoStatusData {
  task_id?: string;
  status?: string;
  progress?: number;
  files?: Array<{ file_url?: string; file_type?: string }>;
  error_message?: string | null;
  created_time?: string;
  /** Credits the task actually consumed. Undocumented, found on a live task:
   *  a finished z-image read back credits_amount 2.0, matching the catalog. */
  credits_amount?: number;
}

export async function submitPoyoImageTask(
  prompt: string,
  modelId: string,
  aspectRatio = "16:9",
  resolution?: string | null,
  callbackUrl?: string,
): Promise<string> {
  // PoYo rejects a size it does not know rather than falling back, and the
  // accepted set is per model: the GPT models take no 16:9 at all, wan-2.7
  // takes pixel dimensions only, and only some models have a resolution field
  // at all. poyoImageInput is where that per-model shape lives.
  // Trimmed to what the model takes, at a word boundary, rather than sent and
  // rejected. z-image's 1,000 characters is shorter than a beat prompt, so
  // every image in a run failed on it and none of them reached generation.
  const max = poyoPromptMax(modelId);
  const sent = max ? capPrompt(prompt, max) : prompt;
  if (sent.length < prompt.length) {
    console.log(`[poyo/images] prompt trimmed for ${modelId}: ${prompt.length} to ${sent.length} chars`);
  }

  const body: Record<string, unknown> = {
    model: modelId,
    input: { prompt: sent, ...poyoImageInput(modelId, aspectRatio, resolution) },
  };
  if (callbackUrl) body.callback_url = callbackUrl;

  const res = await poyoRequest<PoyoEnvelope<PoyoSubmitData>>("/api/generate/submit", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (res.code !== 200) throw poyoEnvelopeError(res, "Failed to create image task");
  const taskId = res.data?.task_id;
  if (!taskId) throw new Error("No task ID returned from PoYo submit");
  return taskId;
}

const DONE = ["finished", "succeed", "success", "completed"];
const FAIL = ["failed", "error", "cancelled", "canceled"];

/**
 * One status read.
 *
 * Reports what the task actually cost, via credits_amount. That field is not in
 * PoYo's docs and this code originally assumed it did not exist, pricing from
 * the catalog instead; a live finished task showed otherwise. Reported beats
 * estimated for the same reason it does on KIE: the catalog is a copy of a
 * price list and goes stale the moment PoYo reprices, silently.
 *
 * The catalog price stays as the fallback, which is what the reserve step needs
 * anyway since it runs before there is a task to ask about.
 */
export async function checkPoyoImageTask(taskId: string): Promise<{
  status: "pending" | "done" | "failed";
  url?: string;
  error?: string;
  units?: number;
}> {
  const res = await poyoRequest<PoyoEnvelope<PoyoStatusData>>(
    `/api/generate/status/${encodeURIComponent(taskId)}`,
  );

  if (res.code !== 200) throw poyoEnvelopeError(res, "Failed to read task status");
  const d = res.data;
  if (!d) return { status: "pending" };

  const state = (d.status ?? "").toLowerCase();

  if (DONE.includes(state)) {
    const url = d.files?.find((f) => f.file_url)?.file_url;
    // Finished with no file is a provider fault, not a pending task. Reporting
    // it as pending would leave the beat spinning and its reservation held
    // until something else timed out.
    const units = typeof d.credits_amount === "number" ? d.credits_amount : undefined;
    if (!url) return { status: "failed", error: "PoYo reported the task finished but returned no file", units };
    return { status: "done", url, units };
  }

  if (FAIL.includes(state)) {
    // Credits on a failure too when PoYo reports them. It says failed tasks are
    // not charged, so this is normally absent or zero, but recording what it
    // actually says beats assuming.
    return {
      status: "failed",
      error: d.error_message || `PoYo task ${state}`,
      units: typeof d.credits_amount === "number" ? d.credits_amount : undefined,
    };
  }

  return { status: "pending" };
}
