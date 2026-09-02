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

// The four content-policy outcomes. They are constants because the generate
// step has to recognise them: a policy block is fixed by rephrasing the beat,
// not by switching models, so the banner must drop its "try another model"
// advice when every failure is one of these. It used to test for a prefix no
// message actually carried, so that advice showed on every content block.
const BLOCK_PERSON = "Blocked: reads as a real person or brand. Rephrase this beat's prompt.";
const BLOCK_UNSAFE = "Blocked as unsafe. Rephrase this beat's prompt.";
const BLOCK_AUDIO = "Blocked by the audio filter. Remove dialogue and lyrics from this beat's prompt.";
const BLOCK_GENERIC = "Blocked by the content filter. Rephrase this beat's prompt.";

const CONTENT_BLOCK_MESSAGES: ReadonlySet<string> = new Set([
  BLOCK_PERSON, BLOCK_UNSAFE, BLOCK_AUDIO, BLOCK_GENERIC,
]);

/** True for a friendlyError() result the user fixes by rewriting the prompt.
 *  Takes the mapped message, not the raw provider text. */
/**
 * Our own provider account is empty, rather than anything about this run.
 *
 * Worth telling apart from a normal failure because the advice differs: no
 * amount of switching models helps when the account every model on that
 * operator bills to is dry. The user can do nothing, which is what the message
 * says, so the banner should not also tell them to try something.
 */
export function isProviderAccountEmpty(message: string | undefined | null): boolean {
  const m = (message ?? "").toLowerCase();
  return m.includes("image provider account is out of credit")
    || m.includes("provider account is out of credit");
}

