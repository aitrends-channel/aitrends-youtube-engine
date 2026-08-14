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

/** Marks a beat as belonging to this lane. Both queue paths stamp the beat's
 *  own video_model_id, the app's cron claims on this prefix, and the separate
 *  video-worker excludes it. Defined here so those three cannot drift apart. */
export const GENAIPRO_VIDEO_MODEL_ID = "genaipro-veo-2";
export const GENAIPRO_MODEL_PREFIX = "genaipro";

/**
 * Where a GenAIPro beat waits for the lane to pick it up.
 *
 * Not "queued", which is what the separate video-worker claims, and not
 * "submitting" or "rendering" either: that worker's stale-recovery resets
 * both of those back to "queued" when they carry no job id, which would hand
 * a GenAIPro beat straight to KIE two minutes after it was queued.
 *
 * A status outside all three means correctness does not depend on that worker
 * being redeployed. The filter added there is now defence in depth rather than
 * the thing holding this together.
 */
export const GENAIPRO_QUEUED_STATUS = "gp_queued";

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

/**
 * Their own auth failures, observed by probing the live endpoint: an absent
 * header gives token_is_empty, an empty or malformed Bearer gives invalid_token,
 * and a well-formed key they do not know gives invalid_api_key.
 *
 * The list matters because a 401 that is NOT one of these did not come from
 * their API. genaipro.io sits behind Cloudflare, and that layer has answered our
 * submits with both an HTML error page and a bare "No access token found" while
 * the configured key was valid. Those are interceptions in front of the API, not
 * a verdict on our key, so they are worth retrying — whereas retrying a key they
 * genuinely reject would just fail all day.
 */
const AUTH_ERROR_CODES = new Set(["invalid_api_key", "invalid_token", "token_is_empty"]);

interface UpstreamError {
  /** For a human: the provider's own words, or a short description of a
   *  response that had none. */
  message: string;
  retryable: boolean;
}

async function readError(res: Response): Promise<UpstreamError> {
  const text = (await res.text().catch(() => "")).trim();

  // An HTML body is never their API. It is the edge in front of it, so it says
  // nothing about the request and should not be pasted into a user's error
  // slot — a beat error reading "<!DOCTYPE html>" tells nobody anything.
  if (text.startsWith("<")) {
    return {
      message: `The provider returned an error page instead of a reply (HTTP ${res.status}). This is usually temporary.`,
      retryable: true,
    };
  }

  interface ApiError { message?: string; error?: string; detail?: string }
  let parsed: ApiError | null = null;
  try {
    parsed = JSON.parse(text) as ApiError;
  } catch {
    parsed = null;
  }
  const raw = parsed?.message ?? parsed?.error ?? parsed?.detail ?? text.slice(0, 300) ?? res.statusText;
  const code = typeof parsed?.error === "string" ? parsed.error : "";

  // Out of credit upstream. Said plainly, because the customer's own wallet is
  // fine and blaming "quota" sends them looking at a balance that is not the
  // problem. Not retryable: it will keep failing until a package is bought.
  if (/insufficient quota/i.test(raw)) {
    return {
      message: "Heclus's video provider account is out of credit. This is on our side, not your balance — we are topping it up.",
      retryable: false,
    };
  }

  if (res.status === 401 || res.status === 403) {
    if (AUTH_ERROR_CODES.has(code)) {
      return {
        message: "The video provider rejected our API key. Set a valid GenAIPro key in Config → API Keys.",
        retryable: false,
      };
    }
    // A 401 in a shape they do not use: the edge, not them. Retry.
    return {
      message: `The provider's gateway refused the request (HTTP ${res.status}: ${raw}). This is usually temporary.`,
      retryable: true,
    };
  }

  return { message: raw, retryable: isRetryableStatus(res.status) };
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
    const err = await readError(res);
    throw new GenAIProError(`GenAIPro credits: ${err.message}`, res.status, err.retryable);
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
    const err = await readError(res);
    throw new GenAIProError(`GenAIPro submit: ${err.message}`, res.status, err.retryable);
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
    const err = await readError(res);
    throw new GenAIProError(`GenAIPro status: ${err.message}`, res.status, err.retryable);
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
