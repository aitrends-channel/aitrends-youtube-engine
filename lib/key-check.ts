// Live credential checks for the keys a client brings. One home for them, so
// the dashboard's status cards and the Setup save path can never disagree
// about whether a key works or why it doesn't.
//
// The shared rule: only a definitive rejection counts as invalid. Anything
// else (a timeout, a 500, a shape we don't recognise) reports "configured,
// balance unknown" so an upstream hiccup never makes a working key look
// broken, and never blocks a save.

export interface KeyCheck {
  configured: boolean;
  valid: boolean | null;
  /**
   * Why there is no balance, when we know. Lets the UI say something true
   * instead of guessing:
   *   scope    the key works but can't read the account (needs user_read)
   *   key_id   the saved value is a key ID, not the key itself
   * Absent means the balance is simply unknown (a transient upstream blip).
   */
  balanceIssue?: "scope" | "key_id";
}

export interface KieCheck extends KeyCheck {
  credits?: number;
}

/** The scopes we actually call. A key can authenticate while lacking either. */
export type ElevenLabsScope = "user_read" | "voices_read";

export interface ElevenLabsCheck extends KeyCheck {
  /** Characters remaining this billing cycle. */
  remaining?: number;
  /** Total characters in the plan (e.g. 10000 for Free, 30000 for Starter). */
  limit?: number;
  /** Scopes ElevenLabs says the key is missing. Absent when it has both, or
   *  when we couldn't tell (an unreachable API is not a missing scope). */
  missingScopes?: ElevenLabsScope[];
}

/**
 * Whether the key may list voices. Its own request because
 * /v1/user/subscription only ever reports on user_read: a key without
 * voices_read passes that check and then quietly returns nothing from the
 * voice picker, which falls back to the static list rather than erroring. A
 * third of paying accounts were missing a scope with nothing on screen saying
 * so.
 *
 * null means unknown, kept distinct from false so a blip never reads as a
 * missing permission.
 */
async function checkVoicesScope(key: string): Promise<boolean | null> {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key },
    });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) {
      const body = await res.json().catch(() => null) as { detail?: { status?: string } } | null;
      if (body?.detail?.status === "missing_permissions") return false;
    }
    return null;
  } catch {
    return null;
  }
}

export async function checkElevenLabs(key: string): Promise<ElevenLabsCheck> {
  if (!key) return { configured: false, valid: null };
  // Both probes in flight together: the scope answer is worth having on every
  // status read, but not at the cost of a second round trip's latency.
  const [base, voicesRead] = await Promise.all([
    readSubscription(key),
    checkVoicesScope(key),
  ]);
  if (base.valid !== true) return base;

  const missingScopes: ElevenLabsScope[] = [];
  if (base.balanceIssue === "scope") missingScopes.push("user_read");
  if (voicesRead === false) missingScopes.push("voices_read");
  return missingScopes.length > 0 ? { ...base, missingScopes } : base;
}

// ElevenLabs exposes per-user quota via /v1/user/subscription.
// character_count is "used this billing period"; character_limit is the
// plan's allowance. Remaining = limit - used. We swallow non-2xx
// non-auth responses as "valid: true" (configured but unknown balance)
// so a transient ElevenLabs hiccup doesn't make the UI look broken.
async function readSubscription(key: string): Promise<ElevenLabsCheck> {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": key },
    });
    if (res.status === 401 || res.status === 403) {
      // ElevenLabs returns 401 for two very different reasons. We have
      // to inspect the body to distinguish them:
      //   { detail: { status: "invalid_api_key", ... } }
      //     → key really is bad. Mark invalid.
      //   { detail: { status: "missing_permissions", ... } }
      //     → key works fine for TTS but lacks user_read scope to view
      //       balance. Treat as configured/valid with no balance number.
      try {
        const body = await res.json() as { detail?: { status?: string; code?: string } };
        if ((body?.detail?.code ?? body?.detail?.status) === "missing_permissions") {
          return { configured: true, valid: true, balanceIssue: "scope" };
        }
      } catch { /* non-JSON body — fall through to invalid */ }
      return { configured: true, valid: false };
    }
    if (!res.ok) {
      // Pasting the key ID instead of the key is an easy mistake: the
      // dashboard shows the ID permanently, while the key itself appears once
      // at creation. ElevenLabs rejects it with 400, which this branch used to
      // swallow as "configured, balance unknown" — so the card showed a green
      // Active badge for a credential that cannot generate a single word of
      // voiceover, and blamed the missing balance on a scope.
      try {
        const body = await res.json() as { detail?: { status?: string; code?: string; message?: string } };
        if (isElevenLabsKeyIdError(body?.detail?.code ?? body?.detail?.status, body?.detail?.message)) {
          return { configured: true, valid: false, balanceIssue: "key_id" };
        }
      } catch { /* non-JSON body — fall through */ }
      // Anything else non-2xx stays "configured, balance unknown" so a
      // transient ElevenLabs hiccup doesn't make a working key look broken.
      return { configured: true, valid: true };
    }
    const body = await res.json() as { character_count?: number; character_limit?: number };
    const used = body.character_count;
    const limit = body.character_limit;
    if (typeof used === "number" && typeof limit === "number") {
      return { configured: true, valid: true, remaining: Math.max(0, limit - used), limit };
    }
    return { configured: true, valid: true };
  } catch {
    return { configured: true, valid: true };
  }
}

