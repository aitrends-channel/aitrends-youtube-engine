export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabase as supabaseService } from "@/lib/supabase/client";
import { isAdminUser } from "@/lib/admin";
import { getPlanBySlug, getAllPlans } from "@/lib/plans";


export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const meta = user.app_metadata ?? {};
  // Admins (legacy hardcoded OR app_metadata.is_admin) display as
  // the "admin" plan regardless of any stored plan string. This
  // covers users who were promoted before make-admin started
  // writing plan="admin" into app_metadata — their stored plan may
  // still read "starter" but the effective display reflects their
  // current role. Also makes the founder admin render as "admin"
  // without needing any backfill.
  const admin = isAdminUser(user);
  let effectivePlan = admin ? "admin" : (meta.plan ?? null);
  const effectivePaid = admin || meta.paid === true;

  // Backfill: paid via webhook but plan slug never landed (verify
  // route didn't fire). Look at the user's most recent payment amount
  // and match against known plan prices. If it resolves, persist the
  // slug into app_metadata so we don't repeat the lookup on every read.
  if (!admin && effectivePaid && !effectivePlan) {
    const { data: rev } = await supabaseService
      .from("revenue_events")
      .select("amount_cents")
      .eq("user_id", user.id)
      .eq("event_type", "payment_succeeded")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const cents = Number(rev?.amount_cents ?? 0);
    if (cents > 0) {
      // getAllPlans: every existing subscriber is on a legacy row, and getPlans
      // drops those, so matching against it would leave a $21 or $39 payment
      // resolving to nothing and the customer stuck on the Starter cap.
      const allPlans = await getAllPlans();
      const matched = allPlans.find((p) => p.priceCents === cents)?.slug ?? null;
      if (matched) {
        effectivePlan = matched;
        await supabaseService.auth.admin.updateUserById(user.id, {
          app_metadata: { ...meta, plan: matched },
        });
      }
    }
  }

  // Resolve plan details inline so the /plan page can render the
  // user's plan card without a second round-trip to /api/plans.
  // Admins get a synthetic display since "admin" isn't a DB plan.
  let planDetails: {
    slug: string;
    name: string;
    priceDisplay: string;
    periodDisplay: string;
    limitDisplay: string;
    features: string[];
  } | null = null;
  if (effectivePlan === "admin") {
    planDetails = {
      slug: "admin",
      name: "Admin",
      priceDisplay: "—",
      periodDisplay: "",
      limitDisplay: "Unlimited",
      features: ["Unlimited niches", "Full admin dashboard access", "Full AI pipeline", "All features included", "No expiry"],
    };
  } else if (effectivePlan) {
    const p = await getPlanBySlug(effectivePlan);
    if (p) {
      planDetails = {
        slug: p.slug,
        name: p.name,
        priceDisplay: p.priceDisplay,
        periodDisplay: p.periodDisplay,
        limitDisplay: p.limitDisplay,
        features: p.features,
      };
    }
  }

  // A subscription is cancellable when Dodo gave us a sub id and the
  // user hasn't already cancelled (no plan_expires_at, or it's in the
  // future and Dodo's state still says active). We surface a single
  // boolean so the UI doesn't need to know about Dodo's lifecycle.
  const dodo = (meta.dodo ?? {}) as Record<string, unknown>;
  const subscriptionId = (dodo.subscription_id as string | undefined) ?? null;
  const dodoStatus = (dodo.status as string | undefined) ?? null;
  const dodoEvent = (dodo.event as string | undefined) ?? null;
  // Cancelled state can be indicated by either status or event depending
  // on which Dodo webhook landed last — check both to survive naming
  // drift in the payload.
  const alreadyCancelled =
    dodoStatus === "cancelled" ||
    dodoStatus === "expired" ||
    dodoStatus === "failed" ||
    dodoEvent === "subscription.cancelled" ||
    dodoEvent === "subscription.expired" ||
    dodoEvent === "subscription.failed";
  const canCancelSubscription =
    !admin &&
    effectivePaid &&
    !!subscriptionId &&
    !alreadyCancelled &&
    effectivePlan !== "founder";

  // "Manage billing" button visibility: the /plan page shows a Manage
  // link that POSTs to /api/dodo/portal-session for a per-user portal
  // URL. It only works if we have a customer_id stamped on
  // app_metadata.dodo — hide the button otherwise so the user doesn't
  // get an error toast.
  const customerId = (dodo.customer_id as string | undefined) ?? null;
  const manageBillingAvailable = !admin && effectivePaid && !!customerId;

  // The repricing they booked from /balance, so the plan card states it rather
  // than letting the new price arrive unannounced on a statement.
  const pendingPlanSlug = (dodo.pending_plan as string | undefined) ?? null;
  const pendingPlanRow = pendingPlanSlug ? await getPlanBySlug(pendingPlanSlug) : null;

  return NextResponse.json({
    email: user.email,
    paid: effectivePaid,
    paid_at: meta.paid_at ?? null,
    plan: effectivePlan,
    plan_details: planDetails,
    plan_expires_at: meta.plan_expires_at ?? null,
    is_admin: admin,
    can_cancel_subscription: canCancelSubscription,
    // True while the user has cancelled but their paid-through period
    // hasn't ended yet — UI uses this to swap the primary CTA and show
    // an "Access ends on" note instead of the normal renewal messaging.
    subscription_cancelled: alreadyCancelled,
    // True when the /plan page should render the "Manage" billing
    // button (paid non-admin with a Dodo customer_id on file).
    manage_billing_available: manageBillingAvailable,
    // Set once the customer has switched to Heclus Credits and not switched
    // back. Null the rest of the time, including after the renewal that applies
    // it, which the webhook clears.
    pending_plan: pendingPlanRow
      ? {
          slug: pendingPlanRow.slug,
          name: pendingPlanRow.name,
          priceDisplay: pendingPlanRow.priceDisplay,
          periodDisplay: pendingPlanRow.periodDisplay,
          effectiveAt: (dodo.pending_plan_effective_at as string | undefined) ?? null,
        }
      : null,
  });
}
