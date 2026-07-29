import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { generateQwenTTS, isQwenVoice, QwenTTSError } from "@/lib/replicate/tts";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// On-demand preview for the Qwen voices, which have no static sample URL.
// Synthesizes one short sentence and caches it per user.
const SAMPLE = "Hi — here's a quick sample of how this voice sounds narrating your script.";

export async function GET(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const voice = new URL(req.url).searchParams.get("voice") ?? "";
  if (!isQwenVoice(voice)) {
    return NextResponse.json({ error: "A qwen/ voice id is required." }, { status: 400 });
  }

  try {
    const { audio } = await generateQwenTTS(SAMPLE, voice, user.id);
    return new NextResponse(Buffer.from(audio), {
      headers: {
        "Content-Type": "audio/mpeg",
        // Cache per-user so re-clicking a voice doesn't burn quota again.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    if (err instanceof QwenTTSError) {
      const status = err.status === 401 ? 401 : err.status === 429 ? 429 : 502;
      return NextResponse.json({ error: err.message }, { status });
    }
    const message = err instanceof Error ? err.message : "Preview failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
