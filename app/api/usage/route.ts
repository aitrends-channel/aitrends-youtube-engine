export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { isAdminUser, isProductionTestUser } from "@/lib/admin";
import { getPlanBySlug } from "@/lib/plans";
import { subscriptionExpired } from "@/lib/subscription";
import type { User } from "@supabase/supabase-js";

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  // isAdminUser covers both the legacy hardcoded founder and any
  // user promoted via the dashboard. Without this, promoted admins
  // would still be subject to their original plan's niche cap.
  const isAdmin = isAdminUser(user);
  const isProductionTest = isProductionTestUser(user);
  const plan = (user.app_metadata?.plan as string) ?? "demo";
  const isPaid = user.app_metadata?.paid === true;
  // Resolved against the plans table. Paid users with an unrecognised
  // plan name (the Dodo webhook writes paid:true but not plan; the
  // verify callback that sets plan may not have fired) get the Starter
  // cap as the safest fallback. Unpaid users with no plan get the demo
  // cap of 1. getPlanBySlug returns null for unknown plans, distinct
  // from a known plan with nichesPerMonth=null (Pro → unlimited).
  let planLimit: number | null;
  if (isAdmin) {
    planLimit = null;
  } else {
    const resolved = await getPlanBySlug(plan);
    if (resolved) planLimit = resolved.nichesPerMonth;
    else if (isPaid) planLimit = (await getPlanBySlug("starter"))?.nichesPerMonth ?? null;
    else planLimit = 1;
  }

  const { data: settings } = await supabase
    .from("account_settings")
    .select("niches_used, niche_limit_override")
    .eq("user_id", user.id)
    .maybeSingle();

  // Admin-set per-user override takes precedence over the plan default.
  // NULL override means "no override, use the plan limit". Admins are
  // an exception — they always read as unlimited regardless of any
  // lingering override (e.g. a founder-tier grant from before the
  // admin promotion). Letting the override leak through to an admin
  // would make the dashboard show "13/20" instead of unlimited and
  // could falsely trip at_limit gating mid-flow.
  const override = settings?.niche_limit_override ?? null;
  const niche_limit: number | null = isAdmin
    ? null
    : (override !== null ? override : planLimit);
  const niches_used = settings?.niches_used ?? 0;
  const at_limit = niche_limit !== null && niches_used >= niche_limit;

  // Effective plan for display surfaces — same idea as /api/plan.
  // Admins (legacy or promoted) read as "admin" regardless of any
  // stored plan string, so the dashboard subscription pill stays
  // honest even for users promoted before make-admin started
  // writing plan="admin" into app_metadata.
  const effectivePlan = isAdmin ? "admin" : plan;

  // Active subscription = paid AND the user hasn't cancelled AND their
  // paid-through period hasn't ended. Mirrors the /api/plan cancelled
  // check so the SubscriptionModal can hide the production-test card
  // whenever it also wouldn't render the Renew/Change plan flow as
  // an initial purchase.
  const dodo = (user.app_metadata?.dodo ?? {}) as Record<string, unknown>;
  const dodoStatus = (dodo.status as string | undefined) ?? null;
  const dodoEvent = (dodo.event as string | undefined) ?? null;
  const cancelledOrExpired =
    dodoStatus === "cancelled" || dodoStatus === "expired" || dodoStatus === "failed" ||
    dodoEvent === "subscription.cancelled" || dodoEvent === "subscription.expired" || dodoEvent === "subscription.failed";
  const planExpiresAt = user.app_metadata?.plan_expires_at as string | undefined;
  const periodEnded = planExpiresAt ? new Date(planExpiresAt).getTime() <= Date.now() : false;
  const hasActiveSubscription = isPaid && !cancelledOrExpired && !periodEnded;
  // Broader flag for surfaces (like the "Try end-to-end" card) that
  // should stay hidden as long as the user still has access, whether
  // that access is active OR cancelled-but-in-grace-period. Falls back
  // to false the moment the paid period has actually ended.
  const hasCurrentAccess = isPaid && !periodEnded;

  return NextResponse.json({
    niches_used,
    niche_limit,
    plan_default_limit: planLimit,
    niche_limit_override: override,
    at_limit,
    plan: effectivePlan,
    is_admin: isAdmin,
    is_production_test: isProductionTest,
    has_active_subscription: hasActiveSubscription,
    has_current_access: hasCurrentAccess,
    // Ex-subscriber whose paid period has lapsed (same predicate the
    // spend-gated routes use for their 403). Lets SubscriptionModal
    // render renew/upgrade framing instead of a first-purchase pitch.
    subscription_expired: subscriptionExpired(user),
    email: user.email ?? null,
  });
}
