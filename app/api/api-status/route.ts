export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export interface ApiStatusResult {
  anthropic:   { configured: boolean; valid: boolean | null };
  youtube:     { configured: boolean; valid: boolean | null };
  kie:         { configured: boolean; valid: boolean | null; credits?: number };
  elevenlabs:  { configured: boolean; valid: boolean | null; charUsed?: number; charLimit?: number; tier?: string };
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const s = await getSettings(user.id);

  const [anthropic, youtube, kie, elevenlabs] = await Promise.all([
    checkAnthropic(s.anthropic_api_key),
    checkYouTube(s.youtube_api_key),
    checkKie(s.kie_api_key),
    checkElevenLabs(s.elevenlabs_api_key),
  ]);

  return NextResponse.json({ anthropic, youtube, kie, elevenlabs } satisfies ApiStatusResult);
}

async function checkAnthropic(key: string) {
  if (!key) return { configured: false, valid: null };
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    return { configured: true, valid: res.ok };
  } catch {
    return { configured: true, valid: false };
  }
}

async function checkYouTube(key: string) {
  if (!key) return { configured: false, valid: null };
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${key}`;
    const res = await fetch(url);
    return { configured: true, valid: res.ok };
  } catch {
    return { configured: true, valid: false };
  }
}

async function checkKie(key: string) {
  if (!key) return { configured: false, valid: null };
  try {
    const res = await fetch("https://api.kie.ai/api/v1/account", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      const data = await res.json() as { credits?: number; balance?: number };
      const credits = data.credits ?? data.balance;
      return { configured: true, valid: true, ...(credits !== undefined ? { credits } : {}) };
    }
    return { configured: true, valid: res.status !== 401 && res.status !== 403 };
  } catch {
    return { configured: true, valid: false };
  }
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
