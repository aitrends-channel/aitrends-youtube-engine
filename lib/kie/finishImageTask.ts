import { checkImageTask } from "@/lib/kie/images";
import { uploadFromUrl, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";

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

  if (result.status === "done" && result.url) {
    const folder = userFolderFor({ id: input.userId, email: input.userEmail ?? null });
    const storagePath = `${folder}/${input.projectId}/images/beat-${input.beatNumber}_${Date.now()}.png`;
    const publicUrl = await uploadFromUrl(storagePath, result.url, "image/png");

    // .is("image_url", null) is the idempotency guard. Webhook and cron
    // can race on the same task; whichever runs second sees image_url
    // already populated and the UPDATE affects zero rows. The double
    // upload above is a small waste (one extra storage write under
    // race), but the row stays consistent and the user-visible URL
    // never flickers between two different objects.
    await supabase.from("project_beats")
      .update({ image_url: publicUrl, image_status: "done", image_task_id: null, image_model_id: null })
      .eq("project_id", input.projectId)
      .eq("beat_number", input.beatNumber)
      .is("image_url", null);

    return { status: "done", url: publicUrl };
  }

  if (result.status === "failed") {
    await supabase.from("project_beats")
      .update({ image_status: "failed", image_task_id: null, image_model_id: null })
      .eq("project_id", input.projectId)
      .eq("beat_number", input.beatNumber)
      .is("image_url", null);

    return { status: "failed", error: result.error ?? "Image generation failed" };
  }

  return { status: "pending" };
}
