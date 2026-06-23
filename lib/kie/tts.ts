import { getSettings } from "@/lib/settings";
import type { KieModel } from "@/lib/types";

// Direct ElevenLabs TTS. Used to go through KIE's proxy (commit b5b38ac)
// for a bigger voice catalog at lower cost on long chunks, but per-beat
// splitting flipped the per-task economics — KIE's flat per-call fee
// got paid hundreds of times on tiny segments where ElevenLabs' per-
// char billing is cheaper. The file lives under lib/kie/ for path
// stability across the many call sites; the implementation no longer
// touches KIE.

const EL_BASE = "https://api.elevenlabs.io";
export const TTS_MODEL = "eleven_turbo_v2_5";
const MAX_CHARS = 5000;
const CHUNK_RETRY_ATTEMPTS = 3;

function v(id: string, name: string, tags: string[]): KieModel {
  return { id, name, type: "tts", tags, previewUrl: `https://static.aiquickdraw.com/elevenlabs/voice/${id}.mp3` };
}

// Voice catalog kept at the full 82 entries from the KIE era. About 28
// of these are ElevenLabs "Premade" voices (Brian, Laura, Liam, etc.)
// that work for every account out of the box. The other ~54 are
// Voice Library entries that each user must explicitly add to their
// ElevenLabs account before they can synthesize with them — we
// surface a clear error directing them to the library if they hit
// one they haven't added.
const VOICES: KieModel[] = [
  v("eR40ATw9ArzDf9h3v7t7", "Addison 2.0",                          ["Female","Australian Audiobook & Podcast"]),
  v("5l5f8iK3YPeGga21rQIX", "Adeline",                              ["Female","Feminine and Conversational"]),
  v("1wGbFxmAM3Fgw63G1zZJ", "Allison",                              ["Female","Calm, Soothing and Meditative"]),
  v("wJqPPQ618aTW29mptyoc", "Ana Rita",                             ["Female","Smooth, Expressive and Bright"]),
  v("Sm1seazb4gs7RSlUVw7c", "Anika",                                ["Female","Animated, Friendly and Engaging"]),
  v("Z3R5wn05IrDiVCyEkUrK", "Arabella",                             ["Female","Mysterious and Emotive"]),
  v("TC0Zp7WVFzhA8zpTlRqV", "Aria",                                 ["Female","Sultry Villain"]),
  v("hpp4J3VqNfWAUOO0d1Us", "Bella",                                ["Female","Warm, Professional"]),
  v("esy0r39YPLQjOczyOib8", "Britney",                              ["Female","Calm and Calculative Villain"]),
  v("kPzsL2i3teMYv0FxEYQ6", "Brittney",                             ["Female","Social Media Voice - Fun, Youthful & Informative"]),
  v("56AoDkrOh6qfVPDXZ7Pt", "Cassidy",                              ["Female","Crisp, Direct and Clear"]),
  v("pPdl9cQBQq4p6mRkZy2Z", "Emma",                                 ["Female","Adorable and Upbeat"]),
  v("BZgkqPqms7Kj9ulSkVzn", "Eve",                                  ["Female","Authentic, Energetic and Happy"]),
  v("uYXf8XasLslADfZ2MB4u", "Hope",                                 ["Female","Bubbly, Gossipy and Girly"]),
  v("iCrDUkL56s3C8sCRl7wb", "Hope",                                 ["Female","Poetic, Romantic and Captivating"]),
  v("eVItLK1UvXctxuaRV2Oq", "Jean",                                 ["Female","Alluring and Playful Femme Fatale"]),
  v("g6xIsTj2HwM6VR4iXFCw", "Jessica Anne Bogart",                  ["Female","Chatty and Friendly"]),
  v("flHkNRp1BlvT73UL6gyz", "Jessica Anne Bogart",                  ["Female","Eloquent Villain"]),
  v("B8gJV1IhpuegLxdpXFOE", "Kuon",                                 ["Female","Cheerful, Clear and Steady"]),
  v("FGY2WhTYpPnrIDTdsKH5", "Laura",                                ["Female","Enthusiastic"]),
  v("lcMyyd2HUfFzxdCaC4Ta", "Lucy",                                 ["Female","Fresh & Casual"]),
  v("2zRM7PkgwBPiau2jvVXc", "Monika Sogam",                         ["Female","Deep and Natural"]),
  v("aD6riP1btT197c6dACmy", "Rachel M",                             ["Female","Pro British Radio Presenter"]),
  v("6aDn1KB0hjpdcocrUkmq", "Tiffany",                              ["Female","Natural and Welcoming"]),
  v("LruHrtVF6PSyGItzMNHS", "Benjamin",                             ["Male","Deep, Warm, Calming"]),
  v("NNl6r8mD7vthiJatiJt1", "Bradford",                             ["Male","Expressive and Articulate"]),
  v("nPczCjzI2devNBz1zQrb", "Brian",                                ["Male","Deep, Resonant"]),
  v("gU0LNdkMOQCOrPrwtbee", "British Football Announcer",           ["Male","Excited, Characters animation"]),
  v("DGzg6RaUqxGRTHSBjfgF", "Brock",                                ["Male","Commanding and Loud Sergeant"]),
  v("4YYIPFl9wE5c4L2eu2Gb", "Burt Reynolds",                        ["Male","Deep, Smooth and Clear"]),
  v("N2lVS1w4EtoT3dr4eOWO", "Callum",                               ["Male","Husky"]),
  v("dHd5gvgSOzSfduK4CvEg", "Ed",                                   ["Male","Late Night Announcer"]),
  v("zYcjlYFOd3taleS0gkk3", "Edward",                               ["Male","Loud, Confident and Cocky"]),
  v("Sq93GQT4X1lKDXsQcixO", "Felix",                                ["Male","Warm, Positive & Contemporary RP"]),
  v("vBKc2FfBKJfcZNyEt1n6", "Finn",                                 ["Male","Youthful, Eager and Energetic"]),
  v("6F5Zhi321D3Oq7v1oNT4", "Hank",                                 ["Male","Deep and Engaging Narrator"]),
  v("DTKMou8ccj1ZaWGBiotd", "Jamahal",                              ["Male","Young, Vibrant, and Natural"]),
  v("EkK5I93UQWFDigLMpZcX", "James",                                ["Male","Husky, Engaging and Bold"]),
  v("gs0tAILXbY5DNrJrsM6F", "Jeff",                                 ["Male","Classy, Resonating and Strong"]),
  v("EiNlNiXeDU1pqqOPrYMO", "John Doe",                             ["Male","Deep"]),
  v("ruirxsoakN0GWmGNIo04", "John Morgan",                          ["Male","Gritty, Rugged Cowboy"]),
  v("CeNX9CMwmxDxUF5Q2Inm", "Johnny Dynamite",                      ["Male","Vintage Radio DJ"]),
  v("8JVbfL6oEdmuxKn5DK2C", "Johnny Kid",                           ["Male","Serious and Calm Narrator"]),
  v("MJ0RnG71ty4LH3dvNfSd", "Leon",                                 ["Male","Soothing and Grounded"]),
  v("TX3LPaxmHKxFdv7VOQHJ", "Liam",                                 ["Male","Energetic"]),
  v("9yzdeviXkFddZ4Oz8Mok", "Lutz",                                 ["Male","Chuckling, Giggly and Cheerful"]),
  v("1SM7GgM6IMuvQlz2BwM3", "Mark",                                 ["Male","Casual, Relaxed and Light"]),
  v("UgBBYS2sOqTuMpoF3BR0", "Mark",                                 ["Male","Natural Conversations"]),
  v("nzeAacJi50IvxcyDnMXa", "Marshal",                              ["Male","Friendly, Funny Professor"]),
  v("x70vRnQBMBu4FAYhjJbO", "Nathan",                               ["Male","Confident Virtual Radio Host"]),
  v("AeRdCCKzvd23BpJoofzx", "Nathaniel",                            ["Male","Engaging, British and Calm"]),
  v("wo6udizrrtpIxWGp2qJk", "Northern Terry",                       ["Male","Husky, Characters animation"]),
  v("LG95yZDEHg6fCZdQjLqj", "Phil",                                 ["Male","Explosive, Passionate Announcer"]),
  v("PPzYpIqttlTYA83688JI", "Pirate Marshal",                       ["Male","Upbeat, Characters animation"]),
  v("mtrellq69YZsNwzUSyXh", "Rex Thunder",                          ["Male","Deep N Tough"]),
  v("scOwDtmlUjD3prqpp97I", "Sam",                                  ["Male","Support Agent"]),
  v("NOpBlnGInO9m6vDvFkFC", "Spuds Oxley",                          ["Male","Wise and Approachable"]),
  v("Tsns2HvNFKfGiNjllgqo", "Sven",                                 ["Male","Emotional and Nice"]),
  v("qDuRKMlYmrm8trt5QyBn", "Taksh",                                ["Male","Calm, Serious and Smooth"]),
  v("hqfrgApggtO1785R4Fsn", "Theodore HQ",                          ["Male","Serene and Grounded"]),
  v("DYkrAHD8iwork3YSUBbs", "Tom",                                  ["Male","Conversations & Books"]),
  v("ljo9gAlSqKOvF6D8sOsX", "Viking Bjorn",                         ["Male","Epic Medieval Raider"]),
  v("P1bg08DkjqiVEzOn76yG", "Viraj",                                ["Male","Rich and Soft"]),
  v("1U02n4nD6AdIZ9CjF053", "Viraj",                                ["Male","Smooth and Gentle"]),
  v("YXpFCvM1S3JbWEJhoskW", "Wyatt",                                ["Male","Wise Rustic Cowboy"]),
  v("YOq2y2Up4RgXP2HyXjE5", "Xavier",                               ["Male","Dominating, Metalic Announcer"]),
  v("qXpMhyvQqiRxWQs4qSSB", "Horatius",                             ["Neutral","Energetic Character Voice"]),
];

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .replace(/'|'/g, "'")
    .replace(/"|"/g, '"')
    .replace(/…/g, "...")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function splitIntoChunks(text: string): string[] {
  const cleaned = text;
  if (cleaned.length <= MAX_CHARS) return [cleaned];

  const chunks: string[] = [];
  let remaining = cleaned;

  while (remaining.length > MAX_CHARS) {
    let cutAt = MAX_CHARS;
    const searchFrom = Math.floor(MAX_CHARS * 0.75);
    const sentenceMatch = remaining.slice(searchFrom, MAX_CHARS).match(/[.!?]\s/);
    if (sentenceMatch?.index !== undefined) {
      cutAt = searchFrom + sentenceMatch.index + 1;
    } else {
      const lastSpace = remaining.lastIndexOf(" ", MAX_CHARS);
      if (lastSpace > 0) cutAt = lastSpace;
    }
    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// Parse ElevenLabs' error body — they nest the actual message under
// `detail.message` or `detail` (string) or `message`. We surface the
// inner string so the UI shows "voice_not_found: ..." rather than
// "ElevenLabs error 400".
function extractElError(body: string, status: number): { message: string; status: number; code?: string } {
  let message = `ElevenLabs error ${status}`;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(body) as { detail?: { message?: string; status?: string } | string; message?: string };
    if (typeof parsed.detail === "object" && parsed.detail) {
      if (typeof parsed.detail.message === "string") message = parsed.detail.message;
      if (typeof parsed.detail.status === "string") code = parsed.detail.status;
    } else if (typeof parsed.detail === "string") {
      message = parsed.detail;
    } else if (typeof parsed.message === "string") {
      message = parsed.message;
    }
  } catch { /* fall through with default */ }
  return { message, status, code };
}

async function generateChunk(
  text: string,
  voiceId: string,
  apiKey: string,
  onStatus?: (msg: string) => void,
): Promise<{ audio: ArrayBuffer; charsConsumed: number }> {
  onStatus?.("Generating audio…");
  const tStart = Date.now();
  console.log(`[TTS] EL direct | model: ${TTS_MODEL} | voice: ${voiceId} | chars: ${text.length}`);

  const res = await fetch(`${EL_BASE}/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const err = extractElError(body, res.status);
    // Voice-not-found is the specific failure mode for Voice Library
    // entries the user hasn't added to their account yet. Surface
    // actionable guidance so they know exactly where to fix it
    // rather than seeing a generic 400. KIE didn't gate on this so
    // every voice "just worked" — direct EL does, and the per-voice
    // failure is the cost of going direct (Option A in the migration
    // tradeoff).
    if (res.status === 400 && /voice.*not.*found|voice_not_found/i.test(err.message)) {
      throw new Error(
        `Voice ${voiceId} is not in your ElevenLabs library. Add it from ` +
        `https://elevenlabs.io/app/voice-library and try again.`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`ElevenLabs auth failed (${res.status}). Check your API key in Settings.`);
    }
    throw new Error(err.message);
  }

  const audio = await res.arrayBuffer();
  console.log(`[TTS-timing] voice=${voiceId} chars=${text.length} total=${Date.now() - tStart}ms`);
  return { audio, charsConsumed: text.length };
}

