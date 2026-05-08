import { supabase } from "@/lib/supabase/client";
import { buildDocx } from "@/lib/export/docxExporter";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { projectId } = await req.json();

    const [projectRes, beatsRes, thumbsRes] = await Promise.all([
      supabase.from("projects").select("*").eq("id", projectId).eq("user_id", user.id).single(),
      supabase.from("project_beats").select("*").eq("project_id", projectId).order("beat_number"),
      supabase.from("project_thumbnails").select("*").eq("project_id", projectId).order("position"),
    ]);

    if (projectRes.error) {
      return new Response("Project not found", { status: 404 });
    }

    const project = projectRes.data;

    const buffer = await buildDocx({
      channelName: project.channel_name,
      selectedTopic: project.selected_topic,
      videoIdeas: project.video_ideas,
      script: project.script,
      wordCount: project.word_count,
      targetWordCount: project.target_word_count,
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
    });

    const channelName = project.channel_name?.replace(/\s+/g, "_") ?? "export";
    const filename = `${channelName}_content.docx`;

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed";
    return new Response(message, { status: 500 });
  }
}
