import { kieRequest } from "./client";
import type { KieModel } from "@/lib/types";

const TTS_MODEL = "elevenlabs/text-to-speech-turbo-2-5";
const MAX_CHARS = 5000;
const POLL_INTERVAL_MS = 1000;
const POLL_DEADLINE_MS = 5 * 60 * 1000; // 5 minutes per chunk
const CHUNK_RETRY_ATTEMPTS = 3;

function v(id: string, name: string, tags: string[]): KieModel {
  return { id, name, type: "tts", tags, previewUrl: `https://static.aiquickdraw.com/elevenlabs/voice/${id}.mp3` };
}

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

interface KieTaskResponse {
  code: number;
  msg: string;
  data: { taskId: string };
}

interface KieRecordResponse {
  code: number;
  data: {
    state?: string;
    status?: string;
    resultJson?: string;
    output?: string | string[];
    // KIE actually returns failMsg/failCode; failReason/error are
    // kept for forward-compat in case they ever add them.
    failMsg?: string;
    failCode?: string;
    failReason?: string;
    error?: string;
  };
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function extractAudioUrl(d: KieRecordResponse["data"] | undefined): string | undefined {
  if (!d) return undefined;
  if (typeof d.resultJson === "string") {
    try {
      const parsed = JSON.parse(d.resultJson) as { resultUrls?: string[]; url?: string; audioUrl?: string };
      const url = parsed.resultUrls?.[0] ?? parsed.url ?? parsed.audioUrl;
      if (url) return url;
    } catch {
      if (d.resultJson.startsWith("http")) return d.resultJson;
    }
  }
  if (Array.isArray(d.output)) return d.output[0];
  if (typeof d.output === "string") return d.output;
  return undefined;
}

async function generateChunk(
  text: string,
  voiceId: string,
  userId: string | undefined,
  onStatus?: (msg: string) => void,
): Promise<ArrayBuffer> {
  onStatus?.("Submitting…");
  console.log(`[TTS] KIE submit | model: ${TTS_MODEL} | voice: ${voiceId} | chars: ${text.length}`);

  const submit = await kieRequest<KieTaskResponse>("/api/v1/jobs/createTask", {
    method: "POST",
    body: JSON.stringify({
      model: TTS_MODEL,
      input: {
        text,
        voice: voiceId,
        stability: 0.5,
        similarity_boost: 0.75,
        speed: 1,
      },
    }),
  }, userId);

  if (submit.code !== 200 || !submit.data?.taskId) {
    throw new Error(submit.msg || `TTS submit failed (${submit.code})`);
  }
  const taskId = submit.data.taskId;

  const DONE = ["succeed", "success", "completed", "done", "finish", "finished", "complete"];
  const FAIL = ["failed", "error", "fail"];
  const deadline = Date.now() + POLL_DEADLINE_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    onStatus?.("Generating…");

    const status = await kieRequest<KieRecordResponse>(
      `/api/v1/jobs/recordInfo?taskId=${taskId}`,
      {},
      userId,
    );
    const d = status.data;
    const state = (d?.state ?? d?.status ?? "").toLowerCase();

    if (DONE.includes(state) || FAIL.includes(state)) {
      // Reconnaissance log for cost tracking — dumps the full KIE
      // recordInfo payload at terminal state so we can identify
      // which field carries credits consumed. Fires once per task
      // (on done or failed), never on pending. Remove once
      // lib/pricing.ts knows the credit field.
      console.log(`[kie-cost-recon] tts state=${state} response=`, JSON.stringify(status));
    }

    if (DONE.includes(state)) {
      const url = extractAudioUrl(d);
      if (!url) throw new Error("TTS finished but no audio URL was returned");
      onStatus?.("Downloading…");
      const audioRes = await fetch(url);
      if (!audioRes.ok) throw new Error(`Failed to download audio: ${audioRes.status}`);
      return audioRes.arrayBuffer();
    }
    if (FAIL.includes(state)) {
      console.error(`[TTS] chunk failed | taskId=${taskId} | full data:`, JSON.stringify(d));
      // KIE returns failMsg + failCode (not failReason/error). Use
      // failMsg as the primary user-facing message; include failCode
      // for context. ElevenLabs' transient "internal error, please
      // try again later" lands here and is genuinely retryable.
      const detail = d?.failMsg ?? d?.failReason ?? d?.error ?? "no detail";
      const code = d?.failCode ? ` (${d.failCode})` : "";
      throw new Error(`TTS chunk failed${code}: ${detail}`);
    }
  }

  throw new Error("TTS generation timed out after 5 minutes");
}

// Retry wrapper around generateChunk — KIE TTS occasionally returns
// state=failed for transient reasons that clear within seconds.
// Exponential backoff (2s/4s/8s), 3 attempts. Fails fast on non-
// transient errors (auth, voice-not-found, etc.) since retrying
// won't help.
async function generateChunkWithRetry(
  text: string,
  voiceId: string,
  userId: string | undefined,
  onStatus?: (msg: string) => void,
): Promise<ArrayBuffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < CHUNK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await generateChunk(text, voiceId, userId, onStatus);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Non-transient errors — abort early.
      if (/voice|api key|unauthorized|forbidden|invalid/i.test(msg)) {
        throw err;
      }
      if (attempt === CHUNK_RETRY_ATTEMPTS - 1) break;
      // 5s / 15s / 30s — bigger gaps than the Claude retry path
      // because KIE TTS' "internal error, please try again later"
      // tends to need ~10-30s to clear, not 1-2s.
      const delay = attempt === 0 ? 5000 : attempt === 1 ? 15000 : 30000;
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
  userId?: string
): Promise<ArrayBuffer> {
  const normalized = normalizeText(text);
  const chunks = splitIntoChunks(normalized);
  console.log(`[TTS] ${chunks.length} chunk(s) | chars: ${normalized.length} | voice: ${voiceId}`);

  if (chunks.length === 1) {
    onProgress?.(0, 1);
    const result = await generateChunkWithRetry(chunks[0], voiceId, userId, onStatus);
    onProgress?.(1, 1);
    return result;
  }

  const buffers: ArrayBuffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length);
    onStatus?.(`Chunk ${i + 1} of ${chunks.length}…`);
    const buf = await generateChunkWithRetry(chunks[i], voiceId, userId, onStatus);
    buffers.push(buf);
  }
  onProgress?.(chunks.length, chunks.length);

  const totalLength = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    merged.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return merged.buffer;
}
