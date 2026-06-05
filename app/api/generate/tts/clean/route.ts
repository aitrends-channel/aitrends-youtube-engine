import { createPresignedUpload, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Two-step upload because Vercel functions cap request bodies at ~4.5MB
// and trimmed voiceovers easily exceed that.
//
//   POST /api/generate/tts/clean       → returns { uploadUrl, publicUrl }
//                                        browser PUTs the MP3 directly
//                                        to R2 (no Vercel hop).
//   POST /api/generate/tts/clean
//     ?finalize=1&projectId=...
//     body: { publicUrl }              → updates tts_cleaned_url on the
//                                        project row, returns { url }.

export const maxDuration = 30;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  if (!projectId) return Response.json({ error: "projectId is required" }, { status: 400 });

  // Finalize path — small JSON body, fits inside Vercel's limit.
  if (searchParams.get("finalize") === "1") {
    const body = await req.json().catch(() => ({})) as { publicUrl?: string };
    if (!body.publicUrl) return Response.json({ error: "publicUrl is required" }, { status: 400 });

    const { error: dbError } = await supabase
      .from("projects")
      .update({ tts_cleaned_url: body.publicUrl })
      .eq("id", projectId)
      .eq("user_id", user.id);
    if (dbError) {
      console.error("[TTS clean finalize] db update error:", dbError.message);
      return Response.json({ error: dbError.message }, { status: 500 });
    }
    return Response.json({ url: body.publicUrl });
  }

  // Presign path — returns a short-lived PUT URL the browser can use
  // to upload the MP3 directly to R2.
  const path = `${userFolderFor(user)}/${projectId}/voiceover-cleaned_${Date.now()}.mp3`;
  const { uploadUrl, publicUrl } = await createPresignedUpload(path, "audio/mpeg");
  return Response.json({ uploadUrl, publicUrl, path });
}
