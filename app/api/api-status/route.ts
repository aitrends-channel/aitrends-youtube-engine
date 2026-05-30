export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export interface ApiStatusResult {
  kie: { configured: boolean; valid: boolean | null; credits?: number };
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const s = await getSettings(user.id);
  const kie = await checkKie(s.kie_api_key);
  return NextResponse.json({ kie } satisfies ApiStatusResult);
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
