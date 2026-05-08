import { kieRequest } from "./client";
import type { KieModel } from "@/lib/types";

// Switch to "elevenlabs/text-to-speech-turbo-2-5" for faster generation at slightly lower quality
const TTS_MODEL = "elevenlabs/text-to-speech-multilingual-v2";

// ElevenLabs actual limit is 5000 chars; no need for the previous conservative buffer
const MAX_CHARS = 5000;

// ElevenLabs voice IDs confirmed to work via KIE.
// Preview format: https://static.aiquickdraw.com/elevenlabs/voice/<id>.mp3
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

// ── Text helpers ──────────────────────────────────────────────────────────────

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
  const cleaned = normalizeText(text);
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

// ── KIE task types ────────────────────────────────────────────────────────────

interface KieTaskResponse {
  code: number;
  msg: string;
  data: { taskId: string };
}

interface KieRecordResponse {
  code: number;
  data: {
    state?: string;
    resultJson?: string;
    failMsg?: string;
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── KIE ElevenLabs TTS ────────────────────────────────────────────────────────

async function generateChunk(
  text: string,
  voiceId: string,
  userId?: string,
  onStatus?: (msg: string) => void
): Promise<ArrayBuffer> {
  onStatus?.("Generating audio...");
  console.log(`[TTS] KIE request | model: ${TTS_MODEL} | voice: ${voiceId} | chars: ${text.length}`);

  const res = await kieRequest<KieTaskResponse>("/api/v1/jobs/createTask", {
    method: "POST",
    body: JSON.stringify({
      model: TTS_MODEL,
      input: {
        text,
        voice: voiceId,
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  }, userId);

  if (res.code !== 200) throw new Error(res.msg ?? "Failed to create TTS task");
  const { taskId } = res.data;

  for (let i = 0; i < 60; i++) {
    await sleep(3000);

    const poll = await kieRequest<KieRecordResponse>(
      `/api/v1/jobs/recordInfo?taskId=${taskId}`,
      {},
      userId
    );
    const state = (poll.data?.state ?? "").toLowerCase();

    if (state === "success") {
      let audioUrl: string | undefined;
      const rj = poll.data?.resultJson;
      if (typeof rj === "string") {
        if (rj.startsWith("http")) {
          audioUrl = rj;
        } else {
          try {
            const parsed = JSON.parse(rj) as { resultUrls?: string[]; url?: string };
            audioUrl = parsed.resultUrls?.[0] ?? parsed.url;
          } catch { /* fall through */ }
        }
      }
      if (!audioUrl) throw new Error("TTS task completed but no audio URL in response");

      console.log(`[TTS] KIE success | voice: ${voiceId}`);
      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) throw new Error(`Failed to download audio (${audioRes.status})`);
      return audioRes.arrayBuffer();
    }

    if (state === "fail") {
      throw new Error(poll.data?.failMsg ?? "TTS generation failed");
    }
  }

  throw new Error("TTS generation timed out after 3 minutes");
}

// ── Public API ────────────────────────────────────────────────────────────────

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
  const chunks = splitIntoChunks(text);
  console.log(`[TTS] ${chunks.length} chunk(s) | cleaned chars: ${normalizeText(text).length} | voice: ${voiceId}`);

  if (chunks.length === 1) {
    onProgress?.(0, 1);
    const result = await generateChunk(chunks[0], voiceId, userId, onStatus);
    onProgress?.(1, 1);
    return result;
  }

  const buffers: ArrayBuffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length);
    onStatus?.(`Chunk ${i + 1} of ${chunks.length}...`);
    buffers.push(await generateChunk(chunks[i], voiceId, userId, onStatus));
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
