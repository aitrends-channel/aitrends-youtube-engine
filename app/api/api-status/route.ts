export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export interface ApiStatusResult {
  kie:        { configured: boolean; valid: boolean | null; credits?: number };
  elevenlabs: { configured: boolean; valid: boolean | null; charUsed?: number; charLimit?: number; tier?: string };
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

async function checkKie(key: string) {
  if (!key) return { configured: false, valid: null };
  const endpoints = [
    "/api/v1/account",
    "/api/v1/user/balance",
    "/api/v1/user/info",
    "/api/v1/credits",
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(`https://api.kie.ai${endpoint}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        const credits = (data.credits ?? data.balance ?? data.remaining_credits ?? data.credit_balance) as number | undefined;
        return { configured: true, valid: true, ...(credits !== undefined ? { credits } : {}) };
      }
      if (res.status === 401 || res.status === 403) {
        return { configured: true, valid: false };
      }
    } catch { /* try next */ }
  }
  return { configured: true, valid: true };
}

async function checkElevenLabs(key: string) {
  if (!key) return { configured: false, valid: null };
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": key },
    });
    if (res.ok) {
      const data = await res.json() as {
        character_count?: number;
        character_limit?: number;
        tier?: string;
      };
      return {
        configured: true,
        valid: true,
        charUsed: data.character_count,
        charLimit: data.character_limit,
        tier: data.tier,
      };
    }
    return { configured: true, valid: false };
  } catch {
    return { configured: true, valid: false };
  }
}
