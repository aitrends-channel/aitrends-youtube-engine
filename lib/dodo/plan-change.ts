import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { resolveDodoCredentials } from "@/lib/dodo/credentials";
import { productIdForPlan } from "@/lib/dodo/plan-products";

// Moving a customer onto the Heclus Credits product without charging them today.
//
// The rule the customer is shown, and the one this implements: they keep the
// plan and the price they are on until the current period ends, and the renewal
// after that bills the new product. Dodo does this in one call, so there is no
// window where they are cancelled but not yet resubscribed, and no proration to
// argue about.
//
// do_not_bill, not prorated_immediately: the switch is a repricing that starts
// next period, so nothing is owed and nothing is credited now. Any other mode
// would charge or credit on the day they click, which is the one thing the
// confirm dialog promises will not happen.

export type PlanChangeResult =
  | { ok: true; effectiveAt: string | null }
  | { ok: false; error: string };

interface DodoMeta {
  subscription_id?: unknown;
  current_period_end?: unknown;
  pending_plan?: unknown;
  pending_plan_effective_at?: unknown;
}

function dodoMetaOf(user: User): DodoMeta {
  return ((user.app_metadata ?? {}) as { dodo?: DodoMeta }).dodo ?? {};
}

/** The plan change already scheduled for this account, if any. */
export function pendingPlanOf(user: User): { slug: string; effectiveAt: string | null } | null {
  const meta = dodoMetaOf(user);
  const slug = typeof meta.pending_plan === "string" ? meta.pending_plan : null;
  if (!slug) return null;
  return {
    slug,
    effectiveAt: typeof meta.pending_plan_effective_at === "string" ? meta.pending_plan_effective_at : null,
  };
}

async function stampPending(user: User, value: { slug: string; effectiveAt: string | null } | null) {
  const meta = (user.app_metadata ?? {}) as Record<string, unknown>;
  const dodo = { ...dodoMetaOf(user) } as Record<string, unknown>;
  if (value) {
    dodo.pending_plan = value.slug;
    dodo.pending_plan_effective_at = value.effectiveAt;
  } else {
    delete dodo.pending_plan;
    delete dodo.pending_plan_effective_at;
  }
  await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: { ...meta, dodo },
  });
}

/**
 * Schedule the move onto `targetSlug` at the customer's next billing date.
 *
 * Returns ok when there is nothing to do as well as when the change is booked:
 * an account with no subscription id is one that paid by some other route, and
 * refusing their funding switch over it would block a change that costs them
 * nothing.
 */
