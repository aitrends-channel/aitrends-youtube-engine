import type { User } from "@supabase/supabase-js";
import { isAdminUser } from "@/lib/admin";
import { billingPlanOf } from "@/lib/plans-gating";
import { isHeclusCreditsPlan } from "@/lib/plan-tier";
import { hasPaidAccess } from "@/lib/subscription";
import { resolveQuotaCap, FREE_IMAGE_MODEL } from "@/lib/quota-config";
import { getFreeUsageThisMonth, incrementFreeUsage } from "@/lib/freeUsage";
import { supabase } from "@/lib/supabase/client";

// The free image allowance, the same shape as the free voiceover one.
//
// A generation on FREE_IMAGE_MODEL draws on this before it draws on the wallet.
// Past the allowance the model still works: it bills like any other, because a
// perk that turns into a wall is worse than no perk. That is the one way this
// differs from free video credits, where the allowance is the only supply.
//
// Metered through the same free_usage counter ai33 uses, so there is no new
// table and the admin Free Resources tab can report it alongside voiceover.

export interface FreeImageAllowance {
  /** This plan's monthly figure, plus anything bought. 0 means the plan does
   *  not include it and nothing has been bought. */
  cap: number;
  /** The monthly half, which resets. */
  monthly: number;
  /** The bought half, which does not. */
  bonus: number;
  used: number;
  remaining: number;
}

const EMPTY: FreeImageAllowance = { cap: 0, monthly: 0, bonus: 0, used: 0, remaining: 0 };

/** Images this account has bought. They do not expire, which is the whole
 *  difference between them and the monthly grant. */
async function boughtImages(userId: string): Promise<number> {
  // select("*") for the same reason getSettings does it: PostgREST fails the
  // whole query on one unknown column, and naming free_image_bonus before
  // migration 184 is applied would make every account unreadable here.
  const { data, error } = await supabase
    .from("account_settings").select("*").eq("user_id", userId).maybeSingle();
  if (error) return 0;
  const n = Number((data as Record<string, unknown> | null)?.free_image_bonus ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The free image lane is admins only, and shows as coming soon to everyone
 * else. Same shape and same reason as VIDEO_CREDITS_ADMIN_ONLY in
 * lib/credits.ts: these images run on Heclus's own provider account, so
 * opening them is a spend decision rather than a release date, and it should
 * be one line rather than a deploy.
 *
 * While this is on, freeImageAllowance reports nothing for a customer, which
 * every surface already reads as "no free lane": the Free tab keeps its
 * teaser, and z-image appears in the picker under its own name at its own
 * price instead of as the Heclus Images card.
 */
export const FREE_IMAGES_ADMIN_ONLY = true;

export async function freeImageAllowance(user: User): Promise<FreeImageAllowance> {
  // Customers only. An account that has never paid gets nothing: this is real
  // provider spend, and planSlugOf would otherwise resolve a bare signup to
  // Starter and hand it Starter's allowance. hasPaidAccess is true for admins,
  // so they still draw the top tier through resolveQuotaCap below.
  if (!hasPaidAccess(user)) return EMPTY;
  const meta = (user.app_metadata ?? {}) as { plan?: string };
  // Heclus plans only, keyed on the product rather than the tier.
  //
  // Allowances are stored per tier, and legacy starter and heclus_starter are
  // the same tier, so a tier-keyed allowance cannot tell them apart. That would
  // switch this perk on for customers whose plan was priced years before it
  // existed. Admins are exempt so the feature stays testable.
  const admin = isAdminUser(user);
  if (FREE_IMAGES_ADMIN_ONLY && !admin) return EMPTY;
  if (!admin && !isHeclusCreditsPlan(billingPlanOf(user))) return EMPTY;
  const [monthly, bonus] = await Promise.all([
    resolveQuotaCap("free_image_credits", meta.plan, admin),
    boughtImages(user.id),
  ]);
  // A plan with no allowance can still hold bought images: buying is what a
  // customer does when the monthly figure is not enough, and taking those away
  // because the plan grants none would be taking something they paid for.
  // Bought images survive the check above only for an account that could buy
  // them, which is a Heclus plan by definition.
  const cap = monthly + bonus;
  if (cap <= 0) return EMPTY;
  const used = await getFreeUsageThisMonth(user.id, "free_image_credits");
  return { cap, monthly, bonus, used, remaining: Math.max(0, cap - used) };
}

/**
 * Whether this generation is free, and if so, count it.
 *
 * Counted before the provider is called rather than after, for the same reason
 * the wallet holds before it settles: two generations running at once would
 * otherwise both read the same remaining figure and both decide they were free.
 * The counter is the cheap approximation of a hold, and over-counting a failed
 * generation costs the customer one image rather than costing us one.
 */
export async function claimFreeImage(user: User, modelId: string): Promise<boolean> {
  if (modelId !== FREE_IMAGE_MODEL) return false;
  const { remaining } = await freeImageAllowance(user);
  if (remaining <= 0) return false;
  await incrementFreeUsage(user.id, "free_image_credits", 1);
  return true;
}
