import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import {
  getFundingMode, invalidateFundingCache, type FundingMode,
} from "@/lib/funding";
import { isAdminUser } from "@/lib/admin";
import { billingPlanOf, planSlugOf } from "@/lib/plans-gating";
import { getPlanBySlug, getAllPlans } from "@/lib/plans";
import { heclusPlanFor, isHeclusCreditsPlan } from "@/lib/plan-tier";
import { hasPaidAccess } from "@/lib/subscription";
import { scheduleHeclusPlanChange, cancelScheduledPlanChange, pendingPlanOf } from "@/lib/dodo/plan-change";
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
// Choosing wallet also books the repricing, because the two were never really
// separate: the card has always promised that the subscription moves to Heclus
// Credits pricing at the next renewal, and until this it promised it of nothing.
// It is scheduled, not applied. The customer keeps their plan and their price
// to the end of the period they have paid for, Dodo bills nothing today, and
// choosing byo again before renewal cancels the schedule. So an accidental
// click still cannot reprice anyone: it books something they can undo.

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
  /** The plan this subscription is already booked to renew as, if a switch has
   *  been made and not undone. */
  pendingPlan: string | null;
  pendingPlanEffectiveAt: string | null;
  /** That plan as the customer should read it, e.g. "Pro $49.99/mo". */
  pendingPlanLabel: string | null;
  /** The same label for the plan they would move to, before they commit, so the
   *  confirm names the price. */
  heclusPlanLabel: string | null;
  /** When the current period ends, for the same reason. */
  renewsOn: string | null;
  /** Every plan the switch may land on, so the customer picks rather than being
   *  told. Empty when they are already on one. */
  switchOptions: SwitchOption[];
}

export interface SwitchOption {
  slug: string;
  name: string;
  priceDisplay: string;
  periodDisplay: string;
  limitDisplay: string;
  features: string[];
  /** The one that matches what they pay for today, preselected. */
  isCurrentTier: boolean;
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
  const pending = pendingPlanOf(user);
  // Resolved to a label here rather than in the card, so the price the customer
  // is told they will pay comes from the same row that will charge it.
  const target = heclusPlanFor(billingPlan);

  // Every Heclus Credits plan, not only the one matching their tier: a Starter
  // moving across may want Pro, and making them switch and then upgrade is two
  // billing events for one decision.
  //
  // `disabled` is not filtered here. It greys a card in the public upgrade
  // modal, which is a statement about new purchases; a reprice target is a
  // different question and is gated by whether the plan has a checkout link at
  // all, which productIdForPlan enforces at the point of use.
  const switchOptions: SwitchOption[] = target
    ? (await getAllPlans())
        .filter((p) => isHeclusCreditsPlan(p.slug) && !p.legacy)
        .map((p) => ({
          slug: p.slug,
          name: p.name,
          priceDisplay: p.priceDisplay,
          periodDisplay: p.periodDisplay,
          limitDisplay: p.limitDisplay,
          features: p.features,
          isCurrentTier: p.slug === target,
        }))
    : [];
  const [pendingRow, targetRow] = await Promise.all([
    pending ? getPlanBySlug(pending.slug) : null,
    target ? getPlanBySlug(target) : null,
  ]);
  const label = (r: Awaited<ReturnType<typeof getPlanBySlug>>) =>
    r ? `${r.name} ${r.priceDisplay}${r.periodDisplay}` : null;
  const dodo = ((user.app_metadata ?? {}) as { dodo?: Record<string, unknown> }).dodo ?? {};

  // Who may choose the wallet.
  //
  // It used to be "already on a credits plan", which made the switch
  // unreachable for exactly the people it is for: a paying customer on the old
  // products was told to move plan, by a card whose whole purpose is to move
  // them. The POST path has always known how to do it, by booking the matching
  // credits plan for their next renewal, and nothing could reach that branch.
  //
  // Now: an existing customer with a plan to move to may choose it. A free
  // signup still cannot, because there is no subscription to reprice.
  const canReprice = hasPaidAccess(user) && !!target;
  const walletGated = !isAdminUser(user) && !isHeclusCreditsPlan(billingPlan) && !canReprice;

  return {
    mode,
    billingPlan,
    tier: planSlugOf(user),
    heclusPlan: target,
    onHeclusPlan: isHeclusCreditsPlan(billingPlan),
    canUseWallet: !walletGated,
    canUseByo: kieKeySet,
    walletBlockedReason: walletGated
      ? "Heclus Credits comes with the Starter, Pro and Max plans. Subscribe to one of those to spend credits instead of your own keys."
      : null,
    byoBlockedReason: kieKeySet
      ? null
      : "Add your own KIE key first, or your own account has nothing to generate with.",
    kieKeySet,
    pendingPlan: pending?.slug ?? null,
    pendingPlanEffectiveAt: pending?.effectiveAt ?? null,
    pendingPlanLabel: label(pendingRow) ?? pending?.slug ?? null,
    heclusPlanLabel: label(targetRow),
    renewsOn:
      (dodo.current_period_end as string | undefined) ??
      ((user.app_metadata ?? {}) as { plan_expires_at?: string }).plan_expires_at ??
      null,
    switchOptions,
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

  let body: { mode?: unknown; targetPlan?: unknown };
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

  // Booked before the mode is written, so a Dodo failure leaves the account
  // exactly as it was. The other order gives the customer wallet funding and
  // the old price, which is the combination Heclus pays for.
  if (mode === "wallet" && before.heclusPlan) {
    // Validated against the offered set rather than trusted: this string decides
    // what the customer is billed, and an arbitrary slug would move them onto
    // any plan in the table.
    const requested = typeof body.targetPlan === "string" ? body.targetPlan.trim().toLowerCase() : "";
    const target = requested
      ? before.switchOptions.find((o) => o.slug === requested)?.slug
      : before.heclusPlan;
    if (!target) {
      return NextResponse.json({ error: "That plan is not one you can switch to." }, { status: 400 });
    }
    const scheduled = await scheduleHeclusPlanChange(user, target);
    if (!scheduled.ok) return NextResponse.json({ error: scheduled.error }, { status: 502 });
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

  // Undone after the mode is written: leaving a schedule booked for someone who
  // is back on their own key would reprice them for a service they left. A
  // failure here is reported rather than swallowed, because the customer is
  // already on byo and the date they were told still stands.
  let scheduleWarning: string | null = null;
  if (mode === "byo") {
    const cancelled = await cancelScheduledPlanChange(user);
    if (!cancelled.ok) scheduleWarning = cancelled.error;
  }

  // Recorded because this decides whose money is spent, and "when did this
  // account move" is the first question anyone asks about an unexpected charge.
  await logSystemEvent({
    source: "funding",
    level: "info",
    message: `funding mode ${before.mode} to ${mode}`,
    userId: user.id,
    metadata: { from: before.mode, to: mode, billingPlan: before.billingPlan },
  }).catch(() => undefined);

  // Re-read rather than reusing `user`: the schedule was stamped into
  // app_metadata through the admin API, so the object this request was
  // authenticated with predates it and would report no pending change on the
  // very response that booked one.
  const { data: refreshed } = await supabase.auth.admin.getUserById(user.id);
  const status = await statusFor(refreshed?.user ?? user);
  return NextResponse.json({ ok: true, ...status, ...(scheduleWarning ? { warning: scheduleWarning } : {}) });
}
