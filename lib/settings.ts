import { supabase } from "@/lib/supabase/client";

export interface AppSettings {
  anthropic_api_key: string;
  kie_api_key: string;
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
    .from("app_settings")
    .select("anthropic_api_key, kie_api_key, elevenlabs_api_key")
    .eq("user_id", userId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.warn("[settings] DB fetch failed, using env fallback:", error.message);
  }

  const result: AppSettings = {
    anthropic_api_key:  data?.anthropic_api_key?.trim()  || process.env.ANTHROPIC_API_KEY  || "",
    kie_api_key:        data?.kie_api_key?.trim()        || process.env.KIE_API_KEY        || "",
    elevenlabs_api_key: data?.elevenlabs_api_key?.trim() || process.env.ELEVENLABS_API_KEY || "",
  };
  cacheMap.set(userId, { data: result, at: Date.now() });
  return result;
}
