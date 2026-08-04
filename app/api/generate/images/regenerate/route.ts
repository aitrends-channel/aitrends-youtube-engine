import { NextResponse } from "next/server";
import { submitImageTask, checkImageTask } from "@/lib/kie/images";
import { withPromptLengthRetry } from "@/lib/kie/promptLength";
import { resolveConsistency, applyConsistency } from "@/lib/character-consistency";
import { KieUpstreamError } from "@/lib/kie/client";
import { incrementFreeUsage } from "@/lib/freeUsage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { uploadBuffer, uploadFromUrl, deleteObject, r2KeyFromUrl, userFolderFor } from "@/lib/supabase/storage";
import { logProjectCost } from "@/lib/costs";
import type { User } from "@supabase/supabase-js";
import { requireActiveSubscription } from "@/lib/subscription";
import { requireStorageHeadroom } from "@/lib/storage-quota";

export const maxDuration = 120;

/**
 * Single-image regenerate — synchronous from the client's perspective.
 *
 * User clicks regenerate → this route runs the entire flow inline:
 *   1. Snapshot the row's current image_url (so we can delete the
 *      previous storage object after the new one lands).
 *   2. Submit the prompt to KIE (no webhook callback; we poll
 *      ourselves).
 *   3. Mark the row "generating" so a parallel page load can show
 *      the spinner if the user navigates away and back.
 *   4. Poll KIE every 3s until status=done (or failed/timeout).
 *   5. Upload the new image to storage.
 *   6. UPDATE the row with the new URL, clear status/task pointers.
 *   7. Best-effort delete the previous storage object so we don't
 *      leak abandoned bytes on every regen.
 *   8. Return { url } so the client can mutate SWR and the UI
 *      swaps in the new image immediately.
 *
 * No webhook, no cron, no client polling, no idempotency dance —
 * single source of truth, linear control flow. The trade-off is the
 * client request takes ~10-60s (the full generation time). If the
 * user cancels, the KIE task continues server-side and we orphan
 * the image; that's acceptable for an interactive action they
 * triggered themselves.
 */
