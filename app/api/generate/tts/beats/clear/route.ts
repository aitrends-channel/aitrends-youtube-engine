import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { deleteFolder, userFolderFor } from "@/lib/supabase/storage";
import type { User } from "@supabase/supabase-js";

// Wipe every per-beat voiceover for a project — both the audio files in
// R2 and the voiceover_* columns on project_beats. After this, the
// voiceover page renders every beat as "Pending" again and a bulk
// Generate run starts from scratch.
//
// Storage layout (see app/api/generate/tts/beats/route.ts):
//   {userFolder}/{projectId}/voiceovers/beat-{N}_{timestamp}.mp3
// We delete the whole `voiceovers/` prefix in one ListObjects + batch
// Delete pass via deleteFolder() — keys we don't need to enumerate.
export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await req.json().catch(() => ({})) as { projectId?: string };
  if (!body.projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  const projectId = body.projectId;

  // Verify ownership before touching storage / DB — RLS would block a
  // foreign update too, but this fails fast and avoids a partial wipe.
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id, user_id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .single();
  if (projErr || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const prefix = `${userFolderFor(user)}/${projectId}/voiceovers/`;
  try {
    await deleteFolder(prefix);
  } catch (e) {
    // R2 cleanup failure shouldn't block the DB reset. Log and proceed
    // — the orphaned files are cheap and the next bulk Generate will
    // overwrite the keys when it re-uploads.
    console.warn(`[tts-beats/clear] R2 cleanup failed for ${prefix}:`, e instanceof Error ? e.message : e);
  }

  const { error: updErr, count } = await supabase
    .from("project_beats")
    .update({
      voiceover_url: null,
      voiceover_status: null,
      voiceover_duration_ms: null,
      voiceover_voice_id: null,
      voiceover_script_hash: null,
      voiceover_error: null,
      voiceover_job_id: null,
    }, { count: "exact" })
    .eq("project_id", projectId);
  if (updErr) {
    return NextResponse.json({ error: `Failed to reset beats: ${updErr.message}` }, { status: 500 });
  }

  console.log(`[tts-beats/clear] project=${projectId} cleared ${count ?? 0} beat row(s) and R2 prefix ${prefix}`);
  return NextResponse.json({ ok: true, cleared: count ?? 0 });
}
