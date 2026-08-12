import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { GENAIPRO_QUEUED_STATUS } from "@/lib/genaipro/client";

export const dynamic = "force-dynamic";

/**
 * Flip every queued / rendering beat on a project to failed in one
 * shot. Used by the client when it detects a model-level rejection
 * from KIE — the rest of the in-flight beats will fail the same way
 * for the same reason, so we may as well stop the worker from
 * burning credits + the UI from showing a stale "Rendering" badge.
 *
 * The single ownership rule (worker is the only writer for video_*
 * fields) is bent here: client triggers the sweep but only against
 * a project the user owns (RLS-enforced via the .eq("user_id") on
 * the projects join below).
 */
export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { projectId, errorMessage } = await req.json() as {
      projectId: string;
      errorMessage?: string;
    };

    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    // Ownership check first so a client can't sweep a project that
    // isn't theirs even though project_beats rows have no user_id
    // column directly.
    const { data: project, error: projectErr } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (projectErr) return NextResponse.json({ error: projectErr.message }, { status: 500 });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const reason = (errorMessage ?? "").trim()
      || "Cancelled — earlier beat failed with the same error; remaining beats stopped to avoid wasted credits.";

    // Wipe video_job_id too so any in-flight worker poll that hasn't
    // landed yet has no row to resurrect via its job-id lookup. The
    // worker also has a status guard on its commit UPDATE, but this
    // belt-and-suspenders avoids the worker re-claiming a beat that
    // was already cancelled.
    const { data, error } = await supabase
      .from("project_beats")
      .update({ video_status: "failed", video_error: reason, video_job_id: null })
      .eq("project_id", projectId)
      .in("video_status", [GENAIPRO_QUEUED_STATUS, "queued", "submitting", "rendering"])
      .select("beat_number");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ cancelled: data?.length ?? 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cancel failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
