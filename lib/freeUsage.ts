import { supabase } from "@/lib/supabase/client";

// Daily free-image budget shown in the picker's usage bar. Cloudflare's
// real free tier is 10,000 Neurons/day; a FLUX Schnell 1024×1024 image is
// ~19 Neurons, so ~500 images/day is the honest estimate. Cloudflare
// enforces the true limit (a 429 once Neurons run out); this is the gauge.
export const FREE_IMAGE_DAILY_CAP = 500;

// Google Cloud TTS BYO free tier is 1,000,000 chars/MONTH (WaveNet/Neural2).
// Google enforces the true limit (a 429 once it's exhausted); this is the
// gauge shown in the voiceover Free tab. Unlike the image cap (daily), TTS
// is a monthly quota, so it's read via getFreeUsageThisMonth below.
export const FREE_TTS_MONTHLY_CAP = 1_000_000;

export type FreeUsageKind = "image" | "tts_chars" | "qwen_tts_chars" | "ai33_tts_chars";

// Fail-soft: a lost/failed counter write must never break a generation.
export async function incrementFreeUsage(userId: string, kind: FreeUsageKind, amount = 1): Promise<void> {
  if (!userId || amount <= 0) return;
  try {
    const { error } = await supabase.rpc("increment_free_usage", {
      p_user: userId,
      p_kind: kind,
      p_amount: amount,
    });
    if (error) console.warn(`[free-usage] increment failed kind=${kind}:`, error.message);
  } catch (e) {
    console.warn(`[free-usage] increment threw kind=${kind}:`, e instanceof Error ? e.message : e);
  }
}

// Today's count for one kind (0 on any error). CURRENT_DATE on the DB side
// keeps "today" consistent with the increment RPC's day stamp.
export async function getFreeUsageToday(userId: string, kind: FreeUsageKind): Promise<number> {
  try {
    const { data, error } = await supabase
      .from("free_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("kind", kind)
      .gte("day", new Date().toISOString().slice(0, 10))
      .maybeSingle();
    if (error) {
      console.warn(`[free-usage] read failed kind=${kind}:`, error.message);
      return 0;
    }
    return data?.count ?? 0;
  } catch (e) {
    console.warn(`[free-usage] read threw kind=${kind}:`, e instanceof Error ? e.message : e);
    return 0;
  }
}

// Sum for one kind across the current calendar month (0 on any error).
// TTS is a monthly quota (unlike the daily image cap), so we aggregate the
// per-day free_usage rows from the 1st of this month. Mirrors the daily
// reader's fail-soft behaviour.
export async function getFreeUsageThisMonth(userId: string, kind: FreeUsageKind): Promise<number> {
  try {
    const monthStart = new Date().toISOString().slice(0, 8) + "01"; // YYYY-MM-01
    const { data, error } = await supabase
      .from("free_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("kind", kind)
      .gte("day", monthStart);
    if (error) {
      console.warn(`[free-usage] month read failed kind=${kind}:`, error.message);
      return 0;
    }
    return (data ?? []).reduce((sum, r) => sum + ((r as { count?: number }).count ?? 0), 0);
  } catch (e) {
    console.warn(`[free-usage] month read threw kind=${kind}:`, e instanceof Error ? e.message : e);
    return 0;
  }
}
