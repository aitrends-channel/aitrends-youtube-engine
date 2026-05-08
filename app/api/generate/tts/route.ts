import { generateTTS } from "@/lib/kie/tts";
import { uploadBuffer } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId, script, voiceId } = await req.json();

  if (!projectId || !script || !voiceId) {
    return Response.json({ error: "projectId, script, and voiceId are required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let cancelled = false;

  return new Response(
    new ReadableStream({
      async start(controller) {
        function send(data: object) {
          if (cancelled) return;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
          catch { cancelled = true; }
        }

        try {
          const audioBuffer = await generateTTS(
            script,
            voiceId,
            (current, total) => { send({ type: "progress", current, total }); },
            (msg) => { send({ type: "status", message: msg }); },
            user.id
          );

          send({ type: "status", message: "Uploading audio..." });
          const path = `${projectId}/voiceover_${Date.now()}.mp3`;
          const publicUrl = await uploadBuffer(path, audioBuffer, "audio/mpeg");

          const { error: dbError } = await supabase
            .from("projects")
            .update({ tts_url: publicUrl, tts_voice_id: voiceId, tts_cleaned_url: null })
            .eq("id", projectId)
            .eq("user_id", user.id);

          if (dbError) console.error("[TTS route] db update error:", dbError.message);

          await supabase.from("project_beats").update({ audio_url: null }).eq("project_id", projectId);

          send({ type: "done", url: publicUrl });
        } catch (err) {
          const message = err instanceof Error ? err.message : "TTS generation failed";
          console.error("[TTS route] error:", message, err);
          send({ type: "error", message });
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
      cancel() { cancelled = true; },
    }),
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } }
  );
}
