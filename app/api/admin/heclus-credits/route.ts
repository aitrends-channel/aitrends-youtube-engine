import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { getEffectivePaymentMode } from "@/lib/env";
import { WALLET_FUNDING_ADMIN_ONLY } from "@/lib/funding";
import { DEFAULT_CREDIT_RATES, invalidateRatesCache, type CreditRates } from "@/lib/pricing";

export const dynamic = "force-dynamic";

// Everything an admin can configure about the Heclus Credits wallet.
//
// One endpoint for one tab, rather than the pack link living on the Payment tab
// beside the subscription plumbing. They looked related because both are Dodo
// links, but nothing else about the wallet belongs there, and a setting nobody
// can find is a setting that stays unset.
//
// Reads with select("*"): PostgREST fails the whole query on one unknown column,
// and this row is written by migrations applied by hand. Missing columns are
// reported as such rather than making the tab unreadable.

const RATE_KEYS = Object.keys(DEFAULT_CREDIT_RATES) as (keyof CreditRates)[];

export interface HeclusCreditsConfig {
  packLinkTest: string | null;
  packLinkProduction: string | null;
  packCredits: number | null;
  packPriceUsd: number | null;
  signupGrantCredits: number | null;
  /** Only the keys an admin has overridden. The rest fall back to the defaults,
   *  which are sent alongside so the form can show what it would use. */
  rates: Partial<CreditRates>;
  defaultRates: CreditRates;
  /** Which link this deployment actually reads, from HECLUS_ENV. */
  activeEnv: "test" | "production";
  /** Columns migrations 130, 132 and 133 add. False means the tab can display
   *  but not save that field, and says why. */
  schema: { pack: boolean; signupGrant: boolean; rates: boolean };
  /** The keys the wallet spends. Set on the API Keys tab, shown here because a
   *  wallet with no provider key behind it fails every generation. */
  keys: { kie: boolean; elevenlabs: boolean };
  /** Rollout state of the funding mode itself. A code constant, so read-only. */
  walletAdminOnly: boolean;
  wallet: { accounts: number; creditsOutstanding: number };
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { data } = await supabase
    .from("product_config")
    .select("*")
    .eq("service", "_global")
    .maybeSingle();
  const row = (data ?? {}) as Record<string, unknown>;

  const rates: Partial<CreditRates> = {};
  const stored = row.credit_rates;
  if (stored && typeof stored === "object") {
    for (const key of RATE_KEYS) {
      const n = Number((stored as Record<string, unknown>)[key]);
      if (Number.isFinite(n) && n >= 0) rates[key] = n;
    }
  }

  const [kie, elevenlabs, wallet] = await Promise.all([
    hasProductKey("heclus_kie_api_key"),
    hasProductKey("heclus_elevenlabs_api_key"),
    walletTotals(),
  ]);

  return NextResponse.json({
    packLinkTest: str(row.heclus_pack_checkout_url_test),
    packLinkProduction: str(row.heclus_pack_checkout_url_production),
    packCredits: num(row.heclus_pack_credits),
    packPriceUsd: num(row.heclus_pack_price_usd),
    signupGrantCredits: num(row.heclus_signup_grant_credits),
    rates,
    defaultRates: DEFAULT_CREDIT_RATES,
    activeEnv: getEffectivePaymentMode(),
    schema: {
      pack: "heclus_pack_checkout_url_test" in row,
      signupGrant: "heclus_signup_grant_credits" in row,
      rates: "credit_rates" in row,
    },
    keys: { kie, elevenlabs },
    walletAdminOnly: WALLET_FUNDING_ADMIN_ONLY,
    wallet,
  } satisfies HeclusCreditsConfig);
}

export interface HeclusCreditsPatch {
  packLinkTest?: string | null;
  packLinkProduction?: string | null;
  packCredits?: number | string | null;
  packPriceUsd?: number | string | null;
  signupGrantCredits?: number | string | null;
  rates?: Partial<Record<keyof CreditRates, number | string | null>>;
}

export async function PATCH(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: HeclusCreditsPatch;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const update: Record<string, unknown> = {};

  for (const [field, column] of [
    ["packLinkTest", "heclus_pack_checkout_url_test"],
    ["packLinkProduction", "heclus_pack_checkout_url_production"],
  ] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (raw !== null && typeof raw !== "string") {
      return NextResponse.json({ error: `${field} must be a string, null or ''` }, { status: 400 });
    }
    const trimmed = (raw ?? "").trim();
    // A link that is not a checkout URL cannot be credited: the webhook tells a
    // top-up apart from a subscription payment by the product id in this path.
    if (trimmed && !/\/buy\/[A-Za-z0-9_]+/.test(trimmed)) {
      return NextResponse.json(
        { error: `${field} does not look like a Dodo checkout link (expected .../buy/pdt_…). A payment on this link could not be told apart from a subscription.` },
        { status: 400 },
      );
    }
    update[column] = trimmed || null;
  }

  // Positive numbers or cleared. Zero is not a pack, and a zero grant is
  // expressed by clearing the field rather than storing it, so "unset" and
  // "deliberately nothing" cannot drift apart.
  for (const [field, column] of [
    ["packCredits", "heclus_pack_credits"],
    ["packPriceUsd", "heclus_pack_price_usd"],
    ["signupGrantCredits", "heclus_signup_grant_credits"],
  ] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (raw === null || raw === "") { update[column] = null; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: `${field} must be a positive number, or empty to clear it` }, { status: 400 });
    }
    update[column] = n;
  }

  if (body.rates !== undefined) {
    if (body.rates === null || typeof body.rates !== "object") {
      return NextResponse.json({ error: "rates must be an object" }, { status: 400 });
    }
    const next: Partial<CreditRates> = {};
    for (const key of RATE_KEYS) {
      const raw = body.rates[key];
      if (raw === undefined || raw === null || raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: `rates.${key} must be a number of 0 or more, or empty to use the default` }, { status: 400 });
      }
      next[key] = n;
    }
    // An empty object stores NULL rather than {}: both mean "use the defaults",
    // and only one of them says so when read back.
    update.credit_rates = Object.keys(next).length ? next : null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no fields provided" }, { status: 400 });
  }

  const { error } = await supabase
    .from("product_config")
    .update(update)
    .eq("service", "_global");
  if (error) {
    // A missing column is the common failure here, and it needs a migration
    // rather than a retry, so say which one.
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  invalidateRatesCache();
  return NextResponse.json({ ok: true });
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

/** Whether a rotating product key row has at least one active key. */
async function hasProductKey(service: string): Promise<boolean> {
  const { data } = await supabase
    .from("product_config")
    .select("keys, active")
    .eq("service", service)
    .maybeSingle();
  if (!data || (data as { active?: boolean }).active === false) return false;
  return (((data as { keys?: unknown }).keys ?? []) as string[]).length > 0;
}

/** What the wallet owes its holders, so a rate change is made with the size of
 *  the outstanding float in view. */
async function walletTotals(): Promise<{ accounts: number; creditsOutstanding: number }> {
  const { data, error } = await supabase.from("credit_accounts").select("credits");
  if (error || !data) return { accounts: 0, creditsOutstanding: 0 };
  const rows = data as { credits: number | string }[];
  return {
    accounts: rows.length,
    creditsOutstanding: rows.reduce((sum, r) => sum + (Number(r.credits) || 0), 0),
  };
}
