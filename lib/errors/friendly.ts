// Turns provider errors into something a customer can act on.
//
// This lived inside the generate step, so every other step surfaced raw
// upstream text instead — which is how a user ended up reading
// `500 {"type":"error","error":{"type":"api_error",...}}` on the script step.
//
// Two rules make it safe to point every step at this:
//   1. A raw JSON payload is unwrapped before matching, so the provider's own
//      wording gets a chance to match a rule below.
//   2. The final fallback NEVER echoes text that still looks like a payload,
//      a stack trace, or a bare status code. Unmapped-but-readable text still
//      passes through (it's usually the most specific thing we have), but
//      machine output is replaced with a plain sentence.

/** Provider error bodies arrive as a JSON string, sometimes prefixed with the
 *  HTTP status ("500 {...}"). Pull out the human-facing parts: the message and
 *  the error type, which the mappings below can then match on. */
function unwrapPayload(raw: string): { text: string; errorType: string | null; status: number | null } {
  const status = /(^|\s)(\d{3})(\s|$)/.exec(raw.slice(0, 40));
  const braceAt = raw.indexOf("{");
  if (braceAt === -1) {
    return { text: raw, errorType: null, status: status ? Number(status[2]) : null };
  }
  try {
    const body = JSON.parse(raw.slice(braceAt)) as {
      error?: { type?: string; message?: string };
      message?: string;
      type?: string;
    };
    const inner = body.error ?? body;
    const message = (inner.message ?? "").trim();
    const errorType = (inner.type ?? body.type ?? "").trim() || null;
    // Prefer the provider's message; fall back to the surrounding text so a
    // message-less payload still has something to match against.
    return {
      text: message || raw.slice(0, braceAt).trim() || raw,
      errorType,
      status: status ? Number(status[2]) : null,
    };
  } catch {
    // Not valid JSON — keep whatever came before the brace so we don't match
    // rules against a half-serialized blob.
    const prefix = raw.slice(0, braceAt).trim();
    return { text: prefix || raw, errorType: null, status: status ? Number(status[2]) : null };
  }
}

/** True when the text still looks like machine output rather than a sentence. */
function looksLikeMachineOutput(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("{") || t.startsWith("[") || t.startsWith("<")) return true;
  if (/^\d{3}(\s|$)/.test(t)) return true;              // bare "500" / "429 ..."
  if (/"(type|error|message)"\s*:/.test(t)) return true; // JSON fragment
  if (/\bat \S+ \(.*:\d+:\d+\)/.test(t)) return true;    // stack frame
  if (/^[A-Za-z]*Error:/.test(t) && t.includes("\n")) return true;
  return false;
}

export function isModelTerminalError(raw: string | undefined | null): boolean {
  const msg = (raw ?? "").toLowerCase();
  return msg.includes("this field is required")
    || msg.includes("invalid model")
    || msg.includes("rejected the request")
    || msg.includes("temporarily paused")
    || msg.includes("video quality cannot be empty")
    || msg.includes("video model rejected");
}

