import { NextResponse } from "next/server";
import { finishImageTask } from "@/lib/operators/finishImage";
import { asUpstreamError } from "@/lib/operators/upstream";
import { supabase } from "@/lib/supabase/client";
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

    // The operator comes off the beat row, never off the request. The client
    // has no business naming which provider we ask about a task, and a wrong
    // answer here polls a provider that never issued the id.
    const { data: beat } = await supabase
      .from("project_beats")
      .select("image_operator")
      .eq("project_id", projectId)
      .eq("beat_number", beatNumber)
      .maybeSingle();

    const result = await finishImageTask({
      projectId, beatNumber, taskId, modelId,
      operator: (beat as { image_operator?: string } | null)?.image_operator,
      userId: user.id, userEmail: user.email,
    });
    console.log(`[images/poll] beat=${beatNumber} taskId=${taskId} status=${result.status}`);

    if (result.status === "done") return NextResponse.json({ status: "done", url: result.url });
    if (result.status === "failed") return NextResponse.json({ status: "failed", error: result.error });
    return NextResponse.json({ status: "pending" });
  } catch (err) {
    const upstream = asUpstreamError(err);
    if (upstream) {
      console.warn(`[images/poll] upstream ${upstream.upstreamStatus}: ${upstream.message}`);
      const headers: Record<string, string> = {};
      if (upstream.upstreamStatus === 429 && upstream.retryAfter != null) {
        headers["Retry-After"] = String(upstream.retryAfter);
      }
      // 429 stays 429 so the client treats this as a transient backoff
      // and keeps polling rather than abandoning the task.
      const status = upstream.upstreamStatus === 429 ? 429 : 502;
      return NextResponse.json({ status: "error", error: upstream.message, upstreamStatus: upstream.upstreamStatus }, { status, headers });
    }
    const message = err instanceof Error ? err.message : "Failed to poll image task";
    console.error("[images/poll] Error:", message);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
