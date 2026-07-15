import type { KieModel } from "@/lib/types";
import { getFreeUsageThisMonth } from "@/lib/freeUsage";

// Qwen3-TTS via Replicate — the SECOND free voiceover option, alongside
// the BYO Google path. Unlike Google/Cloudflare (user's own key), this
// one runs on HECLUS's Replicate token as a perk: the server-side
// REPLICATE_API_TOKEN env var pays for every synthesis, users configure
// nothing. A per-user monthly character cap (QWEN_TTS_MONTHLY_CAP)
// keeps the perk from being drained by one account.
//
// Calls the public qwen/qwen3-tts model by default; set
// REPLICATE_QWEN_DEPLOYMENT="owner/name" to route through a dedicated
// deployment (replicate.com/deployments) instead — same input/output,
// different endpoint.

export class QwenTTSError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "QwenTTSError";
  }
}

// Heclus-paid perk budget per user per month, in characters. Generous
// enough for several full voiceovers; env-overridable without a deploy.
export const QWEN_TTS_MONTHLY_CAP = Number(process.env.QWEN_TTS_MONTHLY_CAP ?? 100_000);

// Voice ids are prefixed "qwen/" so they can't collide with ElevenLabs or
// google/ ids and generateTTS can route on the prefix alone. The catalog
// is the English-suited subset of Qwen3-TTS's built-in speakers; first
// tag is the gender so the picker's Female/Male tabs classify them.
function qv(speaker: string, label: string, tags: string[]): KieModel {
  const id = `qwen/${speaker}`;
  return {
    id,
    name: label,
    type: "tts",
    tags,
    previewUrl: `/api/generate/tts/preview?voice=${encodeURIComponent(id)}`,
  };
}

export const QWEN_VOICES: KieModel[] = [
  qv("Cherry",   "Cherry",   ["Female", "Warm"]),
  qv("Jennifer", "Jennifer", ["Female", "US"]),
  qv("Katerina", "Katerina", ["Female", "Mature"]),
  qv("Sunny",    "Sunny",    ["Female", "Bright"]),
  qv("Ethan",    "Ethan",    ["Male", "US"]),
  qv("Ryan",     "Ryan",     ["Male", "Energetic"]),
  qv("Elias",    "Elias",    ["Male", "Narration"]),
  qv("Dylan",    "Dylan",    ["Male", "Casual"]),
];

export function isQwenVoice(voiceId: string): boolean {
  return voiceId.startsWith("qwen/");
}

// Keep requests comfortably under model input limits; chunk on sentence
// boundaries like the Google path.
const QWEN_MAX_CHARS = 2000;

function splitForQwen(text: string): string[] {
  if (text.length <= QWEN_MAX_CHARS) return [text];
  const chunks: string[] = [];
  const sentences = text.match(/[^.!?]+[.!?]+|\s*\S+\s*$/g) ?? [text];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > QWEN_MAX_CHARS && current) {
      chunks.push(current);
      current = "";
    }
    if (s.length > QWEN_MAX_CHARS) {
      for (let i = 0; i < s.length; i += QWEN_MAX_CHARS) chunks.push(s.slice(i, i + QWEN_MAX_CHARS));
    } else {
      current += s;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Model input for one synthesis. Isolated so the field names have ONE
// place to change — verify against the live schema with
// scripts/check-qwen-tts.mjs once REPLICATE_API_TOKEN is set.
function buildInput(text: string, speaker: string): Record<string, unknown> {
  return {
    text,
    voice: speaker,
    mode: "voice",           // built-in speaker mode (vs clone / design)
    language: "Auto",
  };
}

interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: string | null;
  urls?: { get?: string };
}

function predictionEndpoint(): string {
  const deployment = (process.env.REPLICATE_QWEN_DEPLOYMENT ?? "").trim();
  if (deployment) {
    return `https://api.replicate.com/v1/deployments/${deployment}/predictions`;
  }
  return "https://api.replicate.com/v1/models/qwen/qwen3-tts/predictions";
}

// Extract the audio URL from whatever shape the model returns (bare URL
// string, {audio: url}, or [url]).
function audioUrlFrom(output: unknown): string | null {
  if (typeof output === "string" && output.startsWith("http")) return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    for (const k of ["audio", "audio_url", "url", "wav", "output"]) {
      if (typeof o[k] === "string" && (o[k] as string).startsWith("http")) return o[k] as string;
    }
  }
  return null;
}

