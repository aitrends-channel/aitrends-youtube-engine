import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import {
  getFundingMode, invalidateFundingCache, WALLET_FUNDING_ADMIN_ONLY, type FundingMode,
} from "@/lib/funding";
import { isAdminUser } from "@/lib/admin";
import { billingPlanOf, planSlugOf } from "@/lib/plans-gating";
import { heclusPlanFor, isHeclusCreditsPlan } from "@/lib/plan-tier";
import { logSystemEvent } from "@/lib/system-logger";

// Who pays for this account's generations, and letting the customer choose.
//
// Two arrangements, and the choice is theirs rather than an admin's:
//
//   byo    – their own KIE key, their own balance. Locked to KIE, because PoYo
//            runs on Heclus's key only and there is no per-client path to it.
//   wallet – Heclus's keys, metered against Heclus Credits. Every model, and
//            nothing to connect.
//
// Reversible on purpose. Nothing about the switch is destructive: keys are left
// in place when moving to wallet, and credits are left in place when moving
// back, so a customer who changes their mind loses nothing either way.
//
// This route deliberately does not touch the subscription. Moving a customer to
// the Heclus Credits price is a separate, irreversible billing action that
// happens at their renewal, and conflating the two would mean an accidental
// click reprices them.

export const dynamic = "force-dynamic";

export interface FundingStatus {
  mode: FundingMode;
  /** What they are billed on today, verbatim. */
  billingPlan: string;
  /** The entitlement tier, which does not change when the mode does. */
  tier: string;
  /** The Heclus Credits product that sells their tier, when there is one and
   *  they are not already on it. Null means the switch changes no price. */
  heclusPlan: string | null;
  /** True when they already pay on a Heclus Credits product. */
  onHeclusPlan: boolean;
  /** Whether each option can be selected right now, and why not. */
  canUseWallet: boolean;
  canUseByo: boolean;
  walletBlockedReason: string | null;
  byoBlockedReason: string | null;
  /** A KIE key on file. Without one, byo cannot generate anything. */
  kieKeySet: boolean;
}

async function statusFor(user: User): Promise<FundingStatus> {
  const { data } = await supabase
    .from("account_settings")
    .select("kie_api_key")
    .eq("user_id", user.id)
    .maybeSingle();
  const kieKeySet = !!(data as { kie_api_key?: string | null } | null)?.kie_api_key?.trim();

  const mode = await getFundingMode(user);
  const billingPlan = billingPlanOf(user);

  // The rollout gate, stated as a reason rather than a missing option. While it
  // is on, a customer choosing wallet would be told it worked and then resolve
  // to byo on the next call, which is worse than being told it is unavailable.
  const walletGated = WALLET_FUNDING_ADMIN_ONLY && !isAdminUser(user);

  return {
    mode,
    billingPlan,
    tier: planSlugOf(user),
    heclusPlan: heclusPlanFor(billingPlan),
    onHeclusPlan: isHeclusCreditsPlan(billingPlan),
    canUseWallet: !walletGated,
    canUseByo: kieKeySet,
    walletBlockedReason: walletGated ? "Heclus Credits is not open to all accounts yet." : null,
    byoBlockedReason: kieKeySet
      ? null
      : "Add your own KIE key first, or your own account has nothing to generate with.",
    kieKeySet,
  };
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  return NextResponse.json(await statusFor(user));
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  let body: { mode?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const mode = String(body.mode ?? "").trim().toLowerCase();
  if (mode !== "byo" && mode !== "wallet") {
    return NextResponse.json({ error: "mode must be byo or wallet" }, { status: 400 });
  }

  const before = await statusFor(user);
  if (before.mode === mode) return NextResponse.json({ ok: true, ...before });

  // Refused rather than stored. Writing a mode the read path will override is
  // how a customer ends up believing they switched when they did not.
  if (mode === "wallet" && !before.canUseWallet) {
    return NextResponse.json({ error: before.walletBlockedReason }, { status: 409 });
  }
  if (mode === "byo" && !before.canUseByo) {
    return NextResponse.json({ error: before.byoBlockedReason }, { status: 409 });
  }

  // Upsert, because an account that has never saved a setting has no row and
  // the default for a new row is wallet. Naming user_id as the conflict target
  // keeps this from creating a second row for the same account.
  const { error } = await supabase
    .from("account_settings")
    .upsert({ user_id: user.id, funding_mode: mode }, { onConflict: "user_id" });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // The mode is cached for a minute at every choke point that spends money, so
  // a stale entry would keep charging the wrong account.
  invalidateFundingCache(user.id);

  // Recorded because this decides whose money is spent, and "when did this
  // account move" is the first question anyone asks about an unexpected charge.
  await logSystemEvent({
    source: "funding",
    level: "info",
    message: `funding mode ${before.mode} to ${mode}`,
    userId: user.id,
    metadata: { from: before.mode, to: mode, billingPlan: before.billingPlan },
  }).catch(() => undefined);

  return NextResponse.json({ ok: true, ...(await statusFor(user)) });
}
