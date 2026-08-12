import { getActiveProductKey } from "@/lib/claude/routing";

// GenAIPro (Veo) video generation, on Heclus's own account.
//
// Contract, from https://docs.genaipro.io/openapi.yaml:
//   base            https://genaipro.io/api
//   auth            Authorization: Bearer <token>
//   submit          POST /v2/veo/frames-to-video   (multipart)
//   submit (t2v)    POST /v2/veo/text-to-video     (json)
//   status          GET  /v2/veo/tasks/{id}
//   account credit  GET  /v2/veo/credits
//   rate limit      30 requests/minute, both submit and poll
//
// frames-to-video is the path that matters here: Heclus has already generated a
// still for every beat, and the job is to animate that still. text-to-video
// would throw the image away and produce a clip that does not match the beat it
// belongs to.
//
// The 30/minute ceiling is the constraint that shapes everything downstream. A
// median project is ~147 clips, so a project cannot be submitted in one pass —
// whatever drives this has to spread submits over several minutes.

const BASE = "https://genaipro.io/api";

/** Their aspect-ratio enum has exactly two values, so every Heclus ratio has to
 *  land on one of them. Anything taller than it is wide is portrait. */
export type GenAIProAspect = "VIDEO_ASPECT_RATIO_LANDSCAPE" | "VIDEO_ASPECT_RATIO_PORTRAIT";

export function aspectFor(ratio: string | null | undefined): GenAIProAspect {
  const r = (ratio ?? "").trim();
  const m = r.match(/^(\d+)\s*[:x/]\s*(\d+)$/i);
  if (m) {
    const w = Number(m[1]), h = Number(m[2]);
    if (w > 0 && h > 0) {
      return h > w ? "VIDEO_ASPECT_RATIO_PORTRAIT" : "VIDEO_ASPECT_RATIO_LANDSCAPE";
    }
  }
  // Shorts-shaped names, and the safe default for anything unrecognised.
  if (/portrait|vertical|short/i.test(r)) return "VIDEO_ASPECT_RATIO_PORTRAIT";
  return "VIDEO_ASPECT_RATIO_LANDSCAPE";
}

export class GenAIProError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}

async function apiKey(): Promise<string> {
  const key = await getActiveProductKey("genaipro_api_key");
  if (!key) {
    throw new GenAIProError(
      "GenAIPro key not configured — set one in Config → API Keys (service: GenAIPro API Key).",
    );
  }
  return key;
}

/** 429 and 5xx are worth another attempt; a 4xx is our request being wrong. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string; detail?: string };
    return parsed.message ?? parsed.error ?? parsed.detail ?? text.slice(0, 300) ?? res.statusText;
  } catch {
    return (text || res.statusText).slice(0, 300);
  }
}

export interface GenAIProCredits {
  /** Total credits across every package currently on the account. */
  quota: number;
  used: number;
  remaining: number;
  /** Soonest expiry among the packages, ISO. Their packages are time-boxed, so
   *  a healthy remaining figure can still be about to evaporate. */
  expiresAt: string | null;
}

/**
 * What the Heclus account has left upstream.
 *
 * This is the number the admin low-balance alert watches. It is a completely
 * separate quantity from a user's wallet balance: a user can hold credit we
 * have promised while the account behind it is empty, and that is the failure
 * mode worth alerting on before it happens.
 */
export async function getGenAIProCredits(): Promise<GenAIProCredits> {
  const res = await fetch(`${BASE}/v2/veo/credits`, {
    headers: { Authorization: `Bearer ${await apiKey()}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new GenAIProError(`GenAIPro credits: ${await readError(res)}`, res.status, isRetryableStatus(res.status));
  }
  const body = await res.json() as unknown;
  // Documented as an array of packages; tolerate a bare object.
  const rows = (Array.isArray(body) ? body : [body]) as { quota?: number; used?: number; expires_at?: string }[];
  let quota = 0, used = 0, expiresAt: string | null = null;
  for (const r of rows) {
    quota += Number(r?.quota ?? 0) || 0;
    used += Number(r?.used ?? 0) || 0;
    const exp = typeof r?.expires_at === "string" ? r.expires_at : null;
    if (exp && (!expiresAt || exp < expiresAt)) expiresAt = exp;
  }
  return { quota, used, remaining: Math.max(quota - used, 0), expiresAt };
}

export interface SubmitResult {
  /** Their task id, stored on the beat so polling can find it again. */
  taskId: string;
  status: string;
}

/**
 * Animate one still. The image is fetched and forwarded as multipart, because
 * their endpoint takes a binary rather than a URL.
 *
 * `callbackUrl` is supported by their API and left optional: polling is the
 * path that works without a public webhook secret, and the KIE image webhook
 * already showed what a dropped callback costs.
 */
export async function submitFramesToVideo(opts: {
  imageUrl: string;
  prompt: string;
  aspectRatio?: string | null;
  callbackUrl?: string | null;
}): Promise<SubmitResult> {
  const key = await apiKey();

  const imgRes = await fetch(opts.imageUrl, { cache: "no-store" });
  if (!imgRes.ok) {
    // Ours, not theirs: the beat's still is unreachable, so there is nothing to
    // animate and no reason to spend a credit finding that out.
    throw new GenAIProError(`Could not read the beat image (${imgRes.status})`, imgRes.status, false);
  }
  const bytes = await imgRes.blob();

  const form = new FormData();
  form.append("start_image", bytes, "start.jpg");
  form.append("prompt", opts.prompt);
  form.append("aspect_ratio", aspectFor(opts.aspectRatio));
  // Their field is a string on the multipart endpoints. One clip per credit.
  form.append("number_of_videos", "1");
  if (opts.callbackUrl) form.append("callback_url", opts.callbackUrl);

  const res = await fetch(`${BASE}/v2/veo/frames-to-video`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    throw new GenAIProError(`GenAIPro submit: ${await readError(res)}`, res.status, isRetryableStatus(res.status));
  }

  const body = await res.json() as { histories?: { id?: string; status?: string }[] };
  const first = body?.histories?.[0];
  if (!first?.id) {
    throw new GenAIProError("GenAIPro accepted the job but returned no task id", res.status, true);
  }
  return { taskId: String(first.id), status: String(first.status ?? "processing") };
}

export type GenAIProTaskState = "processing" | "completed" | "failed";

export interface TaskStatus {
  state: GenAIProTaskState;
  /** First returned file, when completed. */
  url: string | null;
  error: string | null;
}

/** Poll one task. Their credits refund automatically on their side when a task
 *  fails, which is why our own release is the whole of the customer-facing
 *  refund: we are not out of pocket either. */
export async function getTaskStatus(taskId: string): Promise<TaskStatus> {
  const res = await fetch(`${BASE}/v2/veo/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${await apiKey()}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new GenAIProError(`GenAIPro status: ${await readError(res)}`, res.status, isRetryableStatus(res.status));
  }
  const body = await res.json() as { status?: string; file_urls?: unknown; error?: string };
  const raw = String(body?.status ?? "processing").toLowerCase();
  const state: GenAIProTaskState =
    raw === "completed" ? "completed" : raw === "failed" ? "failed" : "processing";
  const urls = Array.isArray(body?.file_urls) ? body.file_urls.filter((u): u is string => typeof u === "string" && !!u) : [];
  return {
    state,
    url: urls[0] ?? null,
    error: typeof body?.error === "string" && body.error ? body.error : null,
  };
}

/** Their documented ceiling, for whatever schedules submits and polls. */
export const GENAIPRO_RATE_LIMIT_PER_MINUTE = 30;
