import { supabase } from "@/lib/supabase/client";
import { getEffectivePaymentMode } from "@/lib/env";

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
  /** Actual chargeable amount in the smallest currency unit (cents).
   * Read by /api/dodo/verify's price guard and /api/plan's post-webhook
   * plan backfill. Null when the plan has no strict price (custom,
   * gifted, etc.) — guard skips those. */
  priceCents: number | null;
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
  price_cents: number | null;
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
    priceCents: typeof r.price_cents === "number" ? r.price_cents : null,
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
 * The Dodo environment that should be used right now. Hard-coded by
 * the deployment env (HECLUS_ENV via lib/env.ts) — local + staging
 * always return 'test', the live production deployment returns
 * 'production'. The DB column dodo_payment_mode is no longer read at
 * runtime; the admin panel shows the effective mode as an
 * informational indicator only.
 */
export async function getPaymentMode(): Promise<PaymentMode> {
  return getEffectivePaymentMode();
}

/**
 * Read the per-env Dodo settings from product_config._global. The
 * `mode` field is the deployment-env-derived effective mode (NOT the
 * stored DB value), so every consumer automatically resolves to the
 * right test or production credentials without needing to special-
 * case the deployment env themselves.
 */
export async function getPaymentSettings(): Promise<{
  mode: PaymentMode;
  productionTestLink: string | null;
  secretKeyTest: string | null;
  secretKeyProduction: string | null;
  baseUrlTest: string | null;
  baseUrlProduction: string | null;
  webhookSecretTest: string | null;
  webhookSecretProduction: string | null;
  customerPortalUrlTest: string | null;
  customerPortalUrlProduction: string | null;
}> {
  const mode = getEffectivePaymentMode();
  const { data, error } = await supabase
    .from("product_config")
    .select("dodo_production_test_link, dodo_secret_key_test, dodo_secret_key_production, dodo_base_url_test, dodo_base_url_production, dodo_webhook_secret_test, dodo_webhook_secret_production, dodo_customer_portal_url_test, dodo_customer_portal_url_production")
    .eq("service", "_global")
    .maybeSingle();
  if (error) {
    console.warn("[plans] payment settings read failed:", error.message);
    return {
      mode,
      productionTestLink: null,
      secretKeyTest: null,
      secretKeyProduction: null,
      baseUrlTest: null,
      baseUrlProduction: null,
      webhookSecretTest: null,
      webhookSecretProduction: null,
      customerPortalUrlTest: null,
      customerPortalUrlProduction: null,
    };
  }
  const row = data as {
    dodo_production_test_link: string | null;
    dodo_secret_key_test: string | null;
    dodo_secret_key_production: string | null;
    dodo_base_url_test: string | null;
    dodo_base_url_production: string | null;
    dodo_webhook_secret_test: string | null;
    dodo_webhook_secret_production: string | null;
    dodo_customer_portal_url_test: string | null;
    dodo_customer_portal_url_production: string | null;
  } | null;
  const trimOrNull = (v: string | null | undefined) => v?.trim() || null;
  return {
    mode,
    productionTestLink: trimOrNull(row?.dodo_production_test_link),
    secretKeyTest: trimOrNull(row?.dodo_secret_key_test),
    secretKeyProduction: trimOrNull(row?.dodo_secret_key_production),
    baseUrlTest: trimOrNull(row?.dodo_base_url_test),
    baseUrlProduction: trimOrNull(row?.dodo_base_url_production),
    webhookSecretTest: trimOrNull(row?.dodo_webhook_secret_test),
    webhookSecretProduction: trimOrNull(row?.dodo_webhook_secret_production),
    customerPortalUrlTest: trimOrNull(row?.dodo_customer_portal_url_test),
    customerPortalUrlProduction: trimOrNull(row?.dodo_customer_portal_url_production),
  };
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
