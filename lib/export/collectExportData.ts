import { supabase } from "@/lib/supabase/client";
import { resolveParts, type ExportData, type ExportParts } from "./exportTypes";

// Single source of truth for what goes into an export document, shared by
// the Word and PDF routes so the two downloads can't drift apart.
//
// promptsOnly = the Prompts step's export: per-beat image and video
// prompts only, skipping the ideas/script/thumbnail sections that the
// Generate step's full export includes.
export async function collectExportData(
  userId: string,
  projectId: string,
  opts: { promptsOnly: boolean; parts?: ExportParts },
): Promise<{ data: ExportData; filenameBase: string } | null> {
  const { promptsOnly, parts } = opts;
  const [projectRes, beatsRes, thumbsRes] = await Promise.all([
    supabase.from("projects").select("*").eq("id", projectId).eq("user_id", userId).single(),
    supabase.from("project_beats").select("*").eq("project_id", projectId).order("beat_number"),
    // Don't even query thumbnails for a prompts-only export.
    promptsOnly
      ? Promise.resolve({ data: null })
      : supabase.from("project_thumbnails").select("*").eq("project_id", projectId).order("position"),
  ]);

  if (projectRes.error) return null;
  const project = projectRes.data;

  const data: ExportData = {
    channelName: project.channel_name,
    selectedTopic: project.selected_topic,
    videoIdeas: promptsOnly ? undefined : project.video_ideas,
    script: promptsOnly ? undefined : project.script,
    wordCount: promptsOnly ? undefined : project.word_count,
    targetWordCount: promptsOnly ? undefined : project.target_word_count,
    beats: beatsRes.data?.map((b) => ({
      beatNumber: b.beat_number,
      scriptSegment: b.script_segment,
      imagePrompt: b.image_prompt,
      camera: b.camera,
      lighting: b.lighting,
      mood: b.mood,
      action: b.action,
      videoPrompt: b.video_prompt,
    })) ?? [],
    thumbnails: thumbsRes.data?.map((t) => ({
      position: t.position,
      title: t.title,
      visualConcept: t.visual_concept,
      textOverlay: t.text_overlay,
      emotionTrigger: t.emotion_trigger,
      stylePrompt: t.style_prompt,
    })) ?? [],
    parts,
  };

  // Name the file after what's actually in it, so an image-only and a
  // video-only export don't land in Downloads under the same name.
  const { image, video } = resolveParts(parts);
  const suffix = !promptsOnly
    ? "content"
    : image && video ? "prompts"
    : image ? "image_prompts"
    : "video_prompts";
  const channelName = project.channel_name?.replace(/\s+/g, "_") ?? "export";
  return { data, filenameBase: `${channelName}_${suffix}` };
}
