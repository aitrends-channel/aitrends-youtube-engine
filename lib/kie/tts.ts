import { getSettings } from "@/lib/settings";
import type { KieModel } from "@/lib/types";

const EL_BASE = "https://api.elevenlabs.io";
const TTS_MODEL = "eleven_turbo_v2_5";
const MAX_CHARS = 5000;
const DEV_MAX_CHARS = process.env.MAX_TTS_CHARS ? parseInt(process.env.MAX_TTS_CHARS, 10) : null;

function v(id: string, name: string, tags: string[]): KieModel {
  return { id, name, type: "tts", tags, previewUrl: `https://static.aiquickdraw.com/elevenlabs/voice/${id}.mp3` };
}

const VOICES: KieModel[] = [
  v("nPczCjzI2devNBz1zQrb", "Brian",     ["Male",   "Deep, Resonant"]),
  v("FGY2WhTYpPnrIDTdsKH5", "Laura",     ["Female", "Enthusiastic"]),
  v("TX3LPaxmHKxFdv7VOQHJ", "Liam",      ["Male",   "Energetic"]),
  v("N2lVS1w4EtoT3dr4eOWO", "Callum",    ["Male",   "Husky"]),
  v("EkK5I93UQWFDigLMpZcX", "James",     ["Male",   "Bold, Engaging"]),
  v("Z3R5wn05IrDiVCyEkUrK", "Arabella",  ["Female", "Mysterious"]),
  v("hpp4J3VqNfWAUOO0d1Us", "Bella",     ["Female", "Warm, Professional"]),
  v("uYXf8XasLslADfZ2MB4u", "Hope",      ["Female", "Bubbly, Energetic"]),
  v("gs0tAILXbY5DNrJrsM6F", "Jeff",      ["Male",   "Classy, Strong"]),
  v("DTKMou8ccj1ZaWGBiotd", "Jamahal",   ["Male",   "Vibrant, Natural"]),
  v("vBKc2FfBKJfcZNyEt1n6", "Finn",      ["Male",   "Youthful, Eager"]),
  v("DYkrAHD8iwork3YSUBbs", "Tom",       ["Male",   "Conversational"]),
  v("56AoDkrOh6qfVPDXZ7Pt", "Cassidy",   ["Female", "Crisp, Direct"]),
  v("lcMyyd2HUfFzxdCaC4Ta", "Lucy",      ["Female", "Fresh, Casual"]),
  v("6aDn1KB0hjpdcocrUkmq", "Tiffany",   ["Female", "Natural, Welcoming"]),
  v("Sq93GQT4X1lKDXsQcixO", "Felix",     ["Male",   "Warm, Positive"]),
  v("LruHrtVF6PSyGItzMNHS", "Benjamin",  ["Male",   "Deep, Calming"]),
  v("1wGbFxmAM3Fgw63G1zZJ", "Allison",   ["Female", "Calm, Soothing"]),
  v("MJ0RnG71ty4LH3dvNfSd", "Leon",      ["Male",   "Soothing, Grounded"]),
  v("NNl6r8mD7vthiJatiJt1", "Bradford",  ["Male",   "Expressive"]),
  v("Sm1seazb4gs7RSlUVw7c", "Anika",     ["Female", "Animated, Friendly"]),
  v("5l5f8iK3YPeGga21rQIX", "Adeline",   ["Female", "Conversational"]),
  v("aD6riP1btT197c6dACmy", "Rachel M",  ["Female", "British, Radio"]),
  v("AeRdCCKzvd23BpJoofzx", "Nathaniel", ["Male",   "British, Calm"]),
  v("BZgkqPqms7Kj9ulSkVzn", "Eve",       ["Female", "Authentic, Happy"]),
  v("6F5Zhi321D3Oq7v1oNT4", "Hank",      ["Male",   "Deep, Narrator"]),
  v("pPdl9cQBQq4p6mRkZy2Z", "Emma",      ["Female", "Adorable, Upbeat"]),
  v("nzeAacJi50IvxcyDnMXa", "Marshal",   ["Male",   "Friendly, Warm"]),
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
  const cleaned = text; // already normalized by caller
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

async function generateChunk(
  text: string,
  voiceId: string,
  apiKey: string,
  onStatus?: (msg: string) => void
): Promise<ArrayBuffer> {
  onStatus?.("Generating audio...");
  console.log(`[TTS] ElevenLabs direct | model: ${TTS_MODEL} | voice: ${voiceId} | chars: ${text.length}`);

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
    throw new Error(`ElevenLabs error ${res.status}: ${body}`);
  }

  return res.arrayBuffer();
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
  const apiKey = userId
    ? (await getSettings(userId)).elevenlabs_api_key
    : (process.env.ELEVENLABS_API_KEY ?? "");

  if (!apiKey) throw new Error("ElevenLabs API key not configured. Add it in Settings.");

  let normalized = normalizeText(text);
  if (DEV_MAX_CHARS && normalized.length > DEV_MAX_CHARS) {
    const cut = normalized.slice(0, DEV_MAX_CHARS);
    const lastSentence = cut.search(/[.!?][^.!?]*$/);
    normalized = lastSentence > 0 ? cut.slice(0, lastSentence + 1) : cut;
    console.log(`[TTS] Trimmed to ${normalized.length} chars (MAX_TTS_CHARS=${DEV_MAX_CHARS})`);
  }

  const chunks = splitIntoChunks(normalized);
  console.log(`[TTS] ${chunks.length} chunk(s) | chars: ${normalizeText(text).length} | voice: ${voiceId}`);

  if (chunks.length === 1) {
    onProgress?.(0, 1);
    const result = await generateChunk(chunks[0], voiceId, apiKey, onStatus);
    onProgress?.(1, 1);
    return result;
  }

  const buffers: ArrayBuffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length);
    onStatus?.(`Chunk ${i + 1} of ${chunks.length}...`);
    buffers.push(await generateChunk(chunks[i], voiceId, apiKey, onStatus));
  }
  onProgress?.(chunks.length, chunks.length);

  const totalBytes = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const buf of buffers) {
    combined.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return combined.buffer;
}
