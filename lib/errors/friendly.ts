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
  if (!original) return "Something went wrong. Please try again.";

  const { text, errorType, status } = unwrapPayload(original);
  const msg = `${text} ${errorType ?? ""}`.toLowerCase();

  // ── LLM / API provider failures ─────────────────────────────────────────
  // These are the shapes the script, topic, prompts and visuals steps hit.
  // 500/529 and rate limits are transient and worth retrying; the rest are
  // configuration problems the user (or we) has to fix.
  // KIE's own 500 wording, checked BEFORE the generic 5xx rule below so it
  // keeps its attribution. Every KIE-caused message names KIE, because
  // otherwise users read a provider outage as Heclus being broken. The
  // generic rule below must stay unattributed: the same 5xx shapes arrive
  // from Anthropic direct (heclus_direct routing) and the free-tier
  // providers, and blaming KIE for those would be wrong.
  if (msg.includes("server exception"))
    return "KIE is failing on their side, not Heclus. Try again in a few minutes.";
  // "fail code 500" is KIE's task-status wording, not an HTTP status, but
  // unwrapPayload scrapes any 3-digit run as one — so this has to be matched
  // before the generic 500 rule, which would otherwise shadow it and strip
  // the KIE attribution.
  if (msg.includes("fail code 500"))
    return "KIE says this model is unavailable. Try a different model.";
  if (errorType === "overloaded_error" || status === 529 || msg.includes("overloaded"))
    return "The AI service is overloaded. Wait a moment, then retry.";
  if (errorType === "api_error" || status === 500 || status === 502 || status === 503)
    return "The AI service hit a temporary error. Try again in a moment.";
  if (errorType === "rate_limit_error" || status === 429)
    return "Too many requests. Wait a moment, then retry.";
  if (errorType === "authentication_error" || status === 401)
    return "AI service key is invalid. Update it in Settings.";
  if (errorType === "permission_error" || status === 403)
    return "This model is not available on your key. Pick another in Settings.";
  if (errorType === "not_found_error" || status === 404)
    return "Model not found. Pick another in Settings.";
  if (errorType === "request_too_large" || status === 413)
    return "Request too large. Shorten the script or reduce the beats.";

  // ── Free-provider (BYO) errors ──────────────────────────────────────────
  // Already user-worded from the API, so pass them through before the KIE
  // mappings below mislabel them (a Google "Quota exceeded…" message is NOT a
  // KIE rate limit).
  if (msg.includes("cloudflare")) return text.trim();
  if (msg.includes("credits insufficient") || msg.includes("insufficient credits") || (msg.includes("insufficient") && (msg.includes("balance") || msg.includes("credit") || msg.includes("fund"))))
    return "KIE credits exhausted. Top up at kie.ai.";
  if (msg.includes("credits remaining") || msg.includes("credit balance"))
    return "KIE credits exhausted. Top up at kie.ai.";
  if (msg.includes("quota_exceeded") || msg.includes("quota exceeded"))
    return "KIE rate limit hit, not Heclus. Wait a minute, then retry.";
  if (msg.includes("invalid_api_key") || msg.includes("invalid api key") || msg.includes("unauthorized") || (msg.includes("api key") && msg.includes("invalid")))
    return "API key is invalid. Update it in Settings.";
  if (msg.includes("api key") && (msg.includes("missing") || msg.includes("not set") || msg.includes("required")))
    return "API key not set. Add it in Settings.";
  // Deliberately unattributed: "internal server error" is Anthropic's own
  // wording as well as a KIE one, and with no status prefix to disambiguate
  // there is no way to tell whose fault it is. KIE's own task-status phrasing
  // ("fail code 500") is matched earlier, where naming KIE is correct.
  if (msg.includes("internal error") || msg.includes("internal server error"))
    return "The model is temporarily unavailable. Try a different one.";
  if (msg.includes("temporarily paused") || msg.includes("interface is paused") || msg.includes("model is paused") || msg.includes("paused by kie"))
    return "KIE paused this model. Try a different one.";
  if (msg.includes("this field is required"))
    return "KIE's video model rejected the request. Try another video model.";
  if (msg.includes("timed out") || msg.includes("timeout"))
    return "Still generating on KIE. Refresh the page to check status.";
  if (msg.includes("no task id") || msg.includes("no taskid"))
    return "KIE would not queue the job. Try another model.";
  // KIE / Veo safety filters flag anything the model interprets as a
  // reference to a real person, brand, copyrighted character, or sensitive
  // content. It's a per-beat problem — the same model with a different prompt
  // usually works — so we route the user to rephrasing rather than to
  // changing the model.
  if (msg.includes("safety filter") || msg.includes("safety_filter")
    || msg.includes("prominent public figure")
    || msg.includes("content policy") || msg.includes("policy violation")
    || msg.includes("blocked by moderation") || msg.includes("moderated"))
    return "Content blocked by the model (real person, brand, or restricted topic). Rephrase this beat's prompt, then retry.";
  if (msg.includes("nsfw") || msg.includes("unsafe content") || msg.includes("adult content"))
    return "Content flagged as unsafe. Rephrase this beat's prompt, then retry.";
  if (msg.includes("no url") || msg.includes("no image url") || msg.includes("completed but no url"))
    return "Image generated but could not be retrieved. Try again.";
  if (msg.includes("rate limit") || msg.includes("too many requests"))
    return "Too many requests. Wait a moment, then retry.";

  // Unmapped: the provider's own sentence is usually the most useful thing we
  // have, so keep it — but never hand the user a payload or a stack trace.
  if (!looksLikeMachineOutput(text)) return text.trim();
  return "Something went wrong. Please try again.";
}