export async function POST(req: Request) {
  // Temporary diagnostic — remove once R2 env confirmed.
  console.log("[images/regenerate] env check:", {
    R2_BUCKET_NAME: process.env.R2_BUCKET_NAME ? `set (${process.env.R2_BUCKET_NAME.slice(0, 4)}…)` : "MISSING",
    R2_PUBLIC_URL:  process.env.R2_PUBLIC_URL  ? "set" : "MISSING",
    R2_ACCOUNT_ID:  process.env.R2_ACCOUNT_ID  ? "set" : "MISSING",
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ? "set" : "MISSING",
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ? "set" : "MISSING",
  });

  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const expired = requireActiveSubscription(user);
  if (expired) return expired;
  const noRoom = await requireStorageHeadroom(user);
  if (noRoom) return noRoom;

  try {
    const { projectId, beatNumber, imagePrompt, modelId, aspectRatio = "16:9", resolution } = await req.json() as {
      projectId: string; beatNumber: number; imagePrompt: string; modelId: string;
      aspectRatio?: string; resolution?: string;
    };

    if (!projectId || !beatNumber || !modelId) {
      return NextResponse.json({ error: "projectId, beatNumber, and modelId are required" }, { status: 400 });
    }
    if (!imagePrompt) {
      return NextResponse.json({ error: `Beat ${beatNumber} has no image prompt` }, { status: 400 });
    }

    // Character-consistency text appended to the prompt only for the
    // generator call — the (possibly edited) imagePrompt is what we
    // persist to image_prompt below, kept clean.
    const consistency = await resolveConsistency(user.id, projectId);

    // 1. Snapshot existing image so we can delete it after the new
    //    one is live in the DB.
    const { data: beatRow } = await supabase
      .from("project_beats")
      .select("image_url")
      .eq("project_id", projectId)
      .eq("beat_number", beatNumber)
      .maybeSingle();
    const previousImageUrl = beatRow?.image_url ?? null;

    // 2. Submit to KIE. No callBackUrl — this route owns the
    //    completion path. Stamp t0 here so the wall-clock elapsed
    //    we log to project_costs.elapsed_ms covers the entire
    //    KIE-side submit + poll, matching what the user perceives
    //    as "how long this model took". Powers the picker's
    //    "Fastest" tab ranking.
    const submitT0 = Date.now();
    const taskId = await withPromptLengthRetry(imagePrompt, (prompt) => submitImageTask(
      applyConsistency(prompt, consistency.text, consistency.append),
      modelId, aspectRatio, resolution, user.id,
    ));
    console.log(`[images/regenerate] beat=${beatNumber} model=${modelId} taskId=${taskId}`);

    // 3. Mark in-flight. A page refresh between submit and complete
    //    would show the spinner (gated on image_status=generating).
    //    image_prompt persists here too (not just on the "done" write)
    //    so an edited prompt survives a failed generation instead of
    //    being silently lost.
    await supabase.from("project_beats")
      .update({ image_status: "generating", image_task_id: taskId, image_model_id: modelId, image_prompt: imagePrompt })
      .eq("project_id", projectId)
      .eq("beat_number", beatNumber);

    // 4. Poll KIE until it returns done or failed. 60 attempts × 3s
    //    = 180s. Most Flux Kontext gens land in 10-30s; long tail
    //    of slower models still fits inside our 120s maxDuration
    //    plus this poll budget (we'll be killed by Vercel first if
    //    KIE genuinely hangs — the row keeps image_status =
    //    "generating", and a subsequent regen click overwrites it).
    let kieUrl: string | undefined;
    let creditsConsumed: number | undefined;
    const POLL_MS = 3000;
    const MAX_ATTEMPTS = 35; // ~105s; safe margin under maxDuration=120
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const result = await checkImageTask(taskId, user.id, modelId);
      if (result.status === "done" && result.url) {
        kieUrl = result.url;
        creditsConsumed = result.creditsConsumed;
        break;
      }
      if (result.status === "failed") {
        await supabase.from("project_beats")
          .update({ image_status: "failed", image_task_id: null, image_model_id: null })
          .eq("project_id", projectId)
          .eq("beat_number", beatNumber);
        if (result.creditsConsumed) {
          void logProjectCost({
            projectId, userId: user.id, step: "image_gen", provider: "kie",
            model: modelId, units: result.creditsConsumed, unitKind: "kie_credits",
            elapsedMs: Date.now() - submitT0,
          });
        }
        return NextResponse.json({ error: result.error ?? "Image generation failed" }, { status: 502 });
      }
    }
    if (!kieUrl) {
      // Polling exhausted — leave task_id in place so the cron
      // backstop can still finish the job in the background.
      return NextResponse.json({ error: "Image generation timed out" }, { status: 504 });
    }

    if (creditsConsumed) {
      void logProjectCost({
        projectId, userId: user.id, step: "image_gen", provider: "kie",
        model: modelId, units: creditsConsumed, unitKind: "kie_credits",
        elapsedMs: Date.now() - submitT0,
      });
    }

    // 5. Upload to our storage so we serve the image from our own
    //    URL (KIE-hosted URLs expire).
    const folder = userFolderFor({ id: user.id, email: user.email ?? null });
    const storagePath = `${folder}/${projectId}/images/beat-${beatNumber}_${Date.now()}.png`;
    const publicUrl = await uploadFromUrl(storagePath, kieUrl, "image/png");
    console.log(`[images/regenerate] beat=${beatNumber} uploaded ${publicUrl.slice(0, 80)}`);

    // 6. Write the new URL + the prompt that produced it. Persisting
    //    the prompt keeps Prompt Studio in sync when the user edits
    //    a prompt inline from the image regenerate modal — the
    //    image and its prompt of record stay aligned.
    const { error: updateErr } = await supabase.from("project_beats")
      .update({ image_url: publicUrl, image_prompt: imagePrompt, image_status: "done", image_task_id: null, image_model_id: null })
      .eq("project_id", projectId)
      .eq("beat_number", beatNumber);
    if (updateErr) {
      console.error(`[images/regenerate] beat=${beatNumber} DB update failed: ${updateErr.message}`);
      return NextResponse.json({ error: `DB update failed: ${updateErr.message}` }, { status: 500 });
    }

    // 7. Best-effort delete of the previous storage object. We
    //    swallow any error — keeping orphaned bytes is preferable
    //    to failing the regen response over a delete glitch.
    if (previousImageUrl) {
      try {
        const oldKey = r2KeyFromUrl(previousImageUrl);
        if (oldKey) {
          await deleteObject(oldKey);
          console.log(`[images/regenerate] beat=${beatNumber} deleted previous ${oldKey.slice(0, 80)}`);
        }
      } catch (e) {
        console.warn(`[images/regenerate] beat=${beatNumber} delete previous failed:`, e instanceof Error ? e.message : e);
      }
    }

    return NextResponse.json({ ok: true, url: publicUrl });
  } catch (err) {
    if (err instanceof KieUpstreamError) {
      const headers: Record<string, string> = {};
      if (err.upstreamStatus === 429 && err.retryAfter != null) headers["Retry-After"] = String(err.retryAfter);
      // See app/api/generate/images/submit/route.ts for the mapping
      // rationale — 402 for out-of-credit so Vercel doesn't alert.
      let status: number;
      let code: string | undefined;
      if (err.insufficientCredits) {
        status = 402;
        code = "insufficient_credits";
      } else if (err.upstreamStatus === 429) {
        status = 429;
      } else {
        status = 502;
      }
      return NextResponse.json(
        {
          error: err.insufficientCredits
            ? "Your KIE account is out of credits. Add credits at kie.ai and try again."
            : err.message,
          code,
          upstreamStatus: err.upstreamStatus,
        },
        { status, headers },
      );
    }
    const message = err instanceof Error ? err.message : "Regenerate failed";
    console.error("[images/regenerate] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
