import { supabase } from "@/lib/supabase/client";

export interface AppSettings {
  kie_api_key: string;
  /** Per-user ElevenLabs key used by the worker for STT (speech-to-text)
   *  during assembly. Optional — falls back to ELEVENLABS_API_KEY on the
   *  worker process when the user hasn't set their own. */
  elevenlabs_api_key: string;
  /** BYO free-tier providers. Each user brings their own account so they
   *  get their own free daily/monthly quota — no env fallback (never a
   *  shared aiTrends key). Empty string = not connected. */
  cloudflare_account_id: string;
  cloudflare_api_token: string;
  google_tts_key: string;
  /** Google AI Studio key for the free Gemini image model. */
  gemini_api_key: string;
}

const cacheMap = new Map<string, { data: AppSettings; at: number }>();
const TTL_MS = 60_000;

export function invalidateSettingsCache(userId: string) {
  cacheMap.delete(userId);
}

export async function getSettings(userId: string): Promise<AppSettings> {
  const cached = cacheMap.get(userId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

  let { data, error } = await supabase
    .from("account_settings")
    .select("kie_api_key, elevenlabs_api_key, cloudflare_account_id, cloudflare_api_token, google_tts_key, gemini_api_key")
    .eq("user_id", userId)
    .single();

  // 42703 = gemini_api_key column missing (migration 096 not applied
  // yet). Re-select without it so per-user keys keep working — a full
  // failure here would silently flip everyone onto the shared env KIE
  // key.
  if (error && error.code === "42703") {
    const fallback = await supabase
      .from("account_settings")
      .select("kie_api_key, elevenlabs_api_key, cloudflare_account_id, cloudflare_api_token, google_tts_key")
      .eq("user_id", userId)
      .single();
    data = fallback.data ? { ...fallback.data, gemini_api_key: null } : null;
    error = fallback.error;
  }

  if (error && error.code !== "PGRST116") {
    console.warn("[settings] DB fetch failed, using env fallback:", error.message);
  }

  const result: AppSettings = {
    kie_api_key: data?.kie_api_key?.trim() || process.env.KIE_API_KEY || "",
    elevenlabs_api_key: data?.elevenlabs_api_key?.trim() || process.env.ELEVENLABS_API_KEY || "",
    // BYO free providers — strictly per-user, no shared env fallback.
    cloudflare_account_id: data?.cloudflare_account_id?.trim() || "",
    cloudflare_api_token: data?.cloudflare_api_token?.trim() || "",
    google_tts_key: data?.google_tts_key?.trim() || "",
    gemini_api_key: data?.gemini_api_key?.trim() || "",
  };
  cacheMap.set(userId, { data: result, at: Date.now() });
  return result;
}
