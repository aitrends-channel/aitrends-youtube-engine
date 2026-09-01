// Which plan a customer pays for, against which entitlements they get.
//
// Those were the same string until the Heclus Credits plans arrived. They are
// not any more: heclus_starter and heclus_pro are new Dodo products at new
// prices, sold so that customers on the old products keep the old prices. The
// entitlements are unchanged, so heclus_pro is a Pro customer in every way the
// code cares about.
//
// The reason this exists as a module rather than a few extra string comparisons:
// eight places compare a plan slug literally, and every one of them fails
// closed. An unrecognised slug loses 4K assemble, the signup grant, both TTS
// caps, free video credits, storage, unlimited voice clones and support
// priority, silently and one entitlement at a time. Failing closed is right;
// leaving eight sites to each remember a new name is not.
//
// No imports on purpose. This is called from lib/quota-config.ts, from
// lib/plans-gating.ts and from a client component, so anything it pulled in
// would be pulled into all three.

/**
 * The entitlement ladder, lowest first.
 *
 * Here rather than in plans-gating.ts because quota-config.ts needs it too, and
 * this module is the one both can import: it pulls in nothing, on purpose.
 */
export const TIER_ORDER = ["starter", "pro", "max"] as const;
export type Tier = typeof TIER_ORDER[number];

/** The top of the ladder. What an admin is entitled to, everywhere.
 *
 *  Derived rather than written down, so adding a tier above Max lifts every
 *  admin onto it instead of quietly leaving them a tier behind. Hardcoding
 *  "pro" here is exactly how they were left on Pro when Max arrived. */
export const TOP_TIER: Tier = TIER_ORDER[TIER_ORDER.length - 1];

/** The slug make-admin writes into app_metadata.plan. Not a tier of its own:
 *  it resolves to the top of the ladder wherever entitlements are read. */
export const ADMIN_PLAN = "admin";

/** Where a tier sits on the ladder, or -1 when it is not on it. Unknown ranks
 *  below starter so an unrecognised plan loses features rather than gaining
 *  them. */
export function tierRank(tier: string | null | undefined): number {
  return TIER_ORDER.indexOf((tier ?? "").trim().toLowerCase() as Tier);
}

/** This tier and every one beneath it, highest first.
 *
 *  What a lookup keyed by tier should walk when the exact tier has no entry:
 *  a new tier above Pro inherits Pro's allowance instead of resolving to
 *  nothing, which is what an unfilled config would otherwise hand it. */
export function tierFallbacks(tier: string | null | undefined): Tier[] {
  const rank = tierRank(tier);
  if (rank < 0) return [];
  return TIER_ORDER.slice(0, rank + 1).reverse() as unknown as Tier[];
}

/**
 * Billing plan to entitlement tier.
 *
 * Only add a row here when a new product sells an existing tier at a different
 * price. A genuinely new tier gets its own entitlements and belongs in the
 * quota config and the gate sets instead.
 */
const BILLING_TO_TIER: Record<string, string> = {
  heclus_starter: "starter",
  heclus_pro: "pro",
  heclus_max: "max",
  "production-test": "starter",
};

/**
 * The tier this plan grants. Every gate, cap and quota lookup wants this one.
 *
 * An unknown slug passes through unchanged rather than falling back to a tier,
 * so a typo stays visibly wrong instead of quietly granting Pro.
 */
export function entitlementTier(plan: string | null | undefined): string {
  const raw = (plan ?? "").trim().toLowerCase();
  return BILLING_TO_TIER[raw] ?? raw;
}

/** True when this plan is one of the Heclus Credits products. Used by the
 *  billing surfaces, never by an entitlement check. */
export function isHeclusCreditsPlan(plan: string | null | undefined): boolean {
  return (plan ?? "").trim().toLowerCase() in BILLING_TO_TIER;
}

/** The Heclus Credits product that sells the same tier as this plan, or null
 *  when there is no such product or the plan is already one. */
export function heclusPlanFor(plan: string | null | undefined): string | null {
  const tier = entitlementTier(plan);
  if (isHeclusCreditsPlan(plan)) return null;
  for (const [billing, t] of Object.entries(BILLING_TO_TIER)) {
    if (t === tier) return billing;
  }
  return null;
}
