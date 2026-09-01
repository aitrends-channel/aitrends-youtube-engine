import type { KieModel } from "@/lib/types";
import { entitlementTier, tierRank, ADMIN_PLAN } from "@/lib/plan-tier";
import { getFreeUsageThisMonth } from "@/lib/freeUsage";
import { supabase } from "@/lib/supabase/client";
import { isAdminUser } from "@/lib/admin";

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

// Heclus-paid perk budget per user per month, in characters — tiered by
// plan. Founders get no Qwen access at all (cap 0); admins count as Pro.
// Env-overridable without a deploy.
export const QWEN_TTS_CAP_STARTER = Number(process.env.QWEN_TTS_CAP_STARTER ?? 50_000);
export const QWEN_TTS_CAP_PRO = Number(process.env.QWEN_TTS_CAP_PRO ?? 100_000);

export function qwenCapForPlan(plan: string | null | undefined, isAdmin = false): number {
  // The highest cap defined. Add a tier with its own cap and it belongs here
  // too, or an admin silently drops to the tier below it.
  if (isAdmin) return QWEN_TTS_CAP_PRO;
  // Normalised, so heclus_pro takes the Pro cap. Callers reach this with a raw
  // app_metadata.plan as often as with a tier.
  const p = entitlementTier(plan);
  // make-admin stores plan="admin", which reaches here when the caller had no
  // isAdmin flag to pass.
  if (p === ADMIN_PLAN) return QWEN_TTS_CAP_PRO;
  if (p === "founder") return 0;
  // At-least, so a tier above Pro takes the Pro cap rather than falling
  // through to the entry-level one.
  if (tierRank(p) >= tierRank("pro")) return QWEN_TTS_CAP_PRO;
  // starter, demo, unknown → the entry-level cap.
  return QWEN_TTS_CAP_STARTER;
}

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