export function isContentBlockMessage(message: string | undefined | null): boolean {
  return CONTENT_BLOCK_MESSAGES.has((message ?? "").trim());
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

/**
 * Which provider ran this, for messages that would otherwise blame the wrong
 * one now that images run on PoYo as often as on KIE.
 *
 * The caller passes it when it knows. When it does not, the error text says so
 * itself: both clients stamp their own name into what they throw ("kie.ai
 * error 429 on /api/…", "PoYo 400: …"), and that text is what reaches the
 * client and the beat row alike. Null when neither can tell, which is what
 * keeps the generic wording honest rather than guessing at KIE.
 */
function providerName(msg: string, operator?: string | null): string | null {
  if (operator === "poyo") return "PoYo";
  if (operator === "kie") return "KIE";
  if (operator === "genaipro") return "GenAIPro";
  if (/\bpoyo\b/.test(msg)) return "PoYo";
  if (/\bkie\b|kie\.ai/.test(msg)) return "KIE";
  return null;
}

/**
 * What an empty provider balance means on a Heclus Credits account.
 *
 * That KIE (or PoYo, or Anthropic) account is ours: the customer never opened
 * it and cannot pay it. Their own credits are a separate ledger and are not
 * what ran out, so sending them to a top-up page is advice they cannot act on
 * and a bill they should not think they owe.
 */
const PLATFORM_OUT_OF_CREDIT =
  "We have run out of generation credit on our side. Your Heclus credits are untouched, so this needs support rather than a top-up.";

/**
 * Take the vendor top-up out of a sentence that was worded for a BYO account.
 *
 * Two cases need it. A failure persisted before this account moved to credits
 * (or before this rule existed) still carries "Top up at kie.ai" in the
 * database, and an admin previewing the credits experience is reading text a
 * server that knows nothing of that preview wrote. Both are the same repair:
 * the counts and the resume instruction are worth keeping, the billing page is
 * not.
 */
export function forCreditsViewer(text: string | null | undefined, platformFunded: boolean): string {
  const t = (text ?? "").trim();
  if (!platformFunded || !t) return t;
  if (!/kie\.ai|kie credits/i.test(t)) return t;
  return t
    .replace(/KIE credits exhausted\.\s*Top up at kie\.ai\./i, PLATFORM_OUT_OF_CREDIT)
    .replace(/Ran out of KIE credits/i, "We ran out of generation credit on our side")
    .replace(/Top up at kie\.ai,\s*then click/i, "Once we have topped our side up, click")
    .replace(/Top up (your account )?at kie\.ai(\/billing)?\.?/i, "This one is ours to fix.");
}

export interface FriendlyErrorContext {
  /** True when the run signs with our provider keys rather than the
   *  customer's, which is every wallet-funded (Heclus Credits) account. */
  platformFunded?: boolean;
}

export function friendlyError(raw: string | undefined | null, operator?: string | null, ctx?: FriendlyErrorContext): string {
  const original = (raw ?? "").trim();
  if (!original) return "Something went wrong. Please try again.";

  const { text, errorType, status } = unwrapPayload(original);
  const msg = `${text} ${errorType ?? ""}`.toLowerCase();
  const provider = providerName(msg, operator);
  // Sentence-initial form. Unknown provider drops the attribution rather than
  // saying "the provider did…", which reads like a placeholder nobody replaced.
  const who = provider ?? "The provider";

  // ── Veo filter codes ────────────────────────────────────────────────────
  // The free lane forwards Veo's own code verbatim ("Video generation failed:
  // PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED"), which reads as a crash to a
  // customer. Matched before everything else because the code names the exact
  // filter that fired, and because a payload carrying one alongside a 5xx
  // would otherwise be reported as a transient error and retried forever.
  const veoFilter = /public_error_([a-z0-9_]+)/.exec(msg)?.[1];
  if (veoFilter) {
    if (veoFilter.includes("prominent_people") || veoFilter.includes("celebrity") || veoFilter.includes("face"))
      return BLOCK_PERSON;
    if (veoFilter.includes("audio")) return BLOCK_AUDIO;
    if (veoFilter.includes("danger") || veoFilter.includes("violence") || veoFilter.includes("sexual")
      || veoFilter.includes("unsafe") || veoFilter.includes("child") || veoFilter.includes("rai"))
      return BLOCK_UNSAFE;
    return BLOCK_GENERIC;
  }

  // ── LLM / API provider failures ─────────────────────────────────────────
  // Name KIE outright only where the trigger is KIE's own wording ("server
  // exception", "fail code 500"). Everything keyed on a generic phrase uses
  // `who`, which resolves per run: telling a PoYo user their KIE job is still
  // generating names an account the work never touched.
  // These are the shapes the script, topic, prompts and visuals steps hit.
  // 500/529 and rate limits are transient and worth retrying; the rest are
  // configuration problems the user (or we) has to fix.
  // KIE's own 500 wording, checked BEFORE the generic 5xx rule below so it
  // keeps its attribution. Naming KIE is enough — it says where the failure
  // came from without defending Heclus, which just draws attention to the
  // question. The generic rule below must stay unattributed: the same 5xx
  // shapes arrive from Anthropic direct (heclus_direct routing) and the
  // free-tier providers, and blaming KIE for those would be wrong.
  if (msg.includes("server exception"))
    return "KIE failed, you may try again.";
  // "fail code 500" is KIE's task-status wording, not an HTTP status, but
  // unwrapPayload scrapes any 3-digit run as one — so this has to be matched
  // before the generic 500 rule, which would otherwise shadow it and strip
  // the KIE attribution.
  if (msg.includes("fail code 500"))
    return "KIE failed on this model. Try a different model.";
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

  // ── Heclus Credits ──────────────────────────────────────────────────────
  // Our own refusal, worded once in lib/heclus-charge.ts and passed through
  // here unchanged: it already names the wallet and where to top it up, and
  // rewording it would leave two versions of the same sentence to keep in step.
  // Matched before the KIE credit rules below, which would otherwise send a
  // wallet-funded user to kie.ai to top up an account they do not have.
  if (msg.includes("heclus credits")) return text.trim();

  // ── Free-provider (BYO) errors ──────────────────────────────────────────
  // Already user-worded from the API, so pass them through before the KIE
  // mappings below mislabel them (a Google "Quota exceeded…" message is NOT a
  // KIE rate limit).
  if (msg.includes("cloudflare")) return text.trim();
  // Anthropic's own out-of-credit wording, matched BEFORE the KIE credit rules
  // below. "Your credit balance is too low to access the Anthropic API" contains
  // "credit balance", so it was being reported as "KIE credits exhausted. Top up
  // at kie.ai." — sending a client with a full KIE balance to top up the wrong
  // account, on a step they had deliberately moved off KIE.
  //
  // Deliberately does not assert WHOSE Anthropic account: this same error also
  // arrives from heclus_direct steps, where the empty account is Heclus's and
  // the client can do nothing about it. friendlyError has no routing context to
  // tell the two apart.
  if ((msg.includes("credit balance") || msg.includes("purchase credits") || msg.includes("too low"))
    && (msg.includes("anthropic") || msg.includes("plans & billing") || msg.includes("plans and billing")))
    return ctx?.platformFunded
      ? PLATFORM_OUT_OF_CREDIT
      : "Out of Anthropic credit. If this step runs on your own Anthropic key, top up at console.anthropic.com or switch back to KIE in Setup.";
  // Whose account is empty decides what the user can do about it. A KIE
  // balance can be theirs; PoYo runs on Heclus's key with no per-client path,
  // so sending that customer to top something up would be advice they cannot
  // act on.
  const outOfProviderCredit = ctx?.platformFunded
    ? PLATFORM_OUT_OF_CREDIT
    : provider === "PoYo"
      ? "PoYo is out of credit. That account is ours, so this needs support rather than a top-up."
      : "KIE credits exhausted. Top up at kie.ai.";
  if (msg.includes("credits insufficient") || msg.includes("insufficient credits") || (msg.includes("insufficient") && (msg.includes("balance") || msg.includes("credit") || msg.includes("fund"))))
    return outOfProviderCredit;
  if (msg.includes("credits remaining") || msg.includes("credit balance"))
    return outOfProviderCredit;
  if (msg.includes("quota_exceeded") || msg.includes("quota exceeded"))
    return provider ? `${provider} rate limit hit. Wait a minute, then retry.` : "Rate limit hit. Wait a minute, then retry.";
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
    return provider ? `This model is paused on ${provider}. Try a different one.` : "This model is paused. Try a different one.";
  if (msg.includes("this field is required"))
    return `${who} rejected the video request. Try another video model.`;
  // Not a failure and no longer something to refresh for: the task is still
  // running at the provider, and the callback or the poller writes the beat
  // when it lands, whichever gets there first.
  if (msg.includes("timed out") || msg.includes("timeout"))
    return provider ? `Still generating on ${provider}. It will appear here when it is ready.` : "Still generating. It will appear here when it is ready.";
  if (msg.includes("no task id") || msg.includes("no taskid"))
    return `${who} did not queue the job. Try another model.`;
  // KIE / Veo safety filters flag anything the model interprets as a
  // reference to a real person, brand, copyrighted character, or sensitive
  // content. It's a per-beat problem — the same model with a different prompt
  // usually works — so we route the user to rephrasing rather than to
  // changing the model.
  if (msg.includes("safety filter") || msg.includes("safety_filter")
    || msg.includes("prominent public figure")
    || msg.includes("content policy") || msg.includes("policy violation")
    || msg.includes("blocked by moderation") || msg.includes("moderated"))
    return BLOCK_PERSON;
  if (msg.includes("nsfw") || msg.includes("unsafe content") || msg.includes("adult content"))
    return BLOCK_UNSAFE;
  if (msg.includes("no url") || msg.includes("no image url") || msg.includes("completed but no url"))
    return "Image generated but could not be retrieved. Try again.";
  if (msg.includes("rate limit") || msg.includes("too many requests"))
    return "Too many requests. Wait a moment, then retry.";

  // Unmapped: the provider's own sentence is usually the most useful thing we
  // have, so keep it — but never hand the user a payload or a stack trace.
  if (!looksLikeMachineOutput(text)) return text.trim();
  return "Something went wrong. Please try again.";
}
