import { NextResponse } from "next/server";

import { withPromptLengthRetry } from "@/lib/kie/promptLength";
import { withRateLimitRetry } from "@/lib/operators/upstream";
import { resolveConsistency, applyConsistency } from "@/lib/character-consistency";
import { resolveImageOperator } from "@/lib/operators/image";
import { asUpstreamError, upstreamErrorResponse } from "@/lib/operators/upstream";
import { getFundingModeById } from "@/lib/funding";
import { incrementFreeUsage } from "@/lib/freeUsage";
import { uploadBuffer, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getAppUrl } from "@/lib/utils";
import type { User } from "@supabase/supabase-js";
import { requireStorageHeadroom } from "@/lib/storage-quota";
import { requireWalletFunds } from "@/lib/heclus-charge";
import { OPERATOR_POYO, type Operator } from "@/lib/operators";
import { poyoCallbackUrl } from "@/lib/poyo/webhook";
import { getMediaOperatorForUser } from "@/lib/operators/routing";

export const maxDuration = 60;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const noRoom = await requireStorageHeadroom(user);
  if (noRoom) return noRoom;
  // Wallet-funded users pay for this step in credits, so an empty balance is
  // refused before any provider is called.
  const broke = await requireWalletFunds(user);
  if (broke) return broke;

  let beatNumber: number | undefined;
  let projectId: string | undefined;
  // Needed in the catch to phrase an out-of-credits correctly, so it is
  // declared out here rather than inside the try.
  let operator: Operator = "kie";

  try {
    const body = await req.json() as {
      projectId: string; beatNumber: number; imagePrompt: string; modelId: string;
      aspectRatio?: string; resolution?: string; operator?: string;
    };
    projectId = body.projectId;
    beatNumber = body.beatNumber;
    const { imagePrompt, modelId, aspectRatio = "16:9", resolution } = body;

    // The admin switch decides who runs this, not the client and not the model
    // id: two providers now carry a model called z-image. getMediaOperatorForUser
    // has already applied the per-surface override and pinned BYO clients to
    // KIE, and resolveImageOperator exempts the free lanes on top of that.
    const op = resolveImageOperator(modelId, await getMediaOperatorForUser(user.id, "image"));
    operator = op.id;

    // Not redundant with the catalog, which now only offers the active
    // operator's models. resolveImageOperator still falls back to whoever
    // carries a model the active operator does not, so a BYO client replaying
    // a stale PoYo model id lands here — and PoYo runs on Heclus's key, so
    // that would spend Heclus's balance with no ledger row against them.
    if (op.id === OPERATOR_POYO && (await getFundingModeById(user.id)) !== "wallet") {
      return NextResponse.json(
        { error: "That model runs on Heclus credits. Switch to Heclus Credits funding to use it, or pick a model on your own KIE key." },
        { status: 403 },
      );
    }

    if (!projectId || !beatNumber || !modelId) {
      return NextResponse.json({ error: "projectId, beatNumber, and modelId are required" }, { status: 400 });
    }
    if (!imagePrompt) {
      console.error(`[images/submit] Beat ${beatNumber} has no imagePrompt`);
      return NextResponse.json({ error: `Beat ${beatNumber} has no image prompt` }, { status: 400 });
    }

    // Append the character-consistency text (per-project override, else
    // account default) to the client-supplied prompt just for the
    // generator call. The stored image_prompt is never touched here.
    const consistency = await resolveConsistency(user.id, projectId);

    // Webhook URL — KIE POSTs here the moment the image finishes, so
    // we don't depend on the cron tick or the browser polling. Cron and
    // page-resume effect remain as backstops in case the webhook is
    // dropped en route.
    // Per operator: a task id only means something to the provider that issued
    // it, so the callback has to land on that provider's verifier too. PoYo's
    // carries a capability token because PoYo does not sign callbacks, and is
    // undefined when no token is configured, which leaves the task to the poll
    // and cron paths rather than registering an unauthenticated callback.
    const callBackUrl = op.id === OPERATOR_POYO
      ? poyoCallbackUrl(getAppUrl(req))
      : `${getAppUrl(req)}/api/webhooks/kie/image`;

    const taskId = await withPromptLengthRetry(imagePrompt, (prompt) => withRateLimitRetry(() => op.submit({
      prompt: applyConsistency(prompt, consistency.text, consistency.append),
      modelId, aspectRatio, resolution, userId: user.id, callbackUrl: callBackUrl,
    })));
    console.log(`[images/submit] beat=${beatNumber} operator=${op.id} model=${modelId} taskId=${taskId}`);

    // Single atomic UPDATE so the webhook can never fire in a window
    // where image_task_id has been cleared but not yet rewritten. The
    // earlier version did two writes (clear, then set after submit),
    // which left a race where a fast KIE callback couldn't find the
    // row and silently dropped the regeneration. Image_url is left
    // intact on purpose — we want the old frame visible under the
    // spinner until the new one lands.
    await supabase.from("project_beats")
      .update({ image_status: "generating", image_task_id: taskId, image_model_id: modelId, image_operator: op.id })
      .eq("project_id", projectId)
      .eq("beat_number", beatNumber);

    return NextResponse.json({ taskId, beatNumber });
  } catch (err) {
    // Mark the beat as failed so the tile renders the Regenerate icon
    // instead of the first-time Generate sparkle. Previously this
    // cleared image_status to NULL to avoid a stuck "generating"
    // spinner, but NULL falls through to the "no attempt made" branch
    // in the tile UI and the beat looks brand new despite the error.
    // "failed" is safe because a successful re-submit will overwrite
    // it back to "generating" and finishImageTask will overwrite to
    // "done" on completion.
    if (projectId !== undefined && beatNumber !== undefined) {
      await supabase.from("project_beats")
        .update({ image_status: "failed" })
        .eq("project_id", projectId)
        .eq("beat_number", beatNumber);
    }

    const upstream = asUpstreamError(err);
    if (upstream) {
      console.warn(`[images/submit] ${operator} upstream ${upstream.upstreamStatus} on beat ${beatNumber}: ${upstream.message}`);
      return upstreamErrorResponse(upstream, operator);
    }

    const message = err instanceof Error ? err.message : "Failed to submit image task";
    console.error("[images/submit] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
