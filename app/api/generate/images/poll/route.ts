import { NextResponse } from "next/server";
import { finishImageTask } from "@/lib/kie/finishImageTask";
import { KieUpstreamError } from "@/lib/kie/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Higher ceiling so finishing a large asset (e.g. nano-banana-pro at 4K,
// which finishImageTask downloads in full and re-uploads to R2) doesn't
// time out mid-transfer and leave the beat stuck "generating" with the
// URL never persisted. 30s was too tight for big images.
export const maxDuration = 120;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { projectId, beatNumber, taskId, modelId } = await req.json() as {
      projectId: string; beatNumber: number; taskId: string; modelId?: string;
    };

    if (!projectId || !beatNumber || !taskId) {
      return NextResponse.json({ error: "projectId, beatNumber, and taskId are required" }, { status: 400 });
    }

    const result = await finishImageTask({
      projectId, beatNumber, taskId, modelId,
      userId: user.id, userEmail: user.email,
    });
    console.log(`[images/poll] beat=${beatNumber} taskId=${taskId} status=${result.status}`);

    if (result.status === "done") return NextResponse.json({ status: "done", url: result.url });
    if (result.status === "failed") return NextResponse.json({ status: "failed", error: result.error });
    return NextResponse.json({ status: "pending" });
  } catch (err) {
    if (err instanceof KieUpstreamError) {
      console.warn(`[images/poll] KIE upstream ${err.upstreamStatus}: ${err.message}`);
      const headers: Record<string, string> = {};
      if (err.upstreamStatus === 429 && err.retryAfter != null) {
        headers["Retry-After"] = String(err.retryAfter);
      }
      // 429 stays 429 so the client treats this as a transient backoff
      // and keeps polling rather than abandoning the task.
      const status = err.upstreamStatus === 429 ? 429 : 502;
      return NextResponse.json({ status: "error", error: err.message, upstreamStatus: err.upstreamStatus }, { status, headers });
    }
    const message = err instanceof Error ? err.message : "Failed to poll image task";
    console.error("[images/poll] Error:", message);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
