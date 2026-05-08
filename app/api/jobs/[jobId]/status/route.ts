import { NextResponse } from "next/server";
import { videoQueue } from "@/lib/queue/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  void user;

  const { jobId } = await params;

  try {
    const job = await videoQueue.getJob(jobId);
    if (!job) {
      return NextResponse.json({ status: "not_found" }, { status: 404 });
    }

    const state = await job.getState();
    return NextResponse.json({
      status: state,
      progress: job.progress,
      result: state === "completed" ? job.returnvalue : null,
      error: state === "failed" ? job.failedReason : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get job status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
