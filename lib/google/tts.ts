import { getSettings } from "@/lib/settings";
import type { KieModel } from "@/lib/types";

// Google Cloud Text-to-Speech — free voiceover via the USER's own account
// (BYO), drawing on their free 1,000,000 WaveNet chars/month quota so
// aiTrends pays nothing. Synchronous JSON API returning base64 MP3, which
// slots into the same { audio, charsConsumed } contract the ElevenLabs
// path uses, so the caller's upload flow is unchanged.

export class GoogleTTSError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "GoogleTTSError";
  }
}

// Voice ids are prefixed "google/" so they can't collide with ElevenLabs
// voice ids and generateTTS can route on the prefix alone. previewUrl
// points at the on-demand preview route so the voice cards get a working
// play button (synthesized on the user's own key). The picker renders a
// themed "- free" suffix off the google/ id — kept out of the name here so
// only the suffix (not the whole name) carries the theme color.
function gv(name: string, label: string, tags: string[]): KieModel {
  const id = `google/${name}`;
  return {
    id,
    name: label,
    type: "tts",
    tags,
    previewUrl: `/api/generate/tts/preview?voice=${encodeURIComponent(id)}`,
  };
}

// Google's Neural2 English voices — all share the same 1M-chars/month free
// tier, so the "1M free" promise holds uniformly. (Studio voices are
// deliberately excluded: they're a separate, much smaller free tier.)
export const GOOGLE_VOICES: KieModel[] = [
  gv("en-US-Neural2-C",  "Cora",     ["Female", "US"]),
  gv("en-US-Neural2-F",  "Fern",     ["Female", "US"]),
  gv("en-US-Neural2-D",  "Dan",      ["Male", "US"]),
  gv("en-US-Neural2-J",  "Jasper",   ["Male", "US"]),
  gv("en-GB-Neural2-A",  "Amelia",   ["Female", "British"]),
  gv("en-GB-Neural2-B",  "Bennett",  ["Male", "British"]),
  gv("en-AU-Neural2-A",  "Ava",      ["Female", "Australian"]),
];

export function isGoogleVoice(voiceId: string): boolean {
  return voiceId.startsWith("google/");
}

// Google's synthesize endpoint caps input at 5000 bytes; chunk under that.
const GOOGLE_MAX_CHARS = 4500;

function splitForGoogle(text: string): string[] {
  if (text.length <= GOOGLE_MAX_CHARS) return [text];
  const chunks: string[] = [];
  // Split on sentence boundaries, packing sentences up to the limit.
  const sentences = text.match(/[^.!?]+[.!?]+|\s*\S+\s*$/g) ?? [text];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > GOOGLE_MAX_CHARS && current) {
      chunks.push(current);
      current = "";
    }
    // A single sentence longer than the limit is hard-split.
    if (s.length > GOOGLE_MAX_CHARS) {
      for (let i = 0; i < s.length; i += GOOGLE_MAX_CHARS) chunks.push(s.slice(i, i + GOOGLE_MAX_CHARS));
    } else {
      current += s;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function synthChunk(text: string, name: string, languageCode: string, apiKey: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, name },
        audioConfig: { audioEncoding: "MP3" },
      }),
    });
  } catch (err) {
    throw new GoogleTTSError(`Google TTS network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new GoogleTTSError("Google TTS auth failed. Check your Google Cloud TTS key in Settings (and that the Text-to-Speech API is enabled).", res.status);
    }
    if (res.status === 429) {
      throw new GoogleTTSError("You've hit your Google Cloud TTS free monthly limit. It resets next month, or pick a paid voice.", 429);
    }
    throw new GoogleTTSError(`Google TTS error ${res.status}: ${body.replace(/\s+/g, " ").trim().slice(0, 300)}`, res.status);
  }

  const data = (await res.json().catch(() => null)) as { audioContent?: string } | null;
  if (!data?.audioContent) throw new GoogleTTSError("Google TTS returned no audio.");
  return Uint8Array.from(Buffer.from(data.audioContent, "base64")).buffer;
}

export async function generateGoogleTTS(
  text: string,
  voiceId: string,
  userId?: string,
): Promise<{ audio: ArrayBuffer; charsConsumed: number }> {
  if (!userId) throw new GoogleTTSError("Sign in to use free voiceover.", 401);
  const { google_tts_key } = await getSettings(userId);
  if (!google_tts_key) {
    throw new GoogleTTSError("Connect your Google Cloud TTS key in Settings to use free voiceover.", 401);
  }

  const name = voiceId.replace(/^google\//, "");
  // "en-US-Neural2-C" → "en-US"; fall back to en-US if the shape is odd.
  const parts = name.split("-");
  const languageCode = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "en-US";

  const chunks = splitForGoogle(text);
  const buffers: ArrayBuffer[] = [];
  let totalChars = 0;
  for (const chunk of chunks) {
    buffers.push(await synthChunk(chunk, name, languageCode, google_tts_key));
    totalChars += chunk.length;
  }

  // Byte-concatenate the MP3 chunks — same approach as the ElevenLabs path.
  const totalLength = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    merged.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return { audio: merged.buffer, charsConsumed: totalChars };
}
