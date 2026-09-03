import type { User } from "@supabase/supabase-js";
import { isAdminUser } from "@/lib/admin";
import { isHeclusCreditsPlan } from "@/lib/plan-tier";

// Staged rollout of the Heclus Credits release.
//
// Everything in this release ships to production behind these flags so it can
// be exercised with real money, a real Dodo subscription and the real worker
// before a single customer sees it. Admins get the whole thing; everyone else
// keeps the product exactly as it is today.
//
// Same shape as VIDEO_CREDITS_ADMIN_ONLY in lib/credits.ts, which is how the
// video credit wallet was brought up. Going live is a one-line flip per area.

/**
 * The heclus_starter / heclus_pro / heclus_max products, and with them every
 * allowance and gate keyed to those plans.
 *
 * OPEN since 2026-09-03. Anyone can see and buy them, and a subscription taken
 * out from here on is a credits subscription. Customers on the legacy products
 * are untouched: they keep their prices, their keys and their entitlements
 * until they choose to move.
 *
 * This is the load-bearing flag. Almost everything else in the release hangs
 * off which plan an account is on, so keeping customers off the new products
 * keeps them off the new behaviour:
 *
 *   - custom sound and element uploads   (Max tier, /api/me/assets)
 *   - 2160p rendering                    (Max tier, RESOLUTION_TIER)
 *   - free image credits                 (Heclus plans only, lib/free-images.ts)
 *   - the revised credit packs and quota allowances
 *
 * None of those needs its own flag while this one is on.
 */
export const NEW_PLANS_ADMIN_ONLY = false;

/**
 * Sounds and elements were here too, as SOUND_EFFECTS_ADMIN_ONLY, kept internal
 * because they did not reach the finished video: the effects bed was built on an
 * ffmpeg input the library rejected, so every sound was dropped from the render
 * without anything failing. With that fixed they are gated by the tier that
 * sells them — Max — in the assemble page, alongside 4K and the custom asset
 * uploads, rather than by a flag here.
 */

/** True when this account may see and buy the new plans. */
export function canSeeNewPlans(user: User | null | undefined): boolean {
  return !NEW_PLANS_ADMIN_ONLY || isAdminUser(user);
}

/**
 * True when this plan slug is one the flag is hiding.
 *
 * Reads the slug through isHeclusCreditsPlan rather than a list kept here, so
 * a product added to BILLING_TO_TIER is covered without a second edit.
 *
 * production-test is in that map but is deliberately NOT gated: it is the
 * live-Dodo verification harness, it already has its own audience rule in
 * isProductionTestUser, and the QA account that uses it is not always an
 * admin. Gating it would take the one tool for testing a real charge away
 * from the release that most needs it.
 */
export function isGatedPlan(slug: string | null | undefined): boolean {
  const raw = (slug ?? "").trim().toLowerCase();
  if (raw === PRODUCTION_TEST_SLUG) return false;
  return NEW_PLANS_ADMIN_ONLY && isHeclusCreditsPlan(raw);
}

/** Kept in step with PRODUCTION_TEST_SLUG in components/SubscriptionModal.tsx. */
const PRODUCTION_TEST_SLUG = "production-test";

/** Whether Assemble offers sound effects at all. Off: the tab is withdrawn
 *  from everyone, admins included, while elements stay open to every account.
 *  A project that already carries beat or placed sounds still renders them. */
export function canUseSoundEffects(_user: User | null | undefined): boolean {
  return false;
}
