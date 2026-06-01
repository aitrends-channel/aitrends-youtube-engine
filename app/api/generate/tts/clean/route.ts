import { uploadBuffer, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 800;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");

  if (!projectId) return Response.json({ error: "projectId is required" }, { status: 400 });

  const audioBytes = await req.arrayBuffer();
  if (!audioBytes.byteLength) return Response.json({ error: "No audio data received" }, { status: 400 });

  const path = `${userFolderFor(user)}/${projectId}/voiceover-cleaned_${Date.now()}.mp3`;
  const publicUrl = await uploadBuffer(path, audioBytes, "audio/mpeg");

  const { error: dbError } = await supabase
    .from("projects")
    .update({ tts_cleaned_url: publicUrl })
    .eq("id", projectId)
    .eq("user_id", user.id);

  if (dbError) console.error("[TTS clean] db update error:", dbError.message);

  return Response.json({ url: publicUrl });
}
