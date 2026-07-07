import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * Cancel a single in-flight video beat. Companion to cancel-pending
 * (which sweeps every queued/rendering beat on a project) — this
 * one is scoped to (projectId, beatNumber) so the user can stop one
 * clip without touching the rest of the batch.
 *
 * Marks the beat as failed with an explicit "Cancelled by user"
 * reason and wipes video_job_id so the worker's next commit UPDATE
 * (guarded on video_status IN ('submitting','rendering')) will
 * discard the orphan render if KIE eventually finishes.
 *
 * Only allows cancel from active states — queued / submitting /
 * rendering / paused. A "done" or already-failed beat is a no-op
 * (returns cancelled: 0) so a rapid double-click doesn't clobber
 * a beat that just landed.
 */
export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { projectId, beatNumber } = await req.json() as {
      projectId?: string;
      beatNumber?: number;
    };

    if (!projectId || typeof beatNumber !== "number") {
      return NextResponse.json({ error: "projectId and beatNumber are required" }, { status: 400 });
    }

    // Ownership check — project_beats rows have no user_id column, so
    // we scope through the project's user_id first before touching
    // anything.
    const { data: project, error: projectErr } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (projectErr) return NextResponse.json({ error: projectErr.message }, { status: 500 });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data, error } = await supabase
      .from("project_beats")
      .update({
        video_status: "failed",
        video_error: "Cancelled by user",
        video_job_id: null,
      })
      .eq("project_id", projectId)
      .eq("beat_number", beatNumber)
      .in("video_status", ["queued", "submitting", "rendering", "paused"])
      .select("beat_number");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ cancelled: data?.length ?? 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cancel failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
