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
  /** Global default character-consistency text appended to every image
   *  prompt at generation time. Non-secret free text; empty string = no
   *  default text. Per-project overrides live on the projects row — see
   *  lib/character-consistency.ts for the resolution. */
  character_consistency_text: string;
  /** User-chosen Claude model for the prompt steps. Empty string = no pick,
   *  use the admin default. Only honoured for Pro plans, allowlisted ids,
   *  and client_kie routing — see resolveModelForUser in lib/claude/models.ts.
   *  Not a secret. */
  claude_model: string;
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
    .select("kie_api_key, elevenlabs_api_key, character_consistency_text, claude_model")
    .eq("user_id", userId)
    .single();

  if (error && error.code !== "PGRST116") {
    console.warn("[settings] DB fetch failed, using env fallback:", error.message);
  }

  const result: AppSettings = {
    kie_api_key: data?.kie_api_key?.trim() || process.env.KIE_API_KEY || "",
    elevenlabs_api_key: data?.elevenlabs_api_key?.trim() || process.env.ELEVENLABS_API_KEY || "",
    // BYO free providers — strictly per-user, no shared env fallback.
    // Free text, not a secret — preserve as stored (only the surrounding
    // whitespace is trimmed at append time, not here).
    character_consistency_text: data?.character_consistency_text ?? "",
    // No env fallback — a model preference is strictly per-user, and an
    // unset value has to mean "use the admin default", not a shared one.
    claude_model: (data?.claude_model as string | null)?.trim() || "",
  };
  cacheMap.set(userId, { data: result, at: Date.now() });
  return result;
}
