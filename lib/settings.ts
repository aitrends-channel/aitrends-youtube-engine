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
  /** Client's own Anthropic key, for running Claude calls direct instead of
   *  through their KIE key. No env fallback — strictly the user's own, same
   *  rule as the free-tier BYO keys. Empty string = not connected. */
  anthropic_api_key: string;
  /** Whether to actually use the key above. Separate from its presence so the
   *  client can switch back to KIE without deleting it. */
  anthropic_direct_enabled: boolean;
}

const cacheMap = new Map<string, { data: AppSettings; at: number }>();
const TTL_MS = 60_000;

export function invalidateSettingsCache(userId: string) {
  cacheMap.delete(userId);
}

export async function getSettings(userId: string): Promise<AppSettings> {
  const cached = cacheMap.get(userId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

  // select("*") rather than a column list, deliberately. PostgREST fails the
  // WHOLE query on one unknown column, and this function is what hands out the
  // KIE key — so naming a column that a not-yet-applied migration hasn't
  // created reads as "no keys configured" for every user and stops all
  // generation, not just the feature that added the column. A missing column
  // now just arrives undefined and falls back below.
  const { data, error } = await supabase
    .from("account_settings")
    .select("*")
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
    // No env fallback, deliberately: ANTHROPIC_API_KEY in the environment is
    // Heclus's, and reading it here would bill Heclus for a call the client
    // asked to pay for themselves.
    anthropic_api_key: (data?.anthropic_api_key as string | null)?.trim() || "",
    anthropic_direct_enabled: (data?.anthropic_direct_enabled as boolean | null) ?? false,
  };
  cacheMap.set(userId, { data: result, at: Date.now() });
  return result;
}
