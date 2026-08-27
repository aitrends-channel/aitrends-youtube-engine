import { NextResponse } from "next/server";
import { hasPaidAccess } from "@/lib/subscription";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { getHeclusBalance, listHeclusLedger } from "@/lib/heclus-credits";
import { supabase } from "@/lib/supabase/client";
import { isAdminUser } from "@/lib/admin";
import { getHeclusPack } from "@/lib/heclus-pack";
import { getFundingMode } from "@/lib/funding";

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

  const [balance, ledger, lifetime, packInfo, fundingMode] = await Promise.all([
    getHeclusBalance(user),
    listHeclusLedger(user.id, 25),
    lifetimeTotals(user.id),
    getHeclusPack(),
    getFundingMode(user),
  ]);

  // The disabled button reads "no pack is configured yet" either way, which is
  // the right thing to tell a customer and useless to whoever has to fix it:
  // an unset link and an unapplied migration 130 look identical from there.
  // Admins get the difference, and only admins.
  const setupHint = packInfo.checkoutUrl || !isAdminUser(user)
    ? null
    : packInfo.reason === "no-columns"
      ? "Migration 130 has not run on this database, so there are no pack columns to configure. Apply supabase/migrations/130_heclus_pack.sql, then set the link in Admin, Payment, Dodo Variables."
      : packInfo.reason === "no-credits"
        ? "The link is set but the pack size is not, so a purchase could not be credited. Set the credits per pack in Admin, Payment, Dodo Variables."
        : "No top-up link set. Add the Heclus Credits Package Link in Admin, Payment, Dodo Variables.";

  return NextResponse.json({
    ...balance,
    ...lifetime,
    ledger,
    pack: packInfo.credits !== null && packInfo.priceUsd !== null
      ? { credits: packInfo.credits, priceUsd: packInfo.priceUsd }
      : null,
    checkoutUrl: hasPaidAccess(user) ? packInfo.checkoutUrl : null,
    setupHint,
    // Nothing draws on this wallet while the account is on its own key, so the
    // panel has to know the mode to keep the button from selling credits that
    // would sit unspent.
    fundingMode,
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