export async function scheduleHeclusPlanChange(user: User, targetSlug: string): Promise<PlanChangeResult> {
  const meta = dodoMetaOf(user);
  const subscriptionId = typeof meta.subscription_id === "string" ? meta.subscription_id : null;
  if (!subscriptionId) return { ok: true, effectiveAt: null };

  const resolved = await resolveDodoCredentials();
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { secretKey, baseUrl, env } = resolved.creds;

  const productId = await productIdForPlan(targetSlug, env);
  if (!productId) {
    return { ok: false, error: `No ${env} checkout link is configured for ${targetSlug}, so there is no product to move to.` };
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/subscriptions/${subscriptionId}/change-plan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        product_id: productId,
        quantity: 1,
        proration_billing_mode: "do_not_bill",
        effective_at: "next_billing_date",
      }),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach Dodo: ${(e as Error).message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[dodo-change-plan] ${res.status} sub=${subscriptionId} target=${targetSlug} body=${body.slice(0, 300)}`);
    return { ok: false, error: `Could not schedule the plan change (Dodo ${res.status}). Nothing has been charged. Try again or contact support.` };
  }

  const result = await res.json().catch(() => ({} as Record<string, unknown>));
  const effectiveAt =
    (result.next_billing_date as string | undefined) ??
    (typeof meta.current_period_end === "string" ? meta.current_period_end : null) ??
    null;

  await stampPending(user, { slug: targetSlug, effectiveAt });
  return { ok: true, effectiveAt };
}

/**
 * Move `user` onto `targetSlug` now, charging the difference.
 *
 * The upgrade counterpart to scheduleHeclusPlanChange. That one reprices at the
 * next billing date and bills nothing, which is right for a same-tier product
 * switch and wrong for an upgrade: somebody who chooses more today expects more
 * today, not at a renewal three weeks out.
 *
 * prorated_immediately, so they pay the difference between what the rest of
 * this period already cost them and what it costs on the new plan, rather than
 * a second full price on top of one they have already paid. The billing
 * anniversary does not move, so the next renewal lands where it always would
 * have, at the new plan's price.
 *
 * In place on the existing subscription rather than a fresh checkout. A new
 * checkout starts a second subscription and leaves the first one billing, which
 * is a real incident this codebase already carries the repair for in
 * /api/dodo/verify. A change-plan call cannot create that state at all.
 */
export async function upgradeHeclusPlanNow(user: User, targetSlug: string): Promise<PlanChangeResult> {
  const meta = dodoMetaOf(user);
  const subscriptionId = typeof meta.subscription_id === "string" ? meta.subscription_id : null;
  // No subscription to adjust. The caller falls back to checkout, which is the
  // right route for someone who is not subscribed yet.
  if (!subscriptionId) return { ok: false, error: "no-subscription" };

  const resolved = await resolveDodoCredentials();
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { secretKey, baseUrl, env } = resolved.creds;

  const productId = await productIdForPlan(targetSlug, env);
  if (!productId) {
    return { ok: false, error: `No ${env} checkout link is configured for ${targetSlug}, so there is no product to move to.` };
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/subscriptions/${subscriptionId}/change-plan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        product_id: productId,
        quantity: 1,
        proration_billing_mode: "prorated_immediately",
        effective_at: "immediately",
      }),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach Dodo: ${(e as Error).message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[dodo-change-plan] upgrade ${res.status} sub=${subscriptionId} target=${targetSlug} body=${body.slice(0, 300)}`);
    return { ok: false, error: `Could not apply the upgrade (Dodo ${res.status}). Nothing has been charged. Try again or contact support.` };
  }

  // An upgrade supersedes any downgrade or repricing booked for the next
  // renewal. Leaving it would quietly undo the plan they just paid to be on.
  if (pendingPlanOf(user)) await stampPending(user, null);

  return { ok: true, effectiveAt: null };
}

/**
 * Undo a scheduled change, for the customer who switches back before renewal.
 *
 * A no-op when nothing is scheduled, so the byo path can call it unconditionally.
 * The local stamp is cleared even when Dodo reports the schedule was already
 * gone, because the two disagreeing is what leaves a customer being told their
 * plan changes on a date when it will not.
 */
export async function cancelScheduledPlanChange(user: User): Promise<PlanChangeResult> {
  const pending = pendingPlanOf(user);
  if (!pending) return { ok: true, effectiveAt: null };

  const meta = dodoMetaOf(user);
  const subscriptionId = typeof meta.subscription_id === "string" ? meta.subscription_id : null;
  if (!subscriptionId) {
    await stampPending(user, null);
    return { ok: true, effectiveAt: null };
  }

  const resolved = await resolveDodoCredentials();
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { secretKey, baseUrl } = resolved.creds;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/subscriptions/${subscriptionId}/change-plan/scheduled`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${secretKey}` },
    });
  } catch (e) {
    return { ok: false, error: `Could not reach Dodo: ${(e as Error).message}` };
  }

  // 404 is "there is no schedule", which is the state being asked for.
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    console.error(`[dodo-change-plan] cancel ${res.status} sub=${subscriptionId} body=${body.slice(0, 300)}`);
    return { ok: false, error: `Could not cancel the scheduled plan change (Dodo ${res.status}). Contact support before your renewal.` };
  }

  await stampPending(user, null);
  return { ok: true, effectiveAt: null };
}