async function synthChunk(text: string, speaker: string, token: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(predictionEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Hold the connection until the prediction settles (up to 60s);
        // we still poll below in case it takes longer.
        Prefer: "wait=60",
      },
      body: JSON.stringify({ input: buildInput(text, speaker) }),
    });
  } catch (err) {
    throw new QwenTTSError(`Replicate network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new QwenTTSError("Replicate auth failed — the server's REPLICATE_API_TOKEN is missing or invalid.", res.status);
  }
  if (res.status === 402) {
    throw new QwenTTSError("Replicate account is out of credit. Free Qwen voices are temporarily unavailable.", 402);
  }
  if (res.status === 429) {
    throw new QwenTTSError("Replicate is rate-limiting requests. Try again in a moment.", 429);
  }
  if (!res.ok && res.status !== 201) {
    const body = await res.text().catch(() => "");
    throw new QwenTTSError(`Replicate error ${res.status}: ${body.replace(/\s+/g, " ").trim().slice(0, 300)}`, res.status);
  }

  let prediction = (await res.json().catch(() => null)) as ReplicatePrediction | null;
  if (!prediction?.id) throw new QwenTTSError("Replicate returned an unexpected response.");

  // Poll until terminal (Prefer: wait usually returns settled already).
  const deadline = Date.now() + 120_000;
  while (prediction.status === "starting" || prediction.status === "processing") {
    if (Date.now() > deadline) throw new QwenTTSError("Qwen TTS timed out. Try again.", 504);
    await new Promise((r) => setTimeout(r, 1500));
    const pollUrl = prediction.urls?.get ?? `https://api.replicate.com/v1/predictions/${prediction.id}`;
    const poll = await fetch(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!poll.ok) throw new QwenTTSError(`Replicate poll failed (${poll.status}).`, poll.status);
    prediction = (await poll.json()) as ReplicatePrediction;
  }

  if (prediction.status !== "succeeded") {
    throw new QwenTTSError(`Qwen TTS failed: ${(prediction.error ?? "unknown error").toString().slice(0, 300)}`);
  }
  const url = audioUrlFrom(prediction.output);
  if (!url) throw new QwenTTSError("Qwen TTS succeeded but returned no audio URL.");

  const audioRes = await fetch(url);
  if (!audioRes.ok) throw new QwenTTSError(`Failed to download Qwen audio (${audioRes.status}).`);
  return audioRes.arrayBuffer();
}

export async function generateQwenTTS(
  text: string,
  voiceId: string,
  userId?: string,
): Promise<{ audio: ArrayBuffer; charsConsumed: number }> {
  if (!userId) throw new QwenTTSError("Sign in to use free voiceover.", 401);
  const token = (process.env.REPLICATE_API_TOKEN ?? "").trim();
  if (!token) {
    throw new QwenTTSError("Free Qwen voices aren't configured on this server yet (REPLICATE_API_TOKEN).", 503);
  }

  // Per-user monthly perk budget — Heclus pays for these characters, so
  // enforce OUR cap up front (Google's equivalent is enforced by Google).
  const used = await getFreeUsageThisMonth(userId, "qwen_tts_chars");
  if (used + text.length > QWEN_TTS_MONTHLY_CAP) {
    throw new QwenTTSError(
      `This voiceover needs ${text.length.toLocaleString()} characters but you have ${Math.max(0, QWEN_TTS_MONTHLY_CAP - used).toLocaleString()} left on this month's free Qwen quota. It resets next month — or pick a Google or paid voice.`,
      429,
    );
  }

  const speaker = voiceId.replace(/^qwen\//, "");
  const chunks = splitForQwen(text);
  const buffers: ArrayBuffer[] = [];
  let totalChars = 0;
  for (const chunk of chunks) {
    buffers.push(await synthChunk(chunk, speaker, token));
    totalChars += chunk.length;
  }

  // Byte-concatenate the chunks — same approach as the other providers.
  // (Single-chunk synth is the overwhelmingly common case: beats are
  // short. Multi-chunk concatenated WAVs still decode fine in ffmpeg,
  // which reads the first header and streams the rest as data.)
  const totalLength = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    merged.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return { audio: merged.buffer, charsConsumed: totalChars };
}
