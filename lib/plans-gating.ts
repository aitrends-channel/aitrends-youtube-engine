import type { User } from "@supabase/supabase-js";

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
 * Returns the lowercase plan slug stored on app_metadata.plan, or
 * "starter" if it's missing/non-string. Mirrors what the UI does so
 * the gate decisions match between client and server.
 */
export function planSlugOf(user: User | null | undefined): string {
  const meta = (user?.app_metadata ?? {}) as { plan?: unknown };
  if (typeof meta.plan === "string" && meta.plan.trim()) {
    return meta.plan.trim().toLowerCase();
  }
  return "starter";
}

/**
 * True when the user has a Pro-tier plan OR carries the
 * app_metadata.is_admin flag. Admins always pass feature gates
 * regardless of their visible plan, so we treat them as Pro for
 * access decisions.
 */
export function isProTier(user: User | null | undefined): boolean {
  if (!user) return false;
  const flag = (user.app_metadata as { is_admin?: unknown } | undefined)?.is_admin;
  if (flag === true) return true;
  return PRO_TIER_PLANS.has(planSlugOf(user));
}

/**
 * Returns true when this resolution requires a Pro plan to use.
 */
export function isProResolution(res: string | null | undefined): boolean {
  return typeof res === "string" && PRO_RESOLUTIONS.has(res);
}
