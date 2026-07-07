import { createHmac, timingSafeEqual } from "crypto";

// Envelope KIE POSTs to the callBackUrl on task completion.
// Confirmed against docs.kie.ai/common-api/webhook-verification.
export interface KieWebhookPayload {
  taskId?: string;
  code?: number;
  msg?: string;
  data?: {
    task_id?: string;
    taskId?: string;
    callbackType?: string;
    state?: string;
    status?: string;
    resultJson?: string;
    output?: string | string[];
    videoUrl?: string;
    video_url?: string;
    successFlag?: number;
    response?: { resultImageUrl?: string; originImageUrl?: string } | null;
    creditsConsumed?: number;
    // Extraction-friendly bag for the various failure fields KIE
    // uses. Matches the ones we already read in the poll path so a
    // failed webhook renders the same error text a failed poll
    // would have.
    failMsg?: string;
    failReason?: string;
    failCode?: string | number;
    error?: string;
    errorMessage?: string | null;
    errorCode?: string | number | null;
    [key: string]: unknown;
  };
}

// Maximum age we'll accept for a webhook timestamp. KIE signs
// `${taskId}.${timestampSeconds}` and re-fires the same payload on
// retries, so anything older than this is either a genuine retry
// after a very long outage or a replay attack. 15 min covers KIE's
// typical retry window without opening a huge replay surface.
const WEBHOOK_MAX_AGE_SECONDS = 15 * 60;

// Verifies X-Webhook-Signature against KIE's spec:
//   signature = HMAC-SHA256(webhookHmacKey, `${taskId}.${timestampSeconds}`)
//   base64-encoded, transported in the X-Webhook-Signature header.
// Returns { ok: true, taskId } when the request is authentic and
// fresh; otherwise returns { ok: false, reason } for structured
// logging.
export function verifyKieWebhookSignature(
  headers: Headers,
  bodyText: string,
  secret: string | undefined,
): { ok: true; taskId: string } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "webhook secret not configured" };

  const signature = headers.get("x-webhook-signature");
  const timestamp = headers.get("x-webhook-timestamp");
  if (!signature) return { ok: false, reason: "missing X-Webhook-Signature header" };
  if (!timestamp) return { ok: false, reason: "missing X-Webhook-Timestamp header" };

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "malformed X-Webhook-Timestamp" };

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > WEBHOOK_MAX_AGE_SECONDS) {
    return { ok: false, reason: `timestamp outside ${WEBHOOK_MAX_AGE_SECONDS}s window (got ${tsNum}, now ${nowSec})` };
  }

  // Parse taskId out of the body — the signature covers it, so we
  // have to trust it BEFORE verifying. That's OK because verify()
  // below will reject if the body's taskId doesn't match the signed
  // input.
  let payload: KieWebhookPayload;
  try { payload = JSON.parse(bodyText) as KieWebhookPayload; }
  catch { return { ok: false, reason: "body is not valid JSON" }; }

  const taskId = payload.taskId ?? payload.data?.taskId ?? payload.data?.task_id;
  if (!taskId) return { ok: false, reason: "no taskId in payload" };

  const signedMessage = `${taskId}.${timestamp}`;
  const expectedBase64 = createHmac("sha256", secret).update(signedMessage).digest("base64");

  const providedBuf = Buffer.from(signature, "base64");
  const expectedBuf = Buffer.from(expectedBase64, "base64");
  if (providedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: "signature length mismatch" };
  }
  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: "signature mismatch" };
  }

  return { ok: true, taskId };
}

// The webhookHmacKey is generated on the KIE settings page. Callers
// read it via this helper so the fallback + env-var conventions
// stay consistent — production uses a real secret; dev without a
// key set explicitly opts out of verification for local tunnels.
export function getKieWebhookSecret(): string | undefined {
  return process.env.KIE_WEBHOOK_HMAC_KEY;
}
