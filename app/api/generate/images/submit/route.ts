import { NextResponse } from "next/server";
import { submitImageTask } from "@/lib/kie/images";
import { KieUpstreamError } from "@/lib/kie/client";
import { generateCloudflareImage, isCloudflareModel, CloudflareError } from "@/lib/cloudflare/images";
import { generateGeminiImage, isGeminiImageModel, GeminiImageError } from "@/lib/gemini/images";
import { incrementFreeUsage } from "@/lib/freeUsage";
import { uploadBuffer, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getAppUrl } from "@/lib/utils";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 60;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  let beatNumber: number | undefined;
  let projectId: string | undefined;

  try {
    const body = await req.json() as {
      projectId: string; beatNumber: number; imagePrompt: string; modelId: string;
      aspectRatio?: string; resolution?: string;
    };
    projectId = body.projectId;
    beatNumber = body.beatNumber;
    const { imagePrompt, modelId, aspectRatio = "16:9", resolution } = body;

    if (!projectId || !beatNumber || !modelId) {
      return NextResponse.json({ error: "projectId, beatNumber, and modelId are required" }, { status: 400 });
    }
    if (!imagePrompt) {
      console.error(`[images/submit] Beat ${beatNumber} has no imagePrompt`);
      return NextResponse.json({ error: `Beat ${beatNumber} has no image prompt` }, { status: 400 });
    }

    // Free path (BYO Cloudflare Workers AI). Cloudflare returns image bytes
    // synchronously — no task id / webhook — so we generate, upload, and
    // mark the beat done inline. Runs on the user's own free quota; no KIE
    // credits and no cost-ledger entry.
    if (isCloudflareModel(modelId) || isGeminiImageModel(modelId)) {
      await supabase.from("project_beats")
        .update({ image_status: "generating", image_model_id: modelId, image_task_id: null })
        .eq("project_id", projectId)
        .eq("beat_number", beatNumber);

      const generateFree = isGeminiImageModel(modelId) ? generateGeminiImage : generateCloudflareImage;
      let buffer: ArrayBuffer, contentType: string;
      try {
        ({ buffer, contentType } = await generateFree(imagePrompt, modelId, aspectRatio, user.id));
      } catch (err) {
        // The beat was just marked "generating" with no task id — nothing
        // (webhook, cron, poll) will ever rescue it, so flip it to failed
        // before surfacing the error or it spins forever in the UI.
        await supabase.from("project_beats")
          .update({ image_status: "failed", image_task_id: null })
          .eq("project_id", projectId)
          .eq("beat_number", beatNumber);
        throw err;
      }
      const folder = userFolderFor({ id: user.id, email: user.email ?? null });
      const storagePath = `${folder}/${projectId}/images/beat-${beatNumber}_${Date.now()}.jpg`;
      const publicUrl = await uploadBuffer(storagePath, buffer, contentType);

      await supabase.from("project_beats")
        .update({ image_url: publicUrl, image_status: "done", image_task_id: null })
        .eq("project_id", projectId)
        .eq("beat_number", beatNumber);

      // Awaited (not fire-and-forget): on serverless the function can be
      // frozen the moment we return, cutting off an un-awaited RPC.
      await incrementFreeUsage(user.id, "image", 1);
      console.log(`[images/submit] beat=${beatNumber} model=${modelId} (free/cloudflare) done`);
      return NextResponse.json({ done: true, beatNumber, imageUrl: publicUrl });
    }

    // Webhook URL — KIE POSTs here the moment the image finishes, so
    // we don't depend on the cron tick or the browser polling. Cron and
    // page-resume effect remain as backstops in case the webhook is
    // dropped en route.
    const callBackUrl = `${getAppUrl(req)}/api/webhooks/kie/image`;

    const taskId = await submitImageTask(imagePrompt, modelId, aspectRatio, resolution, user.id, callBackUrl);
    console.log(`[images/submit] beat=${beatNumber} model=${modelId} taskId=${taskId}`);

    // Single atomic UPDATE so the webhook can never fire in a window
    // where image_task_id has been cleared but not yet rewritten. The
    // earlier version did two writes (clear, then set after submit),
    // which left a race where a fast KIE callback couldn't find the
    // row and silently dropped the regeneration. Image_url is left
    // intact on purpose — we want the old frame visible under the
    // spinner until the new one lands.
    await supabase.from("project_beats")
      .update({ image_status: "generating", image_task_id: taskId, image_model_id: modelId })
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

    if (err instanceof CloudflareError || err instanceof GeminiImageError) {
      // 401 = key not connected, 429 = free quota spent; both are user-
      // config issues, not server failures, so don't 500 / page on them.
      console.warn(`[images/submit] free-provider error on beat ${beatNumber}: ${err.message}`);
      const status = err.status === 401 ? 401 : err.status === 429 ? 429 : 502;
      return NextResponse.json(
        { error: err.message, code: err instanceof GeminiImageError ? "gemini_free" : "cloudflare_free" },
        { status },
      );
    }

    if (err instanceof KieUpstreamError) {
      console.warn(`[images/submit] KIE upstream ${err.upstreamStatus} on beat ${beatNumber}: ${err.message}`);
      const headers: Record<string, string> = {};
      if (err.upstreamStatus === 429 && err.retryAfter != null) {
        headers["Retry-After"] = String(err.retryAfter);
      }
      // Insufficient credits is a customer configuration issue, not a
      // server failure — surface as 402 so Vercel doesn't page on it
      // and the client can render "top up your KIE balance" instead of
      // a generic error. 429 stays 429 for rate-limit retry logic.
      // Everything else becomes 502 (bad gateway): valid request, KIE
      // failed.
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

    const message = err instanceof Error ? err.message : "Failed to submit image task";
    console.error("[images/submit] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
