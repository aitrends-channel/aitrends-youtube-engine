import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { getHeclusBalance, listHeclusLedger } from "@/lib/heclus-credits";
import { supabase } from "@/lib/supabase/client";
import { isProductionEnv } from "@/lib/env";
import { isAdminUser } from "@/lib/admin";

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

  const [balance, ledger, lifetime, packInfo] = await Promise.all([
    getHeclusBalance(user),
    listHeclusLedger(user.id, 25),
    lifetimeTotals(user.id),
    pack(),
  ]);

  // The disabled button reads "no pack is configured yet" either way, which is
  // the right thing to tell a customer and useless to whoever has to fix it:
  // an unset link and an unapplied migration 130 look identical from there.
  // Admins get the difference, and only admins.
  const setupHint = packInfo.checkoutUrl || !isAdminUser(user)
    ? null
    : packInfo.reason === "no-columns"
      ? "Migration 130 has not run on this database, so there are no pack columns to configure. Apply supabase/migrations/130_heclus_pack.sql, then set the link in Admin, Payment, Dodo Variables."
      : "No top-up link set. Add the Heclus Credits Package Link in Admin, Payment, Dodo Variables.";

  return NextResponse.json({
    ...balance,
    ...lifetime,
    ledger,
    pack: packInfo.pack,
    checkoutUrl: packInfo.checkoutUrl,
    setupHint,
  });
}

/**
 * Bought and spent over the life of the account, for the usage bar.
 *
 * Summed here rather than from the 25 rows the panel displays: a bar drawn from
 * a page of history would shrink as the account got busier, which is worse than
 * no bar.
 *
 * Capped, and the cap is reported. A wallet with more movements than this is not
 * a case that exists yet, and if it ever does, `partial` is what stops the bar
 * quietly lying about it.
 */
const LIFETIME_ROW_CAP = 5000;

async function lifetimeTotals(userId: string): Promise<{
  purchased: number;
  spent: number;
  partial: boolean;
}> {
  const none = { purchased: 0, spent: 0, partial: false };
  try {
    const { data, error } = await supabase
      // credit_ledger, not heclus_credit_ledger: migration 129 gave the general
      // wallet the plain names and renamed the free-video one to genai_credits.
      .from("credit_ledger")
      .select("credits")
      .eq("user_id", userId)
      .limit(LIFETIME_ROW_CAP);
    if (error || !data) return none;

    let purchased = 0;
    let spent = 0;
    for (const row of data as { credits: number | string }[]) {
      const n = Number(row.credits);
      if (n > 0) purchased += n;
      else spent += -n;
    }
    return { purchased, spent, partial: data.length === LIFETIME_ROW_CAP };
  } catch {
    return none;
  }
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
  /** Why there is no pack, for the admin-only hint. */
  reason: "ok" | "no-columns" | "unset";
}> {
  const none = { pack: null, checkoutUrl: null, reason: "unset" as const };
  try {
    const { data, error } = await supabase
      .from("product_config")
      .select("heclus_pack_checkout_url_test, heclus_pack_checkout_url_production, heclus_pack_credits, heclus_pack_price_usd")
      .eq("service", "_global")
      .maybeSingle();
    // Migrations here are applied by hand, so the columns may not exist yet.
    // That reads as "no pack" to a customer, which is the correct answer either
    // way, but an unapplied migration and an unset link need different fixes,
    // so the two are told apart for the admin hint.
    if (error)
      return { ...none, reason: /column .* does not exist/i.test(error.message) ? "no-columns" : "unset" };
    if (!data) return none;

    const row = data as Record<string, unknown>;
    const url = isProductionEnv()
      ? row.heclus_pack_checkout_url_production
      : row.heclus_pack_checkout_url_test;
    const credits = Number(row.heclus_pack_credits ?? 0);
    const priceUsd = Number(row.heclus_pack_price_usd ?? 0);
    const link = typeof url === "string" && url.trim() ? url.trim() : null;

    // The link alone opens the button. Credits and price are optional and only
    // sharpen what it says: requiring them meant a configured checkout still
    // showed a dead button, which is the opposite of useful.
    if (!link) return none;
    return {
      pack: credits > 0 && priceUsd > 0 ? { credits, priceUsd } : null,
      checkoutUrl: link,
      reason: "ok",
    };
  } catch {
    return none;
  }
}
