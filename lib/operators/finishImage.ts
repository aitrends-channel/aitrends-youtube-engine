import { getImageOperator } from "./image";
import { uploadFromUrl, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { logProjectCost } from "@/lib/costs";
import { findOpenHold, releaseHold } from "@/lib/credits/hold";

// Shared "poll one in-flight image task and persist the result" path.
// Used by both the user-driven poll route (foreground) and the cron
// worker (background), so the side effects on the beat row stay
// identical regardless of which caller advances the task.
//
// Operator-agnostic, which is why it no longer lives under lib/kie. The caller
// passes the operator stamped on the beat at submit; this never re-resolves it
// from the model id. Re-resolving would send a task to whichever provider
// currently prefers that model, and a task id means nothing to a provider that
// did not issue it.
//
// Returns:
//   { status: "done", url }       — image uploaded and beat row updated
//   { status: "failed", error }   — provider reported failure; beat marked failed
//   { status: "pending" }         — still in progress; beat row untouched
// Throws the provider's upstream error on transient 429/5xx — callers decide
// whether to retry next tick (cron) or surface to the client (poll).

export interface FinishImageInput {
  projectId: string;
  beatNumber: number;
  taskId: string;
  modelId?: string;
  userId: string;
  userEmail?: string | null;
  /** project_beats.image_operator. Omitted reads as KIE, which is what every
   *  row predating migration 134 ran on. */
  operator?: unknown;
}

export type FinishImageResult =
  | { status: "done"; url: string }
  | { status: "failed"; error: string }
  | { status: "pending" };

export async function finishImageTask(input: FinishImageInput): Promise<FinishImageResult> {
  const op = getImageOperator(input.operator);
  const result = await op.check({ taskId: input.taskId, modelId: input.modelId, userId: input.userId });

  // Log consumption as soon as the provider has billed us, even if the
  // download or upload then fails: we were charged regardless, and the cost
  // ledger is meant to record spend rather than successes.
  //
  // Which number gets logged depends on the provider, and the difference is
  // not cosmetic. KIE returns what the finished task actually cost, so that is
  // authoritative. PoYo returns no cost field at all, so the only figure
  // available is the catalog price, which is an estimate that will silently be
  // wrong if PoYo reprices. Reported wins where it exists.
  if (result.status === "done" || result.status === "failed") {
    // The submit took a hold. This is where it is answered for, and the
    // finisher has to find it: the webhook, the poll and the cron all arrive
    // here and none of them shares memory with the submit that took it.
    const hold = await findOpenHold({
      userId: input.userId,
      projectId: input.projectId,
      beatNumber: input.beatNumber,
    });

    const estimated = input.modelId ? op.estimate(input.modelId) : null;
    const units = result.units ?? estimated ?? 0;
    if (units > 0) {
      // Read here rather than threaded through the five callers. Images submit
      // on one request and finish on another, so this is the only place that
      // knows both the price and the beat, and without the resolution the
      // rollup can only ever learn a blended figure for the model.
      const { data: beat } = await supabase
        .from("project_beats")
        .select("image_resolution")
        .eq("project_id", input.projectId)
        .eq("beat_number", input.beatNumber)
        .maybeSingle();
      // Awaited rather than fired off, because the hold is settled inside it
      // and a released-then-settled race would return credits twice.
      await logProjectCost({
        projectId: input.projectId,
        userId: input.userId,
        step: "image_gen",
        provider: op.id === "poyo" ? "poyo" : "kie",
        model: input.modelId ?? null,
        units,
        unitKind: op.unitKind,
        resolution: (beat as { image_resolution?: string | null } | null)?.image_resolution ?? null,
        reservationId: hold?.id ?? null,
      });
    } else if (hold) {
      // Nothing was produced and nothing is charged, so the hold goes back
      // whole. Leaving it open would hold credit against work that failed.
      await releaseHold(hold, "image task produced nothing");
    }
  }

  if (result.status === "done" && result.url) {
    console.log(`[finishImageTask] beat=${input.beatNumber} task=${input.taskId} done, source=${result.url.slice(0, 80)}`);
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

    // Only give up the task pointer once the url is actually on the row.
    // Clearing it after a failed url write is what stranded beats at
    // "generating" with no image and no task: nothing was left for the cron to
    // finish, so the spinner ran forever and the credits were already spent.
    if (urlErr || !urlData || urlData.length === 0) {
      console.error(
        `[finishImageTask] beat ${input.beatNumber} task=${input.taskId} keeping task_id: ` +
        "the url write did not land, so the cron must be able to try again",
      );
      return { status: "pending" };
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
