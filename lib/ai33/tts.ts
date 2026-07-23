import type { KieModel } from "@/lib/types";
import { getFreeUsageThisMonth } from "@/lib/freeUsage";
import { supabase } from "@/lib/supabase/client";

// ai33.pro (OpenSpeaker) TTS — a Heclus-paid voiceover perk, mirroring the
// Qwen path (lib/replicate/tts.ts). It runs on HECLUS's own ai33 key
// (server-side AI33_API_TOKEN), users configure nothing, and a per-user
// monthly character cap keeps one account from draining the perk.
//
// ai33 is a multi-provider TTS aggregator: a voice_id already carries a
// provider prefix (minimax_, elevenlabs_, edge_, kokoro_, vbee_,
// fishaudio_, clone_). We add our OWN "ai33/" prefix on top so
// generateTTS can route on it and it can't collide with ElevenLabs/qwen/
// google ids; generateAi33TTS strips "ai33/" before calling the API.
//
// The API is async: POST /v3/text-to-speech returns a task_id, then we
// poll the task endpoint until the audio URL is ready and download it —
// wrapped to satisfy generateTTS's synchronous { audio, charsConsumed }
// contract, exactly like the Qwen path blocks on Replicate.

export class Ai33TTSError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "Ai33TTSError";
  }
}

// Heclus-paid perk budget per user per month, in characters — tiered by
// plan. Founders get no ai33 access (cap 0); admins count as Pro.
// Env-overridable without a deploy.
export const AI33_TTS_CAP_STARTER = Number(process.env.AI33_TTS_CAP_STARTER ?? 50_000);
export const AI33_TTS_CAP_PRO = Number(process.env.AI33_TTS_CAP_PRO ?? 100_000);

export function ai33CapForPlan(plan: string | null | undefined, isAdmin = false): number {
  if (isAdmin) return AI33_TTS_CAP_PRO;
  const p = (plan ?? "").trim().toLowerCase();
  if (p === "founder") return 0;
  if (p === "pro") return AI33_TTS_CAP_PRO;
  // starter, demo, unknown → the entry-level cap.
  return AI33_TTS_CAP_STARTER;
}

// Voice ids are prefixed "ai33/" so they can't collide with ElevenLabs,
// google/ or qwen/ ids and generateTTS can route on the prefix alone. The
// value after "ai33/" is the real ai33 voice_id (which itself carries a
// provider prefix like elevenlabs_/minimax_). First tag is the gender so
// the picker's Female/Male tabs classify them. previewUrl points straight
// at ai33's own sample CDN — no synthesis, so previews don't burn quota.
function av(voiceId: string, label: string, tags: string[], previewUrl: string): KieModel {
  return {
    id: `ai33/${voiceId}`,
    name: label,
    type: "tts",
    tags,
    previewUrl,
  };
}

