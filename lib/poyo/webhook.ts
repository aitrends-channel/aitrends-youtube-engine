import { createHash, timingSafeEqual } from "crypto";

// PoYo callback authentication.
//
// PoYo does not sign its callbacks. There is no signing scheme in
// docs.poyo.ai, no shared secret handed back at submit, and no signature
// header, so there is nothing to verify a delivery against. That rules out the
// approach lib/kie/webhook.ts takes.
//
// Two mitigations, and both are needed:
//
//   1. A capability token in the callback URL. Only PoYo is ever told the URL,
//      so a caller that knows the token has either seen our outbound request
//      or has the secret. Compared in constant time, and fails closed when
//      POYO_WEBHOOK_TOKEN is unset, the same way the KIE verifier does.
//
//   2. Nothing in the payload is trusted. The route uses the delivery purely
//      as a signal to go and read the task over the authenticated API. Even a
//      forged callback that guesses the token can therefore do no more than
//      make us poll a task we already own, because the result comes from PoYo
//      over our own credentials rather than from the request body.
//
// The token is a URL parameter, so it will appear in access logs on any proxy
// in front of this app. That is acceptable for a value whose only power is
// triggering a re-read of a task we already submitted, and it is why (2) is
// not optional.

export function getPoyoWebhookToken(): string | null {
  return process.env.POYO_WEBHOOK_TOKEN?.trim() || null;
}

/** The callback URL handed to PoYo at submit. Returns undefined when no token
 *  is configured, which leaves the task on the poll and cron paths rather than
 *  registering a callback nobody can authenticate. */
export function poyoCallbackUrl(appUrl: string): string | undefined {
  const token = getPoyoWebhookToken();
  if (!token) return undefined;
  return `${appUrl}/api/webhooks/poyo/image?token=${encodeURIComponent(token)}`;
}

export function verifyPoyoCallbackToken(url: string): { ok: true } | { ok: false; reason: string } {
  const expected = getPoyoWebhookToken();
  if (!expected) return { ok: false, reason: "POYO_WEBHOOK_TOKEN not configured" };

  let provided: string | null = null;
  try {
    provided = new URL(url).searchParams.get("token");
  } catch {
    return { ok: false, reason: "unparseable request URL" };
  }
  if (!provided) return { ok: false, reason: "no token" };

  // Hash both sides first so timingSafeEqual gets equal-length buffers and the
  // comparison leaks nothing about the secret's length.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "token mismatch" };
}
