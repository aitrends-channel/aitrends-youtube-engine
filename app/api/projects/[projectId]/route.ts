export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { deleteFolder } from "@/lib/supabase/storage";
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