// Curated English subset of ai33's Voice Library (fetched live from
// GET /v3/voices?provider=…). Adjust freely — ids and preview URLs are
// the real values returned by the API.
export const AI33_VOICES: KieModel[] = [
  av("elevenlabs_hpp4J3VqNfWAUOO0d1Us", "Bella", ["Female", "Warm"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/hpp4J3VqNfWAUOO0d1Us/dab0f5ba-3aa4-48a8-9fad-f138fea1126d.mp3"),
  av("elevenlabs_EXAVITQu4vr4xnSDxMaL", "Sarah", ["Female", "Confident"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3"),
  av("minimax_226893671006276", "Graceful Lady", ["Female", "Smooth"], "https://cdn.hailuoai.video/moss/prod/2025-01-15-19/moss-audio/voice_sample_audio/sample/1736941299124886240-/hailuo-audio-6d69767af53f485e91ac5c8fdd37644a.mp3"),
  av("elevenlabs_JBFqnCBsd6RMkjVDRZzb", "George", ["Male", "Storyteller"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/JBFqnCBsd6RMkjVDRZzb/e6206d1a-0721-4787-aafb-06a6e705cac5.mp3"),
  av("elevenlabs_CwhRBWXzGAHq8TQ4Fs17", "Roger", ["Male", "Casual"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/CwhRBWXzGAHq8TQ4Fs17/58ee3ff5-f6f2-4628-93b8-e38eb31806b0.mp3"),
  av("minimax_209533299589198", "Captivating Storyteller", ["Male", "Narration"], "https://cdn.hailuoai.video/moss/prod/2025-01-15-19/moss-audio/voice_sample_audio/sample/1736941309798396434-/hailuo-audio-2522ec7dd4a9aa794d27d9ee907f1add.mp3"),
  av("elevenlabs_SAz9YHcvj6GT2YYXdXww", "River", ["Neutral", "Informative"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/SAz9YHcvj6GT2YYXdXww/e6c95f0b-2227-491a-b3d7-2249240decb7.mp3"),
];

export function isAi33Voice(voiceId: string): boolean {
  return voiceId.startsWith("ai33/");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AI33_BASE = (process.env.AI33_API_BASE ?? "https://api.ai33.pro").replace(/\/+$/, "");

// ai33 rate limits are undocumented; gate concurrent submits through a
// small module-level queue like the Qwen path, with retry as the
// cross-invocation backstop.
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

// Verified live: POST returns { success, task_id }; GET /v3/task/{id}
// returns { success, data: { status, metadata: { v3: { audio_url } },
// progress, ... } }. A throttled poll returns { success:false, message:
// "Task polling temporarily busy" } — transient, keep waiting.
interface Ai33TaskData {
  id?: string;
  status?: string;
  progress?: number;
  metadata?: { v3?: { audio_url?: string } };
  error?: string | null;
  message?: string | null;
}
interface Ai33TaskResponse {
  success?: boolean;
  message?: string | null;
  task_id?: string;
  id?: string;
  data?: Ai33TaskData;
}

function audioUrlFrom(data: Ai33TaskData): string | null {
  const url = data.metadata?.v3?.audio_url;
  return typeof url === "string" && url.startsWith("http") ? url : null;
}

const DONE = ["success", "succeeded", "completed", "complete", "done", "finished", "finish"];
const FAIL = ["failed", "fail", "error", "canceled", "cancelled"];

function classify(data: Ai33TaskData): "done" | "failed" | "pending" {
  const s = (data.status ?? "").toString().toLowerCase();
  if (FAIL.includes(s)) return "failed";
  if (DONE.includes(s)) return "done";
  return "pending";
}

// Submit one synthesis and return its task_id, riding out transient
// throttling / blips.
async function submitTask(text: string, voiceId: string, token: string): Promise<string> {
  const MAX_RETRIES = 5;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      const form = new FormData();
      form.append("text", text);
      form.append("voice_id", voiceId);
      form.append("speed", "1");
      form.append("with_transcript", "false");
      res = await fetch(`${AI33_BASE}/v3/text-to-speech`, {
        method: "POST",
        headers: { "xi-api-key": token },
        body: form,
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) { await sleep(Math.min(10_000, 2000 * 2 ** attempt)); continue; }
      throw new Ai33TTSError(`ai33 network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new Ai33TTSError("ai33 auth failed — the server's AI33_API_TOKEN is missing or invalid.", res.status);
    }
    if (res.status === 402) {
      throw new Ai33TTSError("ai33 account is out of credit. Free ai33 voices are temporarily unavailable.", 402);
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
      throw new Ai33TTSError(`ai33 error ${res.status} persisted after retries. Try again.`, res.status);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Ai33TTSError(`ai33 error ${res.status}: ${body.replace(/\s+/g, " ").trim().slice(0, 300)}`, res.status);
    }

    const data = (await res.json().catch(() => null)) as Ai33TaskResponse | null;
    const taskId = data?.task_id ?? data?.id;
    if (!taskId) throw new Ai33TTSError("ai33 returned no task_id.");
    return taskId;
  }
}

// Poll GET /v3/task/{id} until the audio is ready, then download it.
async function pollAndDownload(taskId: string, token: string): Promise<ArrayBuffer> {
  const deadline = Date.now() + 120_000;
  const pollUrl = `${AI33_BASE}/v3/task/${encodeURIComponent(taskId)}`;
  for (;;) {
    if (Date.now() > deadline) throw new Ai33TTSError("ai33 TTS timed out. Try again.", 504);
    await sleep(2500);
    const poll = await fetch(pollUrl, { headers: { "xi-api-key": token } }).catch(() => null);
    if (!poll || poll.status === 429 || poll.status >= 500) continue; // transient — keep waiting
    if (!poll.ok) throw new Ai33TTSError(`ai33 poll failed (${poll.status}).`, poll.status);
    const body = (await poll.json().catch(() => null)) as Ai33TaskResponse | null;
    if (!body) continue;
    // Throttled poll ("Task polling temporarily busy") comes back as
    // success:false with no data — wait and retry, don't treat as failure.
    if (body.success === false || !body.data) continue;
    const data = body.data;
    const verdict = classify(data);
    if (verdict === "pending") continue;
    if (verdict === "failed") {
      throw new Ai33TTSError(`ai33 TTS failed: ${(data.error ?? data.message ?? "unknown error").toString().slice(0, 300)}`);
    }
    const url = audioUrlFrom(data);
    if (!url) throw new Ai33TTSError("ai33 TTS finished but returned no audio URL.");
    const audioRes = await fetch(url);
    if (!audioRes.ok) throw new Ai33TTSError(`Failed to download ai33 audio (${audioRes.status}).`);
    return audioRes.arrayBuffer();
  }
}

export async function generateAi33TTS(
  text: string,
  voiceId: string,
  userId?: string,
): Promise<{ audio: ArrayBuffer; charsConsumed: number }> {
  if (!userId) throw new Ai33TTSError("Sign in to use free voiceover.", 401);
  const token = (process.env.AI33_API_TOKEN ?? "").trim();
  if (!token) {
    throw new Ai33TTSError("Free ai33 voices aren't configured on this server yet (AI33_API_TOKEN).", 503);
  }

  // Per-user monthly perk budget, tiered by plan — Heclus pays for these
  // characters, so enforce OUR cap up front. Founders have no allowance.
  const { data: userData } = await supabase.auth.admin.getUserById(userId);
  const meta = (userData?.user?.app_metadata ?? {}) as { plan?: string; is_admin?: boolean };
  const cap = ai33CapForPlan(meta.plan, meta.is_admin === true);
  if (cap <= 0) {
    throw new Ai33TTSError(
      "ai33 voices aren't included in the Founder plan — pick a Google voice (free on your own key) or a paid voice.",
      403,
    );
  }
  const used = await getFreeUsageThisMonth(userId, "ai33_tts_chars");
  if (used + text.length > cap) {
    throw new Ai33TTSError(
      `This voiceover needs ${text.length.toLocaleString()} characters but you have ${Math.max(0, cap - used).toLocaleString()} left on this month's free ai33 quota. It resets next month — or pick a Google or paid voice.`,
      429,
    );
  }

  const realVoiceId = voiceId.replace(/^ai33\//, "");

  await acquireSlot();
  let taskId: string;
  try {
    taskId = await submitTask(text, realVoiceId, token);
    await sleep(START_GAP_MS); // brief spacing between queued submits
  } finally {
    releaseSlot();
  }

  const audio = await pollAndDownload(taskId, token);
  return { audio, charsConsumed: text.length };
}
