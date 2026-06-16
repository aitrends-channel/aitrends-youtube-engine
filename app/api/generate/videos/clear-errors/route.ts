import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * Wipe video_error from every beat on a project. Called by the
 * client at the start of any video action (queue, regenerate,
 * resume, pause) so the section banner doesn't surface a stale
 * error from a previous attempt while the user is mid-action.
 *
 * Ownership-checked: only the project's user can clear its errors.
 * Idempotent: returns the number of rows affected so the caller can
 * log or display if it cares, but no failure on zero matches.
 */
export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { projectId } = await req.json() as { projectId: string };
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    // Ownership gate — make sure the user owns this project before
    // wiping fields on its beats.
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
      .update({ video_error: null })
      .eq("project_id", projectId)
      .not("video_error", "is", null)
      .select("beat_number");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ cleared: data?.length ?? 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to clear errors";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