// Retry wrapper — direct EL clears most transients in 1-2 attempts.
// Tighter backoff than the KIE version (2/5/10s vs 5/15/30s) because
// EL's "internal_error" / rate-limit windows are much shorter. Bails
// fast on auth, voice-not-found, and unsupported-voice errors since
// those won't change with retry.
async function generateChunkWithRetry(
  text: string,
  voiceId: string,
  apiKey: string,
  onStatus?: (msg: string) => void,
): Promise<{ audio: ArrayBuffer; charsConsumed: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < CHUNK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await generateChunk(text, voiceId, apiKey, onStatus);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/not in your ElevenLabs library|auth failed|api key|unauthorized|forbidden|invalid_voice/i.test(msg)) {
        throw err;
      }
      if (attempt === CHUNK_RETRY_ATTEMPTS - 1) break;
      const delay = attempt === 0 ? 2000 : attempt === 1 ? 5000 : 10000;
      console.warn(`[TTS] chunk attempt ${attempt + 1}/${CHUNK_RETRY_ATTEMPTS} failed: ${msg}; retrying in ${delay}ms`);
      onStatus?.(`Retrying (${attempt + 2}/${CHUNK_RETRY_ATTEMPTS})…`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export async function listTTSVoices(): Promise<KieModel[]> {
  return VOICES;
}

export async function generateTTS(
  text: string,
  voiceId: string,
  onProgress?: (current: number, total: number) => void,
  onStatus?: (msg: string) => void,
  userId?: string,
): Promise<{ audio: ArrayBuffer; charsConsumed: number }> {
  const apiKey = userId
    ? (await getSettings(userId)).elevenlabs_api_key
    : (process.env.ELEVENLABS_API_KEY ?? "");
  if (!apiKey) throw new Error("ElevenLabs API key not configured. Add it in Settings.");

  const normalized = normalizeText(text);
  const chunks = splitIntoChunks(normalized);
  console.log(`[TTS] ${chunks.length} chunk(s) | chars: ${normalized.length} | voice: ${voiceId}`);

  if (chunks.length === 1) {
    onProgress?.(0, 1);
    const result = await generateChunkWithRetry(chunks[0], voiceId, apiKey, onStatus);
    onProgress?.(1, 1);
    return result;
  }

  const buffers: ArrayBuffer[] = [];
  let totalChars = 0;
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length);
    onStatus?.(`Chunk ${i + 1} of ${chunks.length}…`);
    const result = await generateChunkWithRetry(chunks[i], voiceId, apiKey, onStatus);
    buffers.push(result.audio);
    totalChars += result.charsConsumed;
  }
  onProgress?.(chunks.length, chunks.length);

  const totalLength = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    merged.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return { audio: merged.buffer, charsConsumed: totalChars };
}
