import { NextResponse } from "next/server";
import { submitImageTask } from "@/lib/kie/images";
import { KieUpstreamError } from "@/lib/kie/client";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getAppUrl } from "@/lib/utils";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 30;

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
    // Clear the "generating" marker we set above so the beat doesn't get
    // stuck spinning forever after a submission failure. Without this,
    // the UI shows a permanent in-flight state for any 429/5xx — the
    // client never learned about a taskId so it never polls.
    if (projectId !== undefined && beatNumber !== undefined) {
      await supabase.from("project_beats")
        .update({ image_status: null })
        .eq("project_id", projectId)
        .eq("beat_number", beatNumber);
    }

    if (err instanceof KieUpstreamError) {
      console.warn(`[images/submit] KIE upstream ${err.upstreamStatus} on beat ${beatNumber}: ${err.message}`);
      const headers: Record<string, string> = {};
      if (err.upstreamStatus === 429 && err.retryAfter != null) {
        headers["Retry-After"] = String(err.retryAfter);
      }
      // 429 stays 429 so the alerting layer and any client retry logic
      // can tell rate limits from real failures. Other upstream errors
      // become 502 (bad gateway): the request was valid, KIE failed.
      const status = err.upstreamStatus === 429 ? 429 : 502;
      return NextResponse.json({ error: err.message, upstreamStatus: err.upstreamStatus }, { status, headers });
    }

    const message = err instanceof Error ? err.message : "Failed to submit image task";
    console.error("[images/submit] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
