import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { getHeclusBalance, listHeclusLedger } from "@/lib/heclus-credits";
import { supabase } from "@/lib/supabase/client";
import { isProductionEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

// Balance and history for the Heclus Credits wallet.
//
// Separate route from /api/credits, which serves the free GenAI video wallet.
// Two wallets, two payloads: merging them would mean the panel could not tell
// which balance a number belonged to, and these two are counted in different
// units.
export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const [balance, ledger] = await Promise.all([
    getHeclusBalance(user),
    listHeclusLedger(user.id, 25),
  ]);

  return NextResponse.json({
    ...balance,
    ledger,
    ...(await pack()),
  });
}

/**
 * The top-up pack, per environment.
 *
 * Its own link and its own numbers, never the video pack's: that one credits
 * genai_credits, so borrowing it would charge for Heclus Credits and grant video
 * clips instead. Migration 130.
 *
 * Both the link and the size have to be set for the button to work, so a
 * half-configured pack reports as none rather than sending a customer to a
 * checkout that grants nothing.
 */
async function pack(): Promise<{
  pack: { credits: number; priceUsd: number } | null;
  checkoutUrl: string | null;
}> {
  const none = { pack: null, checkoutUrl: null };
  try {
    const { data, error } = await supabase
      .from("product_config")
      .select("heclus_pack_checkout_url_test, heclus_pack_checkout_url_production, heclus_pack_credits, heclus_pack_price_usd")
      .eq("service", "_global")
      .maybeSingle();
    // Migrations here are applied by hand, so the columns may not exist yet.
    // That reads as "no pack", which is the correct answer either way.
    if (error || !data) return none;

    const row = data as Record<string, unknown>;
    const url = isProductionEnv()
      ? row.heclus_pack_checkout_url_production
      : row.heclus_pack_checkout_url_test;
    const credits = Number(row.heclus_pack_credits ?? 0);
    const priceUsd = Number(row.heclus_pack_price_usd ?? 0);
    const link = typeof url === "string" && url.trim() ? url.trim() : null;

    if (!link || !(credits > 0) || !(priceUsd > 0)) return none;
    return { pack: { credits, priceUsd }, checkoutUrl: link };
  } catch {
    return none;
  }
}
