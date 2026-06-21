import { supabase } from "@/lib/supabase/client";

export type PaymentMode = "test" | "production";

/**
 * Subscription plan row from the plans table. Single source of truth
 * for both the SubscriptionModal display and server-side niche-limit
 * enforcement (replaces the duplicated PLAN_LIMITS consts that used
 * to live in three different routes).
 *
 * paymentLink is the resolved URL based on the global
 * dodo_payment_mode (test vs production). Admin surfaces that need to
 * edit both URLs independently should read paymentLinkTest and
 * paymentLinkProduction.
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
  paymentLinkTest: string | null;
  paymentLinkProduction: string | null;
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
  payment_link_test: string | null;
  payment_link_production: string | null;
  highlighted: boolean;
  disabled: boolean;
  is_founder: boolean;
  sort_order: number;
}

function rowToPlan(r: PlanRow, mode: PaymentMode): Plan {
  const resolved = mode === "production" ? r.payment_link_production : r.payment_link_test;
  return {
    slug: r.slug,
    name: r.name,
    priceDisplay: r.price_display,
    periodDisplay: r.period_display,
    limitDisplay: r.limit_display,
    features: Array.isArray(r.features) ? (r.features as string[]) : [],
    nichesPerMonth: r.niches_per_month,
    paymentLink: resolved,
    paymentLinkTest: r.payment_link_test,
    paymentLinkProduction: r.payment_link_production,
    highlighted: r.highlighted,
    disabled: r.disabled,
    isFounder: r.is_founder,
    sortOrder: r.sort_order,
  };
}

/**
 * Read the global Dodo payment mode from product_config._global.
 * Falls back to 'test' on any error / missing row so a misconfigured
 * environment never silently switches checkout to production.
 */
export async function getPaymentMode(): Promise<PaymentMode> {
  const settings = await getPaymentSettings();
  return settings.mode;
}

/**
 * Read the global payment settings (mode + admin-only production
 * test URL). One query so callers don't pay for two round-trips.
 */
export async function getPaymentSettings(): Promise<{
  mode: PaymentMode;
  productionTestLink: string | null;
}> {
  const { data, error } = await supabase
    .from("product_config")
    .select("dodo_payment_mode, dodo_production_test_link")
    .eq("service", "_global")
    .maybeSingle();
  if (error) {
    console.warn("[plans] payment settings read failed:", error.message);
    return { mode: "test", productionTestLink: null };
  }
  const row = data as {
    dodo_payment_mode: string | null;
    dodo_production_test_link: string | null;
  } | null;
  const mode: PaymentMode = row?.dodo_payment_mode === "production" ? "production" : "test";
  const link = row?.dodo_production_test_link?.trim();
  return { mode, productionTestLink: link || null };
}

/**
 * Fetch all plans ordered by sort_order then slug. The list is small
 * (single-digit rows) and reads come from the public-anon Supabase
 * client, so no caching layer — keep it simple, let Supabase's own
 * connection-pool handle the load.
 */
export async function getPlans(): Promise<Plan[]> {
  const [{ data, error }, mode] = await Promise.all([
    supabase
      .from("plans")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("slug", { ascending: true }),
    getPaymentMode(),
  ]);
  if (error) {
    console.warn("[plans] list failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => rowToPlan(r as PlanRow, mode));
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
  const [{ data, error }, mode] = await Promise.all([
    supabase
      .from("plans")
      .select("*")
      .eq("slug", normalized)
      .maybeSingle(),
    getPaymentMode(),
  ]);
  if (error) {
    console.warn(`[plans] lookup failed slug=${normalized}:`, error.message);
    return null;
  }
  if (!data) return null;
  return rowToPlan(data as PlanRow, mode);
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
