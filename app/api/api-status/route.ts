export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkElevenLabs, checkKie, type ElevenLabsCheck, type KieCheck } from "@/lib/key-check";
import type { User } from "@supabase/supabase-js";

export interface ApiStatusResult {
  kie: KieCheck;
  elevenlabs: ElevenLabsCheck;
  /**
   * The client's own Anthropic key. No balance to report: Anthropic bills in
   * tokens against the account, and there is no cheap endpoint that returns a
   * remaining figure the way KIE and ElevenLabs do (usage needs an admin key
   * and the org usage report, not the key clients paste into Setup). So the
   * usage figure comes from our own ledger instead: tokens logged against this
   * user over the last 30 days. Undefined means the query failed, which is
   * different from zero.
   */
  anthropic: { configured: boolean; directEnabled: boolean; tokens30d?: number };
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  // The card answers "what have I connected", so it reports THIS ACCOUNT's
  // keys. getSettings resolves kie_api_key and elevenlabs_api_key to the
  // platform env key when the user has none, which made the card show Active
  // and the platform balance to someone who had never saved a key: nothing on
  // screen said what was missing, and the number shown was not theirs.
  const s = await getSettings(user.id);
  const { data: row } = await supabase
    .from("account_settings")
    .select("kie_api_key, elevenlabs_api_key, anthropic_api_key")
    .eq("user_id", user.id)
    .maybeSingle();
  const own = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const stored = row as Record<string, unknown> | null;

  const [kie, elevenlabs] = await Promise.all([
    checkKie(own(stored?.kie_api_key)),
    checkElevenLabs(own(stored?.elevenlabs_api_key)),
  ]);
  const anthropic = {
    configured: !!own(stored?.anthropic_api_key),
    directEnabled: !!s.anthropic_direct_enabled,
    tokens30d: await claudeTokens30d(user.id),
  };
  return NextResponse.json({ kie, elevenlabs, anthropic } satisfies ApiStatusResult);
}

// Anthropic gives clients no readable balance, so the card's usage figure
// comes from project_costs, which already records token counters for every
// call routed to the client's own key. Input and output only: cache reads and
// cache writes are billed at different rates and adding them to a single
// "tokens" figure would overstate what was spent.
const CLAUDE_TOKEN_KINDS = ["claude_tokens_in", "claude_tokens_out"];

async function claudeTokens30d(userId: string): Promise<number | undefined> {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("project_costs")
      .select("units")
      .eq("user_id", userId)
      .eq("provider", "anthropic")
      .in("unit_kind", CLAUDE_TOKEN_KINDS)
      .gte("created_at", since);
    if (error) return undefined;
    return (data ?? []).reduce((sum, r) => sum + (r.units ?? 0), 0);
  } catch {
    return undefined;
  }
}
