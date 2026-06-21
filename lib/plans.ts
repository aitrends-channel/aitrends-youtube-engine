import { supabase } from "@/lib/supabase/client";

/**
 * Subscription plan row from the plans table. Single source of truth
 * for both the SubscriptionModal display and server-side niche-limit
 * enforcement (replaces the duplicated PLAN_LIMITS consts that used
 * to live in three different routes).
 */
export interface Plan {
  slug: string;
  name: string;
  priceDisplay: string;
  periodDisplay: string;
  limitDisplay: string;
  features: string[];
  nichesPerMonth: number | null;
  paymentLink: string | null;
  highlighted: boolean;
  disabled: boolean;
  isFounder: boolean;
  sortOrder: number;
}

interface PlanRow {
  slug: string;
  name: string;
  price_display: string;
  period_display: string;
  limit_display: string;
  features: unknown;
  niches_per_month: number | null;
  payment_link: string | null;
  highlighted: boolean;
  disabled: boolean;
  is_founder: boolean;
  sort_order: number;
}

function rowToPlan(r: PlanRow): Plan {
  return {
    slug: r.slug,
    name: r.name,
    priceDisplay: r.price_display,
    periodDisplay: r.period_display,
    limitDisplay: r.limit_display,
    features: Array.isArray(r.features) ? (r.features as string[]) : [],
    nichesPerMonth: r.niches_per_month,
    paymentLink: r.payment_link,
    highlighted: r.highlighted,
    disabled: r.disabled,
    isFounder: r.is_founder,
    sortOrder: r.sort_order,
  };
}

/**
 * Fetch all plans ordered by sort_order then slug. The list is small
 * (single-digit rows) and reads come from the public-anon Supabase
 * client, so no caching layer — keep it simple, let Supabase's own
 * connection-pool handle the load.
 */
export async function getPlans(): Promise<Plan[]> {
  const { data, error } = await supabase
    .from("plans")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("slug", { ascending: true });
  if (error) {
    console.warn("[plans] list failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => rowToPlan(r as PlanRow));
}

/**
 * Look up one plan by slug. Returns null when the slug doesn't
 * resolve to a row (or on a DB error — fail-soft). Callers that need
 * to distinguish "unknown plan" from "known plan with no cap" should
 * use this and read .nichesPerMonth (null = unlimited) themselves.
 */
export async function getPlanBySlug(slug: string): Promise<Plan | null> {
  const normalized = slug.toLowerCase().trim();
  if (!normalized) return null;
  const { data, error } = await supabase
    .from("plans")
    .select("*")
    .eq("slug", normalized)
    .maybeSingle();
  if (error) {
    console.warn(`[plans] lookup failed slug=${normalized}:`, error.message);
    return null;
  }
  if (!data) return null;
  return rowToPlan(data as PlanRow);
}

/**
 * Return the niches_per_month cap for one plan slug, or null when the
 * plan is unlimited or absent. Matches the historical PLAN_LIMITS
 * lookup shape: callers compare against null to mean "no cap". Callers
 * that need to tell "unknown plan" from "unlimited plan" apart should
 * use getPlanBySlug instead.
 *
 * Fail-soft: a DB error returns null (unlimited). That's intentionally
 * the more-permissive failure mode — a transient DB blip shouldn't
 * lock a paid user out of creating projects.
 */
export async function getPlanLimit(slug: string): Promise<number | null> {
  const plan = await getPlanBySlug(slug);
  return plan?.nichesPerMonth ?? null;
}
