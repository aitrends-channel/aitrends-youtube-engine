import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Reset per-beat voiceover status for any beat stuck in a non-terminal
// state. Used after a "Stream ended unexpectedly" error on the
// voiceover page — the route's finally couldn't run, so beats it had
// marked queued / generating are now orphans that the UI keeps
// rendering as in-flight.
//
// Only touches beats with voiceover_status IN ('queued', 'generating'):
//   - done beats keep their voiceover_url and status
//   - failed beats keep their error context (the user can retry them)
//
// Clears the per-beat in-flight columns (status + job_id + transient
// error) so the cards flip back to "pending" / regeneratable.
export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await req.json().catch(() => ({})) as { projectId?: string };
  if (!body.projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  const projectId = body.projectId;

  // Verify ownership first.
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id, user_id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .single();
  if (projErr || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { error: updErr, count } = await supabase
    .from("project_beats")
    .update(
      {
        voiceover_status: null,
        voiceover_job_id: null,
        voiceover_error: null,
      },
      { count: "exact" },
    )
    .eq("project_id", projectId)
    .in("voiceover_status", ["queued", "generating"]);
  if (updErr) {
    return NextResponse.json({ error: `Failed to reset beats: ${updErr.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, reset: count ?? 0 });
}
