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
    console.log(`[finishImageTask] beat=${input.beatNumber} task=${input.taskId} KIE done, source=${result.url.slice(0, 80)}`);
    const folder = userFolderFor({ id: input.userId, email: input.userEmail ?? null });
    const storagePath = `${folder}/${input.projectId}/images/beat-${input.beatNumber}_${Date.now()}.png`;
    const publicUrl = await uploadFromUrl(storagePath, result.url, "image/png");
    console.log(`[finishImageTask] beat=${input.beatNumber} task=${input.taskId} uploaded to ${publicUrl.slice(0, 80)}`);

    // Two-step update. The previous one-step + .eq("image_task_id",
    // taskId) guard had a real race window: the submit route only
    // writes image_task_id AFTER KIE accepts the submission, so a
    // fast webhook can fire and call us before the row has the new
    // task_id. The guarded UPDATE then matched zero rows and we'd
    // silently leave the old image_url in place — the "regen done on
    // KIE but UI never updates" bug.
    //
    // 1) Always write image_url + image_status by project+beat alone.
    //    Multiple finishers (webhook + poll + cron) running for the
    //    same task all carry the same image content, so the storage
    //    paths differ (Date.now() in the filename) but whichever
    //    UPDATE wins last shows the user a correct image.
    // 2) Clear image_task_id + image_model_id only if we still own
    //    the row's current task. If the user clicked Regenerate
    //    again and a newer task is now in-flight, the row's
    //    image_task_id is the newer one — we leave it alone so the
    //    newer task's lifecycle isn't disturbed.
    const { data: urlData, error: urlErr } = await supabase
      .from("project_beats")
      .update({ image_url: publicUrl, image_status: "done" })
      .eq("project_id", input.projectId)
      .eq("beat_number", input.beatNumber)
      .select("beat_number, image_url");
    if (urlErr) {
      console.warn(`[finishImageTask] beat ${input.beatNumber} task=${input.taskId} url-update error: ${urlErr.message}`);
    } else if (!urlData || urlData.length === 0) {
      console.warn(`[finishImageTask] beat ${input.beatNumber} task=${input.taskId} url-update matched 0 rows — row vanished?`);
    } else {
      console.log(`[finishImageTask] beat ${input.beatNumber} task=${input.taskId} db wrote image_url=${(urlData[0].image_url ?? "").slice(0, 80)}`);
    }

    const { data: clearData } = await supabase
      .from("project_beats")
      .update({ image_task_id: null, image_model_id: null })
      .eq("project_id", input.projectId)
      .eq("beat_number", input.beatNumber)
      .eq("image_task_id", input.taskId)
      .select("beat_number");
    console.log(`[finishImageTask] beat ${input.beatNumber} task=${input.taskId} cleared task_id (matched ${clearData?.length ?? 0} rows — 0 = newer task took over, benign)`);

    return { status: "done", url: publicUrl };
  }

  if (result.status === "failed") {
    // Same two-step pattern. The failed status is independent of
    // task ownership — record it unconditionally — but only clear
    // the in-flight task pointers if we still own them.
    await supabase
      .from("project_beats")
      .update({ image_status: "failed" })
      .eq("project_id", input.projectId)
      .eq("beat_number", input.beatNumber);

    await supabase
      .from("project_beats")
      .update({ image_task_id: null, image_model_id: null })
      .eq("project_id", input.projectId)
      .eq("beat_number", input.beatNumber)
      .eq("image_task_id", input.taskId);

    return { status: "failed", error: result.error ?? "Image generation failed" };
  }

  return { status: "pending" };
}
