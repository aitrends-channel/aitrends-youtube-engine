import { checkImageTask } from "@/lib/kie/images";
import { uploadFromUrl, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { logProjectCost } from "@/lib/costs";

// Shared "poll one in-flight image task and persist the result" path.
// Used by both the user-driven poll route (foreground) and the cron
// worker (background), so the side effects on the beat row stay
// identical regardless of which caller advances the task.
//
// Returns:
//   { status: "done", url }       — image uploaded and beat row updated
//   { status: "failed", error }   — KIE reported failure; beat marked failed
//   { status: "pending" }         — still in progress; beat row untouched
// Throws KieUpstreamError on transient KIE 429/5xx — callers decide
// whether to retry next tick (cron) or surface to the client (poll).

export interface FinishImageInput {
  projectId: string;
  beatNumber: number;
  taskId: string;
  modelId?: string;
  userId: string;
  userEmail?: string | null;
}

export type FinishImageResult =
  | { status: "done"; url: string }
  | { status: "failed"; error: string }
  | { status: "pending" };

export async function finishImageTask(input: FinishImageInput): Promise<FinishImageResult> {
  const result = await checkImageTask(input.taskId, input.userId, input.modelId);

  // Log the credit consumption as soon as KIE has billed us, even
  // if downstream upload fails — KIE charged regardless and the cost
  // ledger should reflect actual spend.
  if ((result.status === "done" || result.status === "failed") && result.creditsConsumed) {
    void logProjectCost({
      projectId: input.projectId,
      userId: input.userId,
      step: "image_gen",
      provider: "kie",
      model: input.modelId ?? null,
      units: result.creditsConsumed,
      unitKind: "kie_credits",
    });
  }

  if (result.status === "done" && result.url) {
    const folder = userFolderFor({ id: input.userId, email: input.userEmail ?? null });
    const storagePath = `${folder}/${input.projectId}/images/beat-${input.beatNumber}_${Date.now()}.png`;
    const publicUrl = await uploadFromUrl(storagePath, result.url, "image/png");

    // .eq("image_task_id", taskId) is the idempotency guard. Webhook
    // and cron can race on the same task; whichever wins flips the
    // task id to null, and the loser's UPDATE then matches zero rows.
    // The double upload above is a small waste (one extra storage
    // write under race), but the row stays consistent.
    //
    // Previously this used .is("image_url", null) which only worked
    // for first-time generation — on a regenerate click the row
    // already had an image_url from the prior gen, so the UPDATE
    // never matched and the UI kept the stale URL forever even
    // though storage had the new image.
    // .select() lets us see how many rows the UPDATE actually
    // matched. We expect exactly one — anything else means the
    // task_id changed under us (another finisher beat us; benign)
    // or the row vanished (shouldn't happen). Both cases are
    // recoverable but worth surfacing in logs so silent UI-not-
    // updating bugs become obvious instead of mysterious.
    const { data: updated, error: updateErr } = await supabase
      .from("project_beats")
      .update({ image_url: publicUrl, image_status: "done", image_task_id: null, image_model_id: null })
      .eq("project_id", input.projectId)
      .eq("beat_number", input.beatNumber)
      .eq("image_task_id", input.taskId)
      .select("beat_number");
    if (updateErr) {
      console.warn(`[finishImageTask] beat ${input.beatNumber} task=${input.taskId} update error: ${updateErr.message}`);
    } else if (!updated || updated.length === 0) {
      console.warn(`[finishImageTask] beat ${input.beatNumber} task=${input.taskId} update matched 0 rows — another path likely finished first (benign) or task_id race`);
    }

    return { status: "done", url: publicUrl };
  }

  if (result.status === "failed") {
    await supabase.from("project_beats")
      .update({ image_status: "failed", image_task_id: null, image_model_id: null })
      .eq("project_id", input.projectId)
      .eq("beat_number", input.beatNumber)
      .eq("image_task_id", input.taskId);

    return { status: "failed", error: result.error ?? "Image generation failed" };
  }

  return { status: "pending" };
}
