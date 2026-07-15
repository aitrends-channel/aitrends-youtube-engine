import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { generateGoogleTTS, isGoogleVoice, GoogleTTSError } from "@/lib/google/tts";
import { generateQwenTTS, isQwenVoice, QwenTTSError } from "@/lib/replicate/tts";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// On-demand voice preview for the free Google TTS voices. The voice-picker
// cards point their previewUrl here; the browser plays the returned audio
// directly. Synthesizes one short sample sentence on the user's own key
// (~a few dozen chars of their free quota) and caches it briefly so
// repeated previews of the same voice don't re-synthesize.
const SAMPLE = "Hi — here's a quick sample of how this voice sounds narrating your script.";

export async function GET(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const voice = new URL(req.url).searchParams.get("voice") ?? "";
  if (!isGoogleVoice(voice) && !isQwenVoice(voice)) {
    return NextResponse.json({ error: "A free (google/ or qwen/) voice id is required." }, { status: 400 });
  }

  try {
    const { audio } = isQwenVoice(voice)
      ? await generateQwenTTS(SAMPLE, voice, user.id)
      : await generateGoogleTTS(SAMPLE, voice, user.id);
    return new NextResponse(Buffer.from(audio), {
      headers: {
        "Content-Type": "audio/mpeg",
        // Cache per-user so re-clicking a voice doesn't burn quota again.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    if (err instanceof GoogleTTSError || err instanceof QwenTTSError) {
      const status = err.status === 401 ? 401 : err.status === 429 ? 429 : 502;
      return NextResponse.json({ error: err.message }, { status });
    }
    const message = err instanceof Error ? err.message : "Preview failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