// The English-suited subset of the speakers the Replicate deployment
// actually exposes (verified against the live schema with
// scripts/check-qwen-tts.mjs — the full enum also has Ono_anna, Sohee,
// and Uncle_fu, which are Japanese/Korean/Chinese-dialect voices).
export const QWEN_VOICES: KieModel[] = [
  qv("Serena", "Serena", ["Female", "Warm"]),
  qv("Vivian", "Vivian", ["Female", "Bright"]),
  qv("Aiden",  "Aiden",  ["Male", "US"]),
  qv("Dylan",  "Dylan",  ["Male", "Casual"]),
  qv("Eric",   "Eric",   ["Male", "Narration"]),
  qv("Ryan",   "Ryan",   ["Male", "Energetic"]),
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

// Model input for one synthesis — field names verified against the live
// schema (scripts/check-qwen-tts.mjs): text, speaker (enum), mode
// ("custom_voice" = built-in speakers, vs voice_clone / voice_design),
// language (lowercase "auto" or a language name).
function buildInput(text: string, speaker: string): Record<string, unknown> {
  return {
    text,
    speaker,
    mode: "custom_voice",
    language: "auto",
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Replicate allows very little request concurrency on this account tier
// (a burst of 6 predictions → five 429s, measured). The beats route
// fires a whole batch of syntheses at once inside one function
// invocation, so gate prediction creation through a module-level queue:
// max 2 in flight, small gap between starts. Retries below remain the
// backstop for cross-invocation collisions (e.g. two users at once).
const MAX_INFLIGHT = 2;
const START_GAP_MS = 400;
let inflight = 0;
const waiters: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (inflight < MAX_INFLIGHT) { inflight++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inflight++;
}

function releaseSlot(): void {
  inflight--;
  waiters.shift()?.();
}

// Create the prediction, riding out transient throttling. The beats
// route synthesizes a whole batch concurrently, which can trip
// Replicate's burst limit — a 429 (or blippy 5xx / network error) here
// is almost always momentary, so retry with backoff (honoring
// Retry-After) instead of failing the beat.
async function createPrediction(text: string, speaker: string, token: string): Promise<ReplicatePrediction> {
  const MAX_RETRIES = 5;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(predictionEndpoint(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          // Hold the connection until the prediction settles (up to 60s);
          // we still poll afterwards in case it takes longer.
          Prefer: "wait=60",
        },
        body: JSON.stringify({ input: buildInput(text, speaker) }),
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) { await sleep(Math.min(10_000, 2000 * 2 ** attempt)); continue; }
      throw new QwenTTSError(`Replicate network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new QwenTTSError("Replicate auth failed — the server's REPLICATE_API_TOKEN is missing or invalid.", res.status);
    }
    if (res.status === 402) {
      throw new QwenTTSError("Replicate account is out of credit. Free Qwen voices are temporarily unavailable.", 402);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(15_000, retryAfter * 1000)
          : Math.min(10_000, 2000 * 2 ** attempt);
        await sleep(waitMs);
        continue;
      }
      throw new QwenTTSError(
        res.status === 429
          ? "Replicate kept rate-limiting after several retries. Wait a minute and try again."
          : `Replicate error ${res.status} persisted after retries. Try again.`,
        res.status,
      );
    }
    if (!res.ok && res.status !== 201) {
      const body = await res.text().catch(() => "");
      throw new QwenTTSError(`Replicate error ${res.status}: ${body.replace(/\s+/g, " ").trim().slice(0, 300)}`, res.status);
    }

    const prediction = (await res.json().catch(() => null)) as ReplicatePrediction | null;
    if (!prediction?.id) throw new QwenTTSError("Replicate returned an unexpected response.");
    return prediction;
  }
}

async function synthChunk(text: string, speaker: string, token: string): Promise<ArrayBuffer> {
  await acquireSlot();
  let prediction: ReplicatePrediction;
  try {
    prediction = await createPrediction(text, speaker, token);
    // Brief spacing before the next queued creation starts — bursts are
    // what trip the limiter, not sustained volume.
    await sleep(START_GAP_MS);
  } finally {
    releaseSlot();
  }

  // Poll until terminal (Prefer: wait usually returns settled already).
  // Throttled/blippy poll responses just wait for the next tick — the
  // deadline bounds the total time, so transient 429s can't fail a
  // prediction that's still running fine on Replicate's side.
  const deadline = Date.now() + 120_000;
  while (prediction.status === "starting" || prediction.status === "processing") {
    if (Date.now() > deadline) throw new QwenTTSError("Qwen TTS timed out. Try again.", 504);
    await sleep(1500);
    const pollUrl = prediction.urls?.get ?? `https://api.replicate.com/v1/predictions/${prediction.id}`;
    const poll = await fetch(pollUrl, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (!poll || poll.status === 429 || poll.status >= 500) continue;
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

  // Per-user monthly perk budget, tiered by plan — Heclus pays for these
  // characters, so enforce OUR cap up front (Google's equivalent is
  // enforced by Google). Founders have no Qwen allowance at all.
  const { data: userData } = await supabase.auth.admin.getUserById(userId);
  const meta = (userData?.user?.app_metadata ?? {}) as { plan?: string };
  // isAdminUser folds in the legacy ADMIN_EMAILS backstop; those accounts
  // carry no app_metadata.is_admin flag, so the raw flag denied them.
  const cap = qwenCapForPlan(meta.plan, isAdminUser(userData?.user));
  if (cap <= 0) {
    throw new QwenTTSError(
      "Qwen voices aren't included in the Founder plan — pick a Google voice (free on your own key) or a paid voice.",
      403,
    );
  }
  const used = await getFreeUsageThisMonth(userId, "qwen_tts_chars");
  if (used + text.length > cap) {
    throw new QwenTTSError(
      `This voiceover needs ${text.length.toLocaleString()} characters but you have ${Math.max(0, cap - used).toLocaleString()} left on this month's free Qwen quota. It resets next month — or pick a Google or paid voice.`,
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
