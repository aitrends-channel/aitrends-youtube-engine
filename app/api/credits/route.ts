export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { getCreditBalance, listLedger, CREDIT_PACK } from "@/lib/credits";
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
  const { data } = await supabase
    .from("product_config")
    .select("credit_pack_checkout_url")
    .eq("service", "_global")
    .maybeSingle();
  const fromDb = (data as { credit_pack_checkout_url?: string | null } | null)?.credit_pack_checkout_url;
  return (fromDb?.trim() || process.env.NEXT_PUBLIC_DODO_CREDIT_PACK_LINK?.trim()) ?? null;
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const [balance, ledger, checkoutUrl] = await Promise.all([
    getCreditBalance(user),
    listLedger(user.id, 25),
    creditPackCheckoutUrl(),
  ]);

  return NextResponse.json({
    ...balance,
    eligible: balance.monthlyGrant > 0 || balance.paid > 0,
    pack: CREDIT_PACK,
    checkoutUrl,
    ledger,
  });
}
