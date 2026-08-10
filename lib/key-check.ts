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

export interface ElevenLabsCheck extends KeyCheck {
  /** Characters remaining this billing cycle. */
  remaining?: number;
  /** Total characters in the plan (e.g. 10000 for Free, 30000 for Starter). */
  limit?: number;
}

// ElevenLabs exposes per-user quota via /v1/user/subscription.
// character_count is "used this billing period"; character_limit is the
// plan's allowance. Remaining = limit - used. We swallow non-2xx
// non-auth responses as "valid: true" (configured but unknown balance)
// so a transient ElevenLabs hiccup doesn't make the UI look broken.
export async function checkElevenLabs(key: string): Promise<ElevenLabsCheck> {
  if (!key) return { configured: false, valid: null };
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
        const body = await res.json() as { detail?: { status?: string } };
        if (body?.detail?.status === "missing_permissions") {
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
        const body = await res.json() as { detail?: { status?: string } };
        if (body?.detail?.status === "api_key_id_used_as_api_key") {
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
export function keyRejectionMessage(provider: "kie" | "elevenlabs", check: KeyCheck): string | null {
  if (check.valid !== false) return null;
  if (provider === "elevenlabs") {
    return check.balanceIssue === "key_id"
      ? "That is an ElevenLabs key ID, not a key. Open the API Keys page, create or rotate a key, and paste the value starting with sk_ that it shows once."
      : "ElevenLabs rejected that key. Check the whole value was copied, or create a new key.";
  }
  return "KIE rejected that key. Check the whole value was copied, or create a new key.";
}