/**
 * Whether ElevenLabs is saying "that is the ID, not the key".
 *
 * Matched on the body it actually sends, which is
 * `{ detail: { code: "invalid_api_key", message: "API key ID used as api key…" } }`.
 * The old check read `detail.status` for a code ElevenLabs has never used, so
 * it matched nothing: six production accounts saved an ID through a save path
 * built to refuse it, and their voiceovers failed with the vendor's own
 * wording months later.
 */
export function isElevenLabsKeyIdError(code: string | undefined, message: string | undefined): boolean {
  if (code === "api_key_id_used_as_api_key") return true;
  return /api key id used as (an )?api key/i.test(message ?? "");
}

/** The one sentence that explains the mistake, wherever it is noticed. Saving
 *  the key says it, and so does the voiceover that fails on one saved before
 *  the save path checked. */
export const ELEVENLABS_KEY_ID_MESSAGE =
  "That is the ElevenLabs key ID, not the key. The key starts with sk_ and is shown once, " +
  "in the dialog right after you create or rotate it on the API Keys page. Paste that into Settings.";

/**
 * Anthropic, for a client who bills their own Claude usage.
 *
 * The only key field with no check at all until now, which is how one account
 * came to hold its KIE key here and another twelve characters of something
 * else. Both fail every Claude call they are used for, hours after a save that
 * said it worked.
 */
export async function checkAnthropic(key: string): Promise<KeyCheck> {
  if (!key) return { configured: false, valid: null };
  // Anthropic keys are sk-ant-…; the console also shows an ID for each one,
  // which is the value people copy because it is the one always on screen.
  if (!key.startsWith("sk-ant-")) {
    return { configured: true, valid: false, balanceIssue: "key_id" };
  }
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (res.status === 401 || res.status === 403) return { configured: true, valid: false };
    // Same rule as the others: only a definitive rejection blocks a save.
    return { configured: true, valid: true };
  } catch {
    return { configured: true, valid: true };
  }
}

export async function checkKie(key: string): Promise<KieCheck> {
  if (!key) return { configured: false, valid: null };
  try {
    // KIE returns the balance directly in `data` as a number (can be
    // negative when the account is overdrawn). Endpoint name is unintuitive
    // — `/chat/credit` is the global account balance, not chat-specific.
    const res = await fetch("https://api.kie.ai/api/v1/chat/credit", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { configured: true, valid: false };
    }
    if (!res.ok) {
      return { configured: true, valid: true };
    }
    const body = await res.json() as { code?: number; data?: unknown };
    // KIE answers 200 to everything and puts the real status in the body:
    //   { code: 200, msg: "success",       data: 655.75 }
    //   { code: 401, msg: "Unauthorized …" }
    // Reading res.status alone reported a rejected key as configured-and-valid
    // with an unknown balance, so the dashboard showed a green Active badge
    // for a credential that fails every generation, and the save path let it
    // through. Only 401/403 count as a rejection; any other code stays
    // "valid, balance unknown" so a KIE-side blip can't lock anyone out.
    if (body.code === 401 || body.code === 403) {
      return { configured: true, valid: false };
    }
    const credits = typeof body.data === "number" ? body.data : undefined;
    return { configured: true, valid: true, ...(credits !== undefined ? { credits } : {}) };
  } catch {
    return { configured: true, valid: true };
  }
}

/**
 * Why a save was refused, phrased for the person who just pasted the value.
 * Returns null when the check found nothing wrong, so callers can use it as
 * the gate itself.
 */
export function keyRejectionMessage(
  provider: "kie" | "elevenlabs" | "anthropic", check: KeyCheck,
): string | null {
  if (check.valid !== false) return null;
  if (provider === "anthropic") {
    return check.balanceIssue === "key_id"
      ? "That does not look like an Anthropic key. They start with sk-ant- and are shown once, when you create them at console.anthropic.com/settings/keys."
      : "Anthropic rejected that key. Check the whole value was copied, or create a new one.";
  }
  if (provider === "elevenlabs") {
    // The key ID really is the common mistake, not an expired key: of the 16
    // prod accounts holding one, the 12 that ever had working voiceover each
    // stopped on a different date, which is what individual mis-pastes look
    // like. An expiry would have stopped them all on the same day.
    return check.balanceIssue === "key_id"
      ? ELEVENLABS_KEY_ID_MESSAGE
      : "ElevenLabs rejected that key. Check the whole value was copied, or create a new key.";
  }
  return "KIE rejected that key. Check the whole value was copied, or create a new key.";
}
