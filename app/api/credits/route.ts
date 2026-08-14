export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { getCreditBalance, listLedger, getCreditsUsed, CREDIT_PACK } from "@/lib/credits";
import { getPaymentSettings } from "@/lib/plans";
import { pickPackLink } from "@/lib/credits-checkout";
import { isAdminUser } from "@/lib/admin";
import type { User } from "@supabase/supabase-js";

// What the video-credits panel reads.
//
// `eligible` is the founder gate in one boolean: a plan with no allowance and
// no credit it has ever bought has nothing to show, so the panel renders
// nothing at all rather than an empty balance the plan cannot use.
//
// A user who once had an allowance and still holds bought credit stays
// eligible, because that credit is theirs and must remain spendable and
// visible even after a downgrade.

/** Where "Top up" sends the customer. Admin-editable in product_config so a
 *  product can be swapped without a redeploy, with an env fallback. */
async function creditPackCheckoutUrl(): Promise<string | null> {
  // Chosen by the active payment mode so a staging checkout never points at the
  // live product, and read from product_config first so whatever an admin saves
  // on the Payment tab is what customers get.
  const settings = await getPaymentSettings();

  const { data, error } = await supabase
    .from("product_config")
    .select("credit_pack_checkout_url_test, credit_pack_checkout_url_production")
    .eq("service", "_global")
    .maybeSingle();
  if (error) {
    // An unapplied migration 126 must not break the wallet: no link simply means
    // no top-up button.
    console.warn("[credits] checkout url read failed:", error.message);
  }
  const row = data as {
    credit_pack_checkout_url_test: string | null;
    credit_pack_checkout_url_production: string | null;
  } | null;

  return pickPackLink(
    settings.mode,
    { test: row?.credit_pack_checkout_url_test, production: row?.credit_pack_checkout_url_production },
    {
      test: process.env.NEXT_PUBLIC_DODO_CREDIT_PACK_LINK_TEST,
      production: process.env.NEXT_PUBLIC_DODO_CREDIT_PACK_LINK_PRODUCTION,
      legacy: process.env.NEXT_PUBLIC_DODO_CREDIT_PACK_LINK,
    },
  );
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const [balance, ledger, checkoutUrl, used] = await Promise.all([
    getCreditBalance(user),
    listLedger(user.id, 25),
    creditPackCheckoutUrl(),
    getCreditsUsed(user.id),
  ]);

  // A missing checkout link is a configuration gap, not a customer-facing
  // state: they get no button, which is correct, but an admin looking at the
  // same screen has no way to tell whether it is broken or unconfigured. Say so,
  // to admins only.
  const setupHint = !checkoutUrl && isAdminUser(user)
    ? "No top-up link configured. Add the credit-pack checkout link in Admin → Payment → Dodo Variables."
    : null;

  return NextResponse.json({
    ...balance,
    used,
    setupHint,
    eligible: balance.monthlyGrant > 0 || balance.paid > 0,
    pack: CREDIT_PACK,
    checkoutUrl,
    ledger,
  });
}