export function friendlyError(raw: string | undefined | null): string {
  const original = (raw ?? "").trim();
  if (!original) return "Something went wrong — please try again";

  const { text, errorType, status } = unwrapPayload(original);
  const msg = `${text} ${errorType ?? ""}`.toLowerCase();

  // ── LLM / API provider failures ─────────────────────────────────────────
  // These are the shapes the script, topic, prompts and visuals steps hit.
  // 500/529 and rate limits are transient and worth retrying; the rest are
  // configuration problems the user (or we) has to fix.
  if (errorType === "overloaded_error" || status === 529 || msg.includes("overloaded"))
    return "The AI service is overloaded right now — wait a moment and try again";
  if (errorType === "api_error" || status === 500 || status === 502 || status === 503
    || msg.includes("server exception"))
    return "The AI service hit a temporary error — try again in a moment";
  if (errorType === "rate_limit_error" || status === 429)
    return "Too many requests — wait a moment and try again";
  if (errorType === "authentication_error" || status === 401)
    return "AI service key is invalid — go to Settings to update it";
  if (errorType === "permission_error" || status === 403)
    return "This AI model isn't available on your key — pick a different model in Settings";
  if (errorType === "not_found_error" || status === 404)
    return "The selected AI model wasn't found — pick a different model in Settings";
  if (errorType === "request_too_large" || status === 413)
    return "This request is too large — shorten the script or reduce the number of beats";

  // ── Free-provider (BYO) errors ──────────────────────────────────────────
  // Already user-worded from the API, so pass them through before the KIE
  // mappings below mislabel them (a Google "Quota exceeded…" message is NOT a
  // KIE rate limit).
  if (msg.includes("cloudflare")) return text.trim();
  if (msg.includes("credits insufficient") || msg.includes("insufficient credits") || (msg.includes("insufficient") && (msg.includes("balance") || msg.includes("credit") || msg.includes("fund"))))
    return "Insufficient KIE credits — top up your account at kie.ai";
  if (msg.includes("credits remaining") || msg.includes("credit balance"))
    return "Insufficient KIE credits — top up your account at kie.ai";
  if (msg.includes("quota_exceeded") || msg.includes("quota exceeded"))
    return "KIE rate limit reached — wait a minute and try again, or switch to a different model";
  if (msg.includes("invalid_api_key") || msg.includes("invalid api key") || msg.includes("unauthorized") || (msg.includes("api key") && msg.includes("invalid")))
    return "API key is invalid — go to Settings to update it";
  if (msg.includes("api key") && (msg.includes("missing") || msg.includes("not set") || msg.includes("required")))
    return "API key not set — go to Settings to add it";
  if (msg.includes("internal error") || msg.includes("internal server error") || msg.includes("fail code 500"))
    return "The selected model is temporarily unavailable — try a different one";
  if (msg.includes("temporarily paused") || msg.includes("interface is paused") || msg.includes("model is paused") || msg.includes("paused by kie"))
    return "KIE has temporarily paused this model — try a different one";
  if (msg.includes("this field is required"))
    return "Video model rejected the request — try a different video model";
  if (msg.includes("timed out") || msg.includes("timeout"))
    return "Still generating — this can take longer than usual on some models. Refresh the page to check status; the job will finish on KIE in the background.";
  if (msg.includes("no task id") || msg.includes("no taskid"))
    return "Failed to queue task — the model may be unavailable, try another";
  // KIE / Veo safety filters flag anything the model interprets as a
  // reference to a real person, brand, copyrighted character, or sensitive
  // content. It's a per-beat problem — the same model with a different prompt
  // usually works — so we route the user to rephrasing rather than to
  // changing the model.
  if (msg.includes("safety filter") || msg.includes("safety_filter")
    || msg.includes("prominent public figure")
    || msg.includes("content policy") || msg.includes("policy violation")
    || msg.includes("blocked by moderation") || msg.includes("moderated"))
    return "Content policy block — the prompt references something the model refuses to render (real person, brand, or restricted topic). Rephrase this beat's prompt in Prompt Studio, then retry.";
  if (msg.includes("nsfw") || msg.includes("unsafe content") || msg.includes("adult content"))
    return "Content policy block — the prompt was flagged as unsafe. Rephrase this beat's prompt in Prompt Studio, then retry.";
  if (msg.includes("no url") || msg.includes("no image url") || msg.includes("completed but no url"))
    return "Image was generated but could not be retrieved — try again";
  if (msg.includes("rate limit") || msg.includes("too many requests"))
    return "Too many requests — wait a moment and try again";

  // Unmapped: the provider's own sentence is usually the most useful thing we
  // have, so keep it — but never hand the user a payload or a stack trace.
  if (!looksLikeMachineOutput(text)) return text.trim();
  return "Something went wrong — please try again";
}
