import type { User } from "@supabase/supabase-js";
import { isAdminUser } from "@/lib/admin";
import { entitlementTier } from "@/lib/plan-tier";

// Shared source of truth for which features are gated behind which
// plan tiers. UI components (resolution picker on Assemble) and
// server routes (assemble POST) import from here so the gate can't
// drift between client-side affordance and server-side enforcement.
//
// Adding a new gated feature: extend FEATURE_GATES below and the
// resolution-style switch in the UI / server. Adding a new plan to
// the bypass set: just add it to PRO_TIER_PLANS.

// Render resolutions that require a Pro-tier plan. The Assemble UI
// renders these with a PRO badge and opens the SubscriptionModal on
// click for non-Pro users; the server rejects the request if a non-
// Pro user manages to POST one of these anyway.
export const PRO_RESOLUTIONS = new Set<string>(["1440p", "2160p"]);

// Plan slugs that bypass Pro gates. `admin` covers internal users
// (data-driven `app_metadata.is_admin === true` is folded into this
// set by isProTier below — admins always count as Pro for feature
// access regardless of their literal plan slug).
export const PRO_TIER_PLANS = new Set<string>(["pro", "admin"]);

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
  return PRO_TIER_PLANS.has(planSlugOf(user));
}

/**
 * Returns true when this resolution requires a Pro plan to use.
 */
export function isProResolution(res: string | null | undefined): boolean {
  return typeof res === "string" && PRO_RESOLUTIONS.has(res);
}
