import { getActiveProductKey } from "@/lib/claude/routing";

// PoYo (api.poyo.ai), the second paid media operator.
//
// Contract, from docs.poyo.ai/api-manual/overview:
//   base       https://api.poyo.ai
//   auth       Authorization: Bearer <key>
//   submit     POST /api/generate/submit   { model, input, callback_url? }
//              → { code, data: { task_id, status, created_time } }
//   status     GET  /api/generate/status/{task_id}
//              → { code, data: { task_id, status, progress, files[], error_message } }
//   status set not_started | running | finished | failed
//   result at  data.files[0].file_url
//   errors     { code, error: { message, type } }
//
// Two things PoYo does not give us that KIE does, both of which shape the code
// below:
//
//   1. No webhook signature. There is no documented signing scheme, so a
//      callback cannot be trusted on its contents. The webhook route treats a
//      delivery as a wake-up signal only and re-reads the task over this
//      authenticated client, which is the same shape Vercel's AI Gateway
//      recommends and the only safe reading of an unsigned callback.
//   2. No credits-consumed field. KIE reports what a finished task actually
//      cost; PoYo reports nothing, so metering has to use a static per-model
//      price. See lib/poyo/imageModels.ts.

const POYO_BASE_URL = "https://api.poyo.ai";

/** Mirrors KieUpstreamError so route handlers can map upstream status onto an
 *  accurate response code rather than turning every provider blip into a 500. */
export class PoyoUpstreamError extends Error {
  constructor(
    public upstreamStatus: number,
    public retryAfter: number | null,
    message: string,
    public insufficientCredits: boolean = false,
  ) {
    super(message);
    this.name = "PoyoUpstreamError";
  }
}

export function looksLikeInsufficientCredits(status: number, body: string): boolean {
  if (status === 402) return true;
  return /insufficient\s+(credit|balance|fund)|credits?\s+insufficient|out\s+of\s+credit|no\s+credit/i.test(body);
}

/**
 * Whose PoYo key signs this request.
 *
 * Heclus's own, always. Unlike KIE there is no per-client path: exposing PoYo
 * to BYO clients would mean asking every existing customer for a second API
 * key, which is a product decision rather than a plumbing one. PoYo models are
 * therefore offered to wallet-funded users only, enforced in the catalog, and
 * this function is where a client_poyo routing would slot in if that changes.
 */
async function getPoyoKey(): Promise<string> {
  const key = await getActiveProductKey("heclus_poyo_api_key")
    ?? process.env.HECLUS_POYO_API_KEY?.trim()
    ?? null;
  if (!key) {
    throw new Error(
      "Heclus PoYo key not configured — set HECLUS_POYO_API_KEY, or add one in Config → API Keys (service: Heclus PoYo API Key).",
    );
  }
  return key;
}

/** Truncate an upstream error body the way the KIE client does: an HTML error
 *  page from a CDN outage is noise, and an unbounded body poisons the logs. */
export function sanitizePoyoErrorBody(body: string): string {
  if (/^\s*<(?:!doctype|html|head|body)/i.test(body)) {
    return "(HTML error page — likely a CDN/upstream outage)";
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

export async function poyoRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const key = await getPoyoKey();
  const res = await fetch(`${POYO_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = sanitizePoyoErrorBody(await res.text().catch(() => ""));
    const retryAfterRaw = res.headers.get("retry-after");
    const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : null;
    throw new PoyoUpstreamError(
      res.status,
      Number.isFinite(retryAfter) ? retryAfter : null,
      `PoYo ${res.status}: ${body || res.statusText}`,
      looksLikeInsufficientCredits(res.status, body),
    );
  }

  // PoYo returns HTTP 200 with a non-200 `code` for application errors, the
  // same way KIE does, so the body has to be inspected rather than the status.
  return (await res.json()) as T;
}

/** PoYo's envelope. `code` is 200 on success; failures carry `error`. */
export interface PoyoEnvelope<T> {
  code: number;
  data?: T;
  error?: { message?: string; type?: string };
}

export function poyoEnvelopeError(env: PoyoEnvelope<unknown>, fallback: string): PoyoUpstreamError {
  const msg = env.error?.message ?? fallback;
  return new PoyoUpstreamError(env.code, null, `PoYo ${env.code}: ${msg}`, looksLikeInsufficientCredits(env.code, msg));
}
