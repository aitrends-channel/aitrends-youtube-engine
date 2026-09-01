export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { billingPlanOf, tierForPlan } from "@/lib/plans-gating";
import { tierRank } from "@/lib/plan-tier";
import { getPlanBySlug } from "@/lib/plans";
import { upgradeHeclusPlanNow, scheduleHeclusPlanChange, dodoSubscriptionId } from "@/lib/dodo/plan-change";
import { getFundingMode } from "@/lib/funding";
import { addHeclusCredits, packCreditsForTier } from "@/lib/heclus-credits";
import { logSystemEvent } from "@/lib/system-logger";
import { canSeeNewPlans, isGatedPlan } from "@/lib/rollout";

// Moving up a tier, in place, on the subscription the customer already has.
//
// An upgrade used to be a fresh checkout: a second subscription at the new
// plan's full price, with the first one soft-cancelled afterwards by
// /api/dodo/verify. That works, but it charges a whole period again days into
// one they have already paid for, and it depends on a repair step running to
// avoid billing them twice.
//
// This adjusts the existing subscription instead. Dodo prorates the difference,
// the billing anniversary does not move, and no second subscription is ever
// created, so the double-billing case cannot arise rather than being cleaned up
// after.
//
//   POST { plan: "heclus_max" }
//
// Answers { adjusted: false, reason } rather than an error when there is no
// subscription to adjust or the target is not above the current tier. Those are
// both "use the checkout link", which is the caller's fallback, not a failure.

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  let body: { plan?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const target = typeof body.plan === "string" ? body.plan.trim().toLowerCase() : "";
  if (!target) return NextResponse.json({ error: "plan is required" }, { status: 400 });

  const plan = await getPlanBySlug(target);
  if (!plan) return NextResponse.json({ error: `Unknown plan ${target}` }, { status: 400 });
  if (plan.disabled) return NextResponse.json({ error: `${plan.name} is not on sale` }, { status: 400 });

  // The in-place upgrade path is a purchase too: it moves a live subscription
  // onto a new product and bills the difference. Gated for the same reason the
  // checkout is.
  if (isGatedPlan(target) && !canSeeNewPlans(user)) {
    return NextResponse.json({ error: "That plan is not available yet." }, { status: 403 });
  }

  const billing = billingPlanOf(user);
  const fromTier = tierForPlan(billing);
  const toTier = tierForPlan(target);

  // Already on it. Nothing to change, and a checkout would sell them a second
  // subscription to the plan they are on.
  if (billing === target) {
    return NextResponse.json({ adjusted: false, reason: "already-on-plan" });
  }

  // Same tier, different product: a repricing, not an upgrade.
  //
  // This is a legacy Starter or Pro moving onto the Heclus product that
  // replaced it. Answering "not-an-upgrade" sent them to a fresh checkout,
  // which charges a full period for a plan they are already paying for and
  // starts a second subscription; /api/dodo/verify cancels the old one at its
  // period end, so they end up having paid twice for the overlap. Forty live
  // subscriptions sit on the legacy products (24 Pro, 16 Starter, Sept 2026).
  //
  // A downgrade takes the same path. Charging today for less service starting
  // at renewal is the wrong way round.
  if (tierRank(toTier) <= tierRank(fromTier)) {
    // Checked here rather than read off the schedule call, which treats a
    // missing subscription as a no-op and would have us report a change that
    // was never made. Somebody with no subscription belongs in a checkout.
    if (!dodoSubscriptionId(user)) {
      return NextResponse.json({ adjusted: false, reason: "no-subscription" });
    }
    const scheduled = await scheduleHeclusPlanChange(user, target);
    if (!scheduled.ok) {
      return NextResponse.json({ error: scheduled.error }, { status: 502 });
    }
    await logSystemEvent({
      level: "info",
      source: "plan-upgrade",
      message: `${user.email ?? user.id} scheduled ${billing} to ${target} at renewal`,
      userId: user.id,
      metadata: { from: billing, to: target, effectiveAt: scheduled.effectiveAt },
    }).catch(() => { /* logging must not fail the change */ });
    return NextResponse.json({
      adjusted: true,
      scheduled: true,
      plan: target,
      name: plan.name,
      effectiveAt: scheduled.effectiveAt,
      credits: 0,
    });
  }

  const result = await upgradeHeclusPlanNow(user, target);
  if (!result.ok) {
    if (result.error === "no-subscription") {
      return NextResponse.json({ adjusted: false, reason: "no-subscription" });
    }
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  // Stamp the new plan and open a new grant period. paid_at is what the wallet
  // reads to decide a period has been paid for, and the customer has just paid
  // for this one at the new rate.
  const paidAt = new Date().toISOString();
  try {
    await supabase.auth.admin.updateUserById(user.id, {
      app_metadata: { ...user.app_metadata, paid: true, paid_at: paidAt, plan: target },
    });
  } catch (e) {
    // The charge went through at Dodo. Failing the request here would tell the
    // customer the upgrade did not happen while their card says otherwise, so
    // it is logged loudly and reported as done.
    console.error(`[plan-upgrade] METADATA WRITE FAILED after a successful Dodo upgrade user=${user.id} target=${target}:`, e instanceof Error ? e.message : e);
  }

  // The credit difference, not a second full pack. They paid the difference in
  // money, so they get the difference in credits: the pack they already drew
  // this period stays drawn.
  let credits = 0;
  try {
    if (await getFundingMode(user) === "wallet") {
      const delta = (await packCreditsForTier(toTier)) - (await packCreditsForTier(fromTier));
      if (delta > 0) {
        // The period key, so the lazy grant in getHeclusBalance reads this
        // period as already paid out and does not add a full pack on top.
        const granted = await addHeclusCredits({
          userId: user.id,
          credits: delta,
          kind: "adjustment",
          note: `${delta} upgrade credits (${fromTier} to ${toTier})`,
          dodoPaymentId: `grant:${user.id}:${paidAt}`,
        });
        if (granted) credits = delta;
      }
    }
  } catch (e) {
    // Same reasoning as above: the plan change is done and paid for. A grant
    // that failed is recoverable by hand; refusing the upgrade is not.
    console.error(`[plan-upgrade] grant failed after upgrade user=${user.id}:`, e instanceof Error ? e.message : e);
  }

  await logSystemEvent({
    level: "info",
    source: "plan-upgrade",
    message: `${user.email ?? user.id} upgraded ${fromTier} to ${toTier}`,
    userId: user.id,
    metadata: { from: fromTier, to: toTier, plan: target, credits },
  }).catch(() => { /* logging must not fail the upgrade */ });

  return NextResponse.json({ adjusted: true, plan: target, name: plan.name, credits });
}
