export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { getCreditBalance, listLedger, CREDIT_PACK } from "@/lib/credits";
import { getPaymentSettings } from "@/lib/plans";
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
  // Chosen by the active payment mode, so a staging checkout never points at
  // the live product. Admin-editable on the Payment tab; the env vars are a
  // bootstrap fallback for a deployment with no config row yet.
  const settings = await getPaymentSettings();
  const column = settings.mode === "production"
    ? "credit_pack_checkout_url_production"
    : "credit_pack_checkout_url_test";

  const { data, error } = await supabase
    .from("product_config")
    .select(column)
    .eq("service", "_global")
    .maybeSingle();
  if (error) {
    // An unapplied migration 126 must not break the wallet: no link simply
    // means no top-up button.
    console.warn("[credits] checkout url read failed:", error.message);
  }
  const fromDb = (data as Record<string, string | null> | null)?.[column];
  const fromEnv = settings.mode === "production"
    ? process.env.NEXT_PUBLIC_DODO_CREDIT_PACK_LINK_PRODUCTION
    : process.env.NEXT_PUBLIC_DODO_CREDIT_PACK_LINK_TEST;
  return (fromDb?.trim() || fromEnv?.trim() || process.env.NEXT_PUBLIC_DODO_CREDIT_PACK_LINK?.trim()) ?? null;
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const [balance, ledger, checkoutUrl] = await Promise.all([
    getCreditBalance(user),
    listLedger(user.id, 25),
    creditPackCheckoutUrl(),
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
    setupHint,
    eligible: balance.monthlyGrant > 0 || balance.paid > 0,
    pack: CREDIT_PACK,
    checkoutUrl,
    ledger,
  });
}
