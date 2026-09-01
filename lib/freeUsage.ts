import { supabase } from "@/lib/supabase/client";

// Historical rows for the removed BYO providers ("image", "tts_chars")
// stay in the table; nothing reads or writes them now.
export type FreeUsageKind = "qwen_tts_chars" | "ai33_tts_chars" | "free_image_credits";

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

// Sum for one kind across the current calendar month (0 on any error).
// Both surviving kinds are monthly quotas, so we aggregate the per-day
// free_usage rows from the 1st of this month. Fail-soft: a failed read
// reports 0 used rather than blocking a generation.
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
