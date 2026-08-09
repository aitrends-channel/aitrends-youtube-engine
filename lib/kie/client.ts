import { getSettings } from "@/lib/settings";

const KIE_BASE_URL = "https://api.kie.ai";

// Carries the upstream HTTP status so route handlers can map it onto
// an accurate response code (e.g. 429 from KIE → 429 from us, not 500).
// Without this, every transient upstream blip alerts as a server bug.
// `insufficientCredits` distinguishes "the customer's KIE balance is
// zero" (user-config problem, HTTP 402 for us) from real KIE failures
// (bad gateway) so Vercel stops paging on the former.
export class KieUpstreamError extends Error {
  constructor(
    public upstreamStatus: number,
    public retryAfter: number | null,
    message: string,
    public insufficientCredits: boolean = false,
  ) {
    super(message);
    this.name = "KieUpstreamError";
  }
}

// KIE surfaces "wallet empty" a few different ways depending on route
// and layer. HTTP 402 (Payment Required) is the definitive signal;
// message-based matching is a fallback for older endpoints that return
// 200/400 with the error inside the JSON body.
//
// "quota" is deliberately excluded from the fallback pattern because
// KIE also uses "insufficient quota" / "quota exceeded" for per-minute
// and per-day rate limits, which are NOT the same as an empty wallet —
// translating them to "top up your account" sent users to add credits
// they already had. Rate-limit surfacing lives with the retry-after
// handling above.
export function looksLikeInsufficientCredits(status: number, body: string, code?: number): boolean {
  if (status === 402 || code === 402) return true;
  // Both word orders: KIE's own /claude relay says "Credits insufficient",
  // which the insufficient-first pattern missed entirely — a genuinely empty
  // wallet was being reported as a generic failure and retried.
  return /insufficient\s+(credit|balance|fund)|credits?\s+insufficient|out\s+of\s+credit|no\s+credit/i.test(body);
}

/**
 * The account's actual KIE balance, or null if it can't be read.
 *
 * Exists because "looks like an out-of-credit error" is not the same as "the
 * wallet is empty": a bare 402 from some other layer reads identically, and
 * stopping a run on that leaves a user staring at "top up" with a hundred
 * credits in the account. Callers that are about to abandon work should check
 * the balance first and only believe the error if the money really is gone.
 *
 * Endpoint name is unintuitive — `/chat/credit` is the global account balance,
 * not chat-specific — and the number arrives directly in `data` (it can be
 * negative when overdrawn). Same call the API-status card uses.
 */
export async function fetchKieBalance(key: string): Promise<number | null> {
  if (!key) return null;
  try {
    const res = await fetch(`${KIE_BASE_URL}/api/v1/chat/credit`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const body = await res.json() as { data?: unknown };
    return typeof body.data === "number" ? body.data : null;
  } catch {
    return null;
  }
}

/** Below this a batch can't realistically be paid for — the priciest prompt
 *  call we've measured runs about 5 credits. Used to decide whether an
 *  out-of-credit-looking error is genuine. */
export const KIE_MIN_USABLE_CREDITS = 1;

// KIE sits behind Cloudflare, so a 5xx (502/503/504) comes back as a full
// HTML error page — kilobytes of markup. Embedding that verbatim in the
// thrown error floods our logs and lands the whole page in the beat's
// image_error / video_error column. Collapse an HTML body to a short
// marker and hard-cap anything else so only the useful (usually small
// JSON) error text survives.
export function sanitizeKieErrorBody(body: string): string {
  if (/^\s*<(?:!doctype|html|head|body)/i.test(body)) {
    return "(HTML error page — likely a Cloudflare/upstream outage)";
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

async function getKieKey(userId?: string): Promise<string> {
  if (userId) {
    const { kie_api_key } = await getSettings(userId);
    if (!kie_api_key) throw new Error("KIE API key not configured. Add it in Settings.");
    return kie_api_key;
  }
  const key = process.env.KIE_API_KEY ?? "";
  if (!key) throw new Error("KIE API key not configured.");
  return key;
}

export async function kieRequest<T>(
  endpoint: string,
  options: RequestInit = {},
  userId?: string
): Promise<T> {
  const kie_api_key = await getKieKey(userId);

  const res = await fetch(`${KIE_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${kie_api_key}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : null;
    const insufficient = looksLikeInsufficientCredits(res.status, body);
    throw new KieUpstreamError(
      res.status,
      Number.isFinite(retryAfter) ? retryAfter : null,
      `kie.ai error ${res.status} on ${endpoint}: ${sanitizeKieErrorBody(body)}`,
      insufficient,
    );
  }

  return res.json() as Promise<T>;
}

export async function kieRequestBinary(
  endpoint: string,
  body: object,
  userId?: string
): Promise<ArrayBuffer> {
  const kie_api_key = await getKieKey(userId);

  const res = await fetch(`${KIE_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kie_api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : null;
    const insufficient = looksLikeInsufficientCredits(res.status, text);
    throw new KieUpstreamError(
      res.status,
      Number.isFinite(retryAfter) ? retryAfter : null,
      `kie.ai error ${res.status} on ${endpoint}: ${sanitizeKieErrorBody(text)}`,
      insufficient,
    );
  }

  return res.arrayBuffer();
}
