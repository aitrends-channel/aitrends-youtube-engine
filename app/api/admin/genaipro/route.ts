export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-server";
import { supabase } from "@/lib/supabase/client";
import { getGenAIProCredits, GenAIProError } from "@/lib/genaipro/client";

// The two numbers that matter, side by side.
//
// `account` is what Heclus can actually generate upstream. `promised` is the
// sum of every credit sitting in a customer's wallet. When promised exceeds
// account, some customer is holding credit that cannot be spent, and they will
// find out by having a render fail. That is the single failure mode that would
// make this worse than letting users bring their own key, so it is the thing
// the card is built to show before it happens.
//
// Their packages are also time-boxed, so a healthy remaining figure can still
// be days from evaporating. expiresAt is surfaced for the same reason.

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const [accountResult, walletResult] = await Promise.allSettled([
    getGenAIProCredits(),
    supabase.from("credit_accounts").select("grant_credits, paid_credits, reserved_credits"),
  ]);

  const account = accountResult.status === "fulfilled" ? accountResult.value : null;
  const accountError = accountResult.status === "rejected"
    ? (accountResult.reason instanceof GenAIProError || accountResult.reason instanceof Error
        ? accountResult.reason.message
        : "Could not read the GenAIPro account")
    : null;

  let promised = 0, promisedGrant = 0, promisedPaid = 0, reserved = 0, accounts = 0;
  if (walletResult.status === "fulfilled" && !walletResult.value.error) {
    const rows = (walletResult.value.data ?? []) as
      { grant_credits: number; paid_credits: number; reserved_credits: number }[];
    accounts = rows.length;
    for (const r of rows) {
      promisedGrant += r.grant_credits ?? 0;
      promisedPaid += r.paid_credits ?? 0;
      reserved += r.reserved_credits ?? 0;
    }
    promised = promisedGrant + promisedPaid;
  }

  // Bought credit is the part Heclus is contractually on the hook for, so it is
  // called out separately: an allowance that cannot be spent is a bad month,
  // unspendable paid credit is a refund.
  const shortfall = account ? Math.max(promised - account.remaining, 0) : null;

  return NextResponse.json({
    account,
    accountError,
    wallet: { promised, promisedGrant, promisedPaid, reserved, accounts, shortfall },
  });
}
