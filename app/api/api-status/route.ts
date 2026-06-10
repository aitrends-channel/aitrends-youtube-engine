export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export interface ApiStatusResult {
  kie: { configured: boolean; valid: boolean | null; credits?: number };
  elevenlabs: {
    configured: boolean;
    valid: boolean | null;
    /** Characters remaining this billing cycle. */
    remaining?: number;
    /** Total characters in the plan (e.g. 10000 for Free, 30000 for Starter). */
    limit?: number;
  };
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const s = await getSettings(user.id);
  const [kie, elevenlabs] = await Promise.all([
    checkKie(s.kie_api_key),
    checkElevenLabs(s.elevenlabs_api_key),
  ]);
  return NextResponse.json({ kie, elevenlabs } satisfies ApiStatusResult);
}

// ElevenLabs exposes per-user quota via /v1/user/subscription.
// character_count is "used this billing period"; character_limit is the
// plan's allowance. Remaining = limit - used. We swallow non-2xx
// non-auth responses as "valid: true" (configured but unknown balance)
// so a transient ElevenLabs hiccup doesn't make the UI look broken.
async function checkElevenLabs(key: string) {
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
          return { configured: true, valid: true };
        }
      } catch { /* non-JSON body — fall through to invalid */ }
      return { configured: true, valid: false };
    }
    if (!res.ok) {
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

async function checkKie(key: string) {
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
