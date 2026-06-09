import { supabase } from "@/lib/supabase/client";

export interface AppSettings {
  kie_api_key: string;
  /** Per-user ElevenLabs key used by the worker for STT (speech-to-text)
   *  during assembly. Optional — falls back to ELEVENLABS_API_KEY on the
   *  worker process when the user hasn't set their own. */
  elevenlabs_api_key: string;
}

const cacheMap = new Map<string, { data: AppSettings; at: number }>();
const TTL_MS = 60_000;

export function invalidateSettingsCache(userId: string) {
  cacheMap.delete(userId);
}

export async function getSettings(userId: string): Promise<AppSettings> {
  const cached = cacheMap.get(userId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

  const { data, error } = await supabase
    .from("account_settings")
    .select("kie_api_key, elevenlabs_api_key")
    .eq("user_id", userId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.warn("[settings] DB fetch failed, using env fallback:", error.message);
  }

  const result: AppSettings = {
    kie_api_key: data?.kie_api_key?.trim() || process.env.KIE_API_KEY || "",
    elevenlabs_api_key: data?.elevenlabs_api_key?.trim() || process.env.ELEVENLABS_API_KEY || "",
  };
  cacheMap.set(userId, { data: result, at: Date.now() });
  return result;
}
