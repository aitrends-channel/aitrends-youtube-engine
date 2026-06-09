export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { deleteFolder, deleteObject, r2KeyFromUrl, userFolderFor } from "@/lib/supabase/storage";
import type { User } from "@supabase/supabase-js";

export async function GET(
  _req: Request,
  { params }: { params: { projectId: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  const [projectRes, beatsRes, thumbsRes] = await Promise.all([
    supabase.from("projects").select("*").eq("id", projectId).eq("user_id", user.id).single(),
    supabase.from("project_beats").select("*").eq("project_id", projectId).order("beat_number"),
    supabase.from("project_thumbnails").select("*").eq("project_id", projectId).order("position"),
  ]);

  if (projectRes.error) {
    return NextResponse.json({ error: projectRes.error.message }, { status: 404 });
  }

  return NextResponse.json({
    ...projectRes.data,
    beats: (beatsRes.data ?? []).map((b) => ({
      beatNumber: b.beat_number,
      scriptSegment: b.script_segment,
      imagePrompt: b.image_prompt,
      camera: b.camera,
      lighting: b.lighting,
      mood: b.mood,
      action: b.action,
      videoPrompt: b.video_prompt,
      imageUrl: b.image_url,
      videoUrl: b.video_url,
      imageStatus: b.image_status,
      videoStatus: b.video_status,
      imageTaskId: b.image_task_id ?? undefined,
      imageModelId: b.image_model_id ?? undefined,
      videoJobId: b.video_job_id,
      videoError: b.video_error ?? undefined,
      audioUrl: b.audio_url ?? undefined,
    })),
    thumbnails: (thumbsRes.data ?? []).map((t) => ({
      position: t.position,
      title: t.title,
      visualConcept: t.visual_concept,
      textOverlay: t.text_overlay,
      emotionTrigger: t.emotion_trigger,
      stylePrompt: t.style_prompt,
      imageUrl: t.image_url,
      imageStatus: t.image_status,
    })),
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;
  const body = await req.json();

  if (body.clear_images) {
    await supabase.from("project_beats").update({ image_url: null, image_status: null }).eq("project_id", projectId);
    await supabase.from("projects").update({ images_progress: 0 }).eq("id", projectId).eq("user_id", user.id);
    return NextResponse.json({ success: true });
  }

  // Wipe all image-prompt beats for this project so the prompts step can
  // start over from a clean slate. Also implicitly clears any video
  // prompts since they live on the same rows. Nulling
  // prompts_active_run_id signals any in-flight prompts route for this
  // project to abort at its next checkpoint instead of writing more
  // beats on top of the wiped state.
  if (body.clear_image_prompts) {
    const { error: delErr } = await supabase
      .from("project_beats")
      .delete()
      .eq("project_id", projectId);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
    await supabase
      .from("projects")
      .update({ prompts_active_run_id: null, prompts_active_step: null })
      .eq("id", projectId)
      .eq("user_id", user.id);
    return NextResponse.json({ success: true });
  }

  // Hard-delete the assembled mp4 from R2 + wipe the related project
  // state so the assemble page resets to its pre-assembly view. Called
  // from the Reassemble confirm path on the client.
  //
  // What gets cleaned:
  //   - The single assembled_*.mp4 referenced by project.assembled_url
  //     (only when the URL is one of ours — preview-proxy URLs are
  //     skipped since they live on the worker's disk, not in R2).
  //   - The entire _assembly/ checkpoint folder for this project (clip
  //     fragments, joined/padded/mixed/captioned mp4s). These can be
  //     several MB each so we don't want them stranded.
  //
  // What gets reset on the project row:
  //   - assembled_url (the link we just deleted)
  //   - assembly_status / assembly_progress / assembly_error
  //   - assembly_checkpoint (so the next run doesn't try to skip stages)
  //   - assembly_stop_requested (defensive — fresh starts shouldn't
  //     inherit a stale stop signal)
  //
  // Errors during storage delete are logged but don't fail the
  // request — the project-row reset is the user-visible outcome and
  // worth keeping even if storage cleanup races.
  if (body.clear_assembled) {
    const { data: proj } = await supabase
      .from("projects")
      .select("assembled_url")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .single();
    const assembledUrl = (proj?.assembled_url as string | null) ?? null;
    if (assembledUrl) {
      const key = r2KeyFromUrl(assembledUrl);
      if (key) {
        try { await deleteObject(key); }
        catch (e) { console.warn(`[clear_assembled] failed to delete ${key}:`, e); }
      }
    }
    try {
      const folder = `${userFolderFor(user)}/${projectId}/_assembly/`;
      await deleteFolder(folder);
    } catch (e) {
      console.warn(`[clear_assembled] failed to delete checkpoint folder:`, e);
    }
    const { error: updErr } = await supabase
      .from("projects")
      .update({
        assembled_url: null,
        assembly_status: null,
        assembly_progress: null,
        assembly_error: null,
        assembly_checkpoint: null,
        assembly_stop_requested: false,
      })
      .eq("id", projectId)
      .eq("user_id", user.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Delete the project's voiceover(s) from R2 and wipe the related
  // fields on the project row so the Generate page returns to its
  // pre-TTS state. Both original (tts_url) and trimmed (tts_cleaned_url)
  // are removed when present. Storage errors are logged but don't
  // fail the request — the row reset is the visible outcome.
  if (body.clear_voiceover) {
    const { data: proj } = await supabase
      .from("projects")
      .select("tts_url, tts_cleaned_url")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .single();
    const candidates = [proj?.tts_url as string | null, proj?.tts_cleaned_url as string | null]
      .filter((u): u is string => !!u);
    for (const url of candidates) {
      const key = r2KeyFromUrl(url);
      if (!key) continue;
      try { await deleteObject(key); }
      catch (e) { console.warn(`[clear_voiceover] failed to delete ${key}:`, e); }
    }
    const { error: updErr } = await supabase
      .from("projects")
      .update({
        tts_url: null,
        tts_cleaned_url: null,
        tts_script_hash: null,
        tts_voice_id: null,
      })
      .eq("id", projectId)
      .eq("user_id", user.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Clear only video prompts; keep the beats and their image prompts.
  if (body.clear_video_prompts) {
    const { error: updErr } = await supabase
      .from("project_beats")
      .update({ video_prompt: null })
      .eq("project_id", projectId);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    await supabase
      .from("projects")
      .update({ prompts_active_run_id: null, prompts_active_step: null })
      .eq("id", projectId)
      .eq("user_id", user.id);
    return NextResponse.json({ success: true });
  }

  const { data, error } = await supabase
    .from("projects")
    .update(body)
    .eq("id", projectId)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: Request,
  { params }: { params: { projectId: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  // Verify project belongs to this user and fetch file URLs
  const [projectRes, beatsRes, thumbsRes] = await Promise.all([
    supabase.from("projects").select("id, tts_url").eq("id", projectId).eq("user_id", user.id).single(),
    supabase.from("project_beats").select("image_url, video_url, audio_url").eq("project_id", projectId),
    supabase.from("project_thumbnails").select("image_url").eq("project_id", projectId),
  ]);

  if (projectRes.error || !projectRes.data) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Collect Supabase storage paths before we drop the DB rows
  const supabaseStorageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/assets/`;
  const supabasePaths = [
    projectRes.data.tts_url,
    ...(beatsRes.data ?? []).flatMap((b) => [b.image_url, b.video_url, b.audio_url]),
    ...(thumbsRes.data ?? []).map((t) => t.image_url),
  ]
    .filter((url): url is string => !!url && url.startsWith(supabaseStorageBase))
    .map((url) => url.replace(supabaseStorageBase, ""));

  // DB cleanup first — children before parent. If storage cleanup later fails,
  // we leave orphan files (benign) rather than orphan DB rows (broken UI).
  const childrenRes = await Promise.allSettled([
    supabase.from("project_beats").delete().eq("project_id", projectId),
    supabase.from("project_thumbnails").delete().eq("project_id", projectId),
  ]);

  const childErrors = childrenRes
    .map((r) => r.status === "rejected" ? String(r.reason) : (r.value.error?.message ?? null))
    .filter((e): e is string => !!e);

  if (childErrors.length > 0) {
    return NextResponse.json({ error: `Failed to delete child rows: ${childErrors.join("; ")}` }, { status: 500 });
  }

  const projectDelete = await supabase.from("projects").delete().eq("id", projectId).eq("user_id", user.id);
  if (projectDelete.error) {
    return NextResponse.json({ error: projectDelete.error.message }, { status: 500 });
  }

  // Storage cleanup — best-effort, won't fail the request if it errors out
  const warnings: string[] = [];

  if (supabasePaths.length > 0) {
    const { error } = await supabase.storage.from("assets").remove(supabasePaths);
    if (error) warnings.push(`Supabase storage: ${error.message}`);
  }

  try {
    await deleteFolder(`${projectId}/`);
  } catch (err) {
    warnings.push(`R2 storage: ${err instanceof Error ? err.message : String(err)}`);
  }

  return NextResponse.json({ success: true, ...(warnings.length > 0 ? { warnings } : {}) });
}
