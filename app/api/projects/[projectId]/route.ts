export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
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
