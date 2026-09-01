import type { User } from "@supabase/supabase-js";
import { isAdminUser } from "@/lib/admin";
import { entitlementTier, tierRank, TOP_TIER, ADMIN_PLAN, type Tier } from "@/lib/plan-tier";

// Shared source of truth for which features are gated behind which
// plan tiers. UI components (resolution picker on Assemble) and
// server routes (assemble POST) import from here so the gate can't
// drift between client-side affordance and server-side enforcement.
//
// Adding a new gated feature: extend FEATURE_GATES below and the
// resolution-style switch in the UI / server. Adding a new plan to
// the bypass set: just add it to PRO_TIER_PLANS.
//
// Gating something new behind a tier: compare ranks with meetsTier rather than
// testing a set, so Max keeps everything Pro has without being listed twice.

/**
 * The tier each gated render preset needs.
 *
 * A map rather than a set because the ladder stopped being a boolean: 1440p is
 * Pro, 2160p is Max, and 720p/1080p are ungated and simply absent. Add a
 * preset here and both the picker's badge and the server's 403 pick it up.
 */
export const RESOLUTION_TIER: Record<string, Tier> = {
  "1440p": "pro",
  "2160p": "max",
};

/** Every preset that needs an upgrade of some kind, whichever tier it is.
 *  Derived so it cannot drift from the map above. */
export const PRO_RESOLUTIONS = new Set<string>(Object.keys(RESOLUTION_TIER));

// Plan slugs that bypass Pro gates. `admin` covers internal users
// (data-driven `app_metadata.is_admin === true` is folded into this
// set by isProTier below — admins always count as Pro for feature
// access regardless of their literal plan slug).
//
// `max` is here because it sits ABOVE pro: a tier that clears the Pro gates
// has to be in every set that spells them out, or adding it silently strips
// Pro's entitlements one call site at a time. Prefer meetsTier(user, "pro")
// in new code — this set cannot express "at least", only "one of".
export const PRO_TIER_PLANS = new Set<string>(["pro", TOP_TIER, ADMIN_PLAN]);

/** The ladder lives in plan-tier.ts, which quota-config.ts can also import.
 *  Re-exported here so a gate has one place to import from. */
export { tierRank, type Tier } from "@/lib/plan-tier";

/**
 * The tier a plan slug grants.
 *
 * Takes the slug rather than the User so a client component that already read
 * app_metadata.plan can call it without rebuilding a User. "admin" is the
 * sentinel the Assemble picker stores for an admin, and it tops the ladder.
 */
export function tierForPlan(plan: string | null | undefined): Tier {
  const raw = (plan ?? "").trim().toLowerCase();
  if (raw === ADMIN_PLAN) return TOP_TIER;
  const tier = entitlementTier(raw);
  return tierRank(tier) >= 0 ? (tier as Tier) : "starter";
}

/** The tier this user is entitled to. Admins top the ladder, same as isProTier. */
export function tierOf(user: User | null | undefined): Tier {
  if (user && isAdminUser(user)) return TOP_TIER;
  return tierForPlan(planSlugOf(user));
}

/** True when this user is at or above the tier required. */
export function meetsTier(user: User | null | undefined, required: Tier): boolean {
  return tierRank(tierOf(user)) >= tierRank(required);
}

/** The tier this resolution needs, or null when anyone may render it. */
export function requiredTierForResolution(res: string | null | undefined): Tier | null {
  return (typeof res === "string" && RESOLUTION_TIER[res]) || null;
}

/**
 * Plans that keep a resolution the new ladder would take away from them.
 *
 * 2160p moved from Pro to Max with the Heclus products. That is the right
 * ladder for a plan somebody buys today, but the legacy `pro` product was sold
 * with 4K included and is still being paid for by 24 subscribers. Applying the
 * new rule to them would quietly remove something they bought.
 *
 * Legacy `pro` only. heclus_pro was sold under the new ladder and never
 * included 4K, so it is not grandfathered.
 */
const GRANDFATHERED_RESOLUTIONS: Record<string, ReadonlySet<string>> = {
  pro: new Set(["2160p"]),
};

/** True when this plan slug keeps a resolution the tier ladder would deny it. */
function isGrandfathered(plan: string | null | undefined, res: string | null | undefined): boolean {
  const kept = GRANDFATHERED_RESOLUTIONS[(plan ?? "").trim().toLowerCase()];
  return !!kept && !!res && kept.has(res);
}

/**
 * True when this user may render at this resolution.
 *
 * The one answer for the server. Call it rather than pairing
 * requiredTierForResolution with a tier comparison: that spelling is what let
 * the grandfather clause below be written and then not apply anywhere.
 */
export function canUseResolution(user: User | null | undefined, res: string | null | undefined): boolean {
  const required = requiredTierForResolution(res);
  if (!required) return true;
  // meetsTier folds in admin via tierOf, so this covers internal users too.
  if (meetsTier(user, required)) return true;
  return isGrandfathered(billingPlanOf(user), res);
}

/**
 * The same answer from a bare plan slug, for the picker.
 *
 * The Assemble page holds a slug ("pro", "heclus_max", or "admin" for an
 * internal user) rather than a User, and a badge that disagrees with the
 * server is either a lock on something that would render or an unlocked
 * button that 403s.
 */
export function resolutionAllowedForPlan(plan: string | null | undefined, res: string | null | undefined): boolean {
  const required = requiredTierForResolution(res);
  if (!required) return true;
  if (tierRank(tierForPlan(plan)) >= tierRank(required)) return true;
  return isGrandfathered(plan, res);
}

/** The tier's name as a customer sees it. */
export function tierLabel(tier: Tier): string {
  return tier === "max" ? "Max" : tier === "pro" ? "Pro" : "Starter";
}

/**
 * The entitlement tier this user is on, from app_metadata.plan.
 *
 * Returns the tier rather than the billing plan, so heclus_pro answers "pro"
 * and every gate below reads correctly without knowing the product exists. The
 * direction is deliberate: a future call site that forgets to normalise gets
 * the right entitlement rather than silently stripping one.
 *
 * Use billingPlanOf when you need what they actually pay for.
 */
export function planSlugOf(user: User | null | undefined): string {
  const raw = billingPlanOf(user);
  return raw ? entitlementTier(raw) : "starter";
}

/**
 * The plan they are billed on, verbatim: "starter", "pro", "heclus_pro".
 *
 * For billing surfaces and the admin view only. An entitlement check that uses
 * this is a bug waiting for the next product to be added.
 */
export function billingPlanOf(user: User | null | undefined): string {
  const meta = (user?.app_metadata ?? {}) as { plan?: unknown };
  if (typeof meta.plan === "string" && meta.plan.trim()) {
    return meta.plan.trim().toLowerCase();
  }
  return "starter";
}

/**
 * True when the user has a Pro-tier plan OR counts as an admin.
 * Admin detection is delegated to isAdminUser so BOTH the metadata
 * flag and the legacy hardcoded email backstop qualify — otherwise
 * the founder admin (recognised by email only) gets locked out of
 * Pro-only features like 4K assemble.
 */
export function isProTier(user: User | null | undefined): boolean {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  // Rank, not membership: Max is above Pro and clears every Pro gate.
  return meetsTier(user, "pro");
}

/**
 * Returns true when this resolution requires a Pro plan to use.
 */
export function isProResolution(res: string | null | undefined): boolean {
  return typeof res === "string" && PRO_RESOLUTIONS.has(res);
}
