import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { getEffectivePaymentMode } from "@/lib/env";
import { WALLET_FUNDING_ADMIN_ONLY } from "@/lib/funding";
import { DEFAULT_CREDIT_RATES, USD_PER_CREDIT, invalidateRatesCache, creditsForUnits, type CreditRates, type NumericRateKey } from "@/lib/pricing";
import type { CostStep, CostUnitKind } from "@/lib/costs";

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

// Numeric keys only: the per-model USD maps in credit_rates are edited as JSON
// rather than through this editor, and feeding one to Number() would store NaN.
const RATE_KEYS = Object.keys(DEFAULT_CREDIT_RATES) as NumericRateKey[];

export interface HeclusCreditsConfig {
  packLinkTest: string | null;
  packLinkProduction: string | null;
  packCredits: number | null;
  packPriceUsd: number | null;
  signupGrantCredits: number | null;
  /** Pro and Founder. Unset means they read the Starter figure. */
  signupGrantCreditsPro: number | null;
  /** Max. Unset means it reads the nearest tier below that has one. */
  signupGrantCreditsMax: number | null;
  /** Only the keys an admin has overridden. The rest fall back to the defaults,
   *  which are sent alongside so the form can show what it would use. */
  rates: Partial<CreditRates>;
  defaultRates: CreditRates;
  /** Which link this deployment actually reads, from HECLUS_ENV. */
  activeEnv: "test" | "production";
  /** Columns migrations 130, 132 and 133 add. False means the tab can display
   *  but not save that field, and says why. */
  schema: { pack: boolean; signupGrant: boolean; signupGrantPro: boolean; signupGrantMax: boolean; rates: boolean };
  /** The keys the wallet spends. Set on the API Keys tab, shown here because a
   *  wallet with no provider key behind it fails every generation. */
  keys: { kie: boolean; elevenlabs: boolean };
  /** Rollout state of the funding mode itself. A code constant, so read-only. */
  walletAdminOnly: boolean;
  wallet: { accounts: number; creditsOutstanding: number };
  /** What a video actually costs, computed from metered usage rather than from
   *  an example. Null when there is not enough history to be worth showing. */
  breakdown: Breakdown | null;
}

export interface BreakdownLine {
  label: string;
  /** What the provider bills for, in its own units. */
  unit: string;
  /** Credits per one of those units, as configured. */
  rate: number;
  /** The rate as a person reads it. "0.072 per character" is the same number as
   *  "72 per 1,000 characters" and only one of them is the number an admin typed
   *  into the field above. */
  rateLabel: string;
  /** How many units a video takes, median across projects with history. */
  quantity: number;
  credits: number;
}

export interface Breakdown {
  usdPerCredit: number;
  lines: BreakdownLine[];
  totalCredits: number;
  /** Projects the medians are drawn from. Small numbers mean take it lightly. */
  projects: number;
  /** What the configured pack and grant buy, in videos. */
  packVideos: number | null;
  grantVideos: number | null;
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
    const claude = (stored as Record<string, unknown>).claudeModelUsd;
    if (claude && typeof claude === "object") {
      (rates as Record<string, unknown>).claudeModelUsd = claude;
    }
  }

  const effectiveRates = { ...DEFAULT_CREDIT_RATES, ...rates };
  const [kie, elevenlabs, wallet, breakdown] = await Promise.all([
    hasProductKey("heclus_kie_api_key"),
    hasProductKey("heclus_elevenlabs_api_key"),
    walletTotals(),
    typicalVideo(effectiveRates, num(row.heclus_pack_credits), num(row.heclus_signup_grant_credits)),
  ]);

  return NextResponse.json({
    packLinkTest: str(row.heclus_pack_checkout_url_test),
    packLinkProduction: str(row.heclus_pack_checkout_url_production),
    packCredits: num(row.heclus_pack_credits),
    packPriceUsd: num(row.heclus_pack_price_usd),
    signupGrantCredits: num(row.heclus_signup_grant_credits),
    signupGrantCreditsPro: num(row.heclus_signup_grant_credits_pro),
    signupGrantCreditsMax: num(row.heclus_signup_grant_credits_max),
    rates,
    defaultRates: DEFAULT_CREDIT_RATES,
    activeEnv: getEffectivePaymentMode(),
    schema: {
      pack: "heclus_pack_checkout_url_test" in row,
      signupGrant: "heclus_signup_grant_credits" in row,
      signupGrantPro: "heclus_signup_grant_credits_pro" in row,
      signupGrantMax: "heclus_signup_grant_credits_max" in row,
      rates: "credit_rates" in row,
    },
    keys: { kie, elevenlabs },
    walletAdminOnly: WALLET_FUNDING_ADMIN_ONLY,
    wallet,
    breakdown,
  } satisfies HeclusCreditsConfig);
}

export interface HeclusCreditsPatch {
  packLinkTest?: string | null;
  packLinkProduction?: string | null;
  packCredits?: number | string | null;
  packPriceUsd?: number | string | null;
  signupGrantCredits?: number | string | null;
  signupGrantCreditsPro?: number | string | null;
  signupGrantCreditsMax?: number | string | null;
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
    ["signupGrantCreditsPro", "heclus_signup_grant_credits_pro"],
    ["signupGrantCreditsMax", "heclus_signup_grant_credits_max"],
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

    // The per-model maps are edited as JSON rather than through the numeric
    // fields, because there is a row per model and the set changes whenever
    // Anthropic ships one. Validated the same way the loader validates them:
    // a malformed entry is rejected here rather than silently dropped there.
    const claude = (body.rates as Record<string, unknown>).claudeModelUsd;
    if (claude !== undefined && claude !== null && claude !== "") {
      if (typeof claude !== "object") {
        return NextResponse.json({ error: "rates.claudeModelUsd must be an object of model to { in, out }" }, { status: 400 });
      }
      const parsed: Record<string, { in: number; out: number }> = {};
      for (const [model, value] of Object.entries(claude as Record<string, unknown>)) {
        const usdIn = Number((value as { in?: unknown })?.in);
        const usdOut = Number((value as { out?: unknown })?.out);
        if (!Number.isFinite(usdIn) || !Number.isFinite(usdOut) || usdIn < 0 || usdOut < 0) {
          return NextResponse.json(
            { error: `rates.claudeModelUsd.${model} must be { "in": number, "out": number }, in USD per million tokens` },
            { status: 400 },
          );
        }
        parsed[model] = { in: usdIn, out: usdOut };
      }
      if (Object.keys(parsed).length) (next as Record<string, unknown>).claudeModelUsd = parsed;
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

/**
 * What one video costs, from what the product has actually metered.
 *
 * Computed rather than illustrated, because the only version of this worth
 * putting in front of a pricing decision is the one drawn from real projects.
 *
 * Aggregated in the database, not here. Totalling by hand meant reading
 * project_costs row by row, and PostgREST caps a response at 1,000 rows whatever
 * limit is asked for: the medians came from an arbitrary slice, a project could
 * be counted half-way through, and paging to 12,000 rows still truncated at 31
 * projects while taking a dozen round trips. One SELECT returns the medians over
 * all history in one.
 *
 * Medians per project, not means, and per step only across the projects that
 * used that step: averaging in the zeros of every project that skipped
 * thumbnails would report a cost nobody ever paid.
 */
const MIN_PROJECTS = 3;

/** Priced the way a wallet user is actually billed. Their writing steps route
 *  heclus_kie and arrive as kie_credits, so the claude_tokens_* rows in the
 *  ledger belong to BYO and direct-routed accounts and would double-count. */
const BREAKDOWN_GROUPS: {
  label: string;
  unit: string;
  steps: CostStep[];
  unitKind: CostUnitKind;
}[] = [
  { label: "Images", unit: "KIE credits", unitKind: "kie_credits", steps: ["image_gen"] },
  { label: "Video clips", unit: "KIE credits", unitKind: "kie_credits", steps: ["video_gen"] },
  { label: "Voiceover", unit: "characters", unitKind: "elevenlabs_chars", steps: ["tts"] },
  { label: "Captions", unit: "characters", unitKind: "elevenlabs_chars", steps: ["assemble"] },
  {
    label: "Writing steps", unit: "KIE credits", unitKind: "kie_credits",
    steps: ["channel_analysis", "topic", "script", "visuals", "prompts_image", "prompts_video"],
  },
  { label: "Thumbnails", unit: "KIE credits", unitKind: "kie_credits", steps: ["thumbnail_concept", "thumbnail_image"] },
];

// Per project first, then the median across projects. Both halves have to happen
// in SQL: a median of per-row values would answer a different and useless
// question ("what does one image cost", not "what does a video cost").
const BREAKDOWN_SQL = `
  with per_project as (
    select project_id, step, unit_kind, sum(units) as units
      from project_costs
     group by 1, 2, 3
  )
  select step,
         unit_kind,
         percentile_cont(0.5) within group (order by units) as median_units,
         count(*) as projects
    from per_project
   group by 1, 2
`;

interface MedianRow { step: string; unit_kind: string; median_units: number | string; projects: number }

async function typicalVideo(
  rates: CreditRates,
  packCredits: number | null,
  grantCredits: number | null,
): Promise<Breakdown | null> {
  // The read-only SQL helper from migration 128. It forces a read-only
  // transaction and a statement timeout, so the worst this can do is time out.
  const { data, error } = await supabase.rpc("admin_readonly_query", { q: BREAKDOWN_SQL, row_cap: 500 });
  if (error || !data) {
    console.warn("[heclus-credits] breakdown query failed:", error?.message);
    return null;
  }

  const medians = (Array.isArray(data) ? data : []) as MedianRow[];
  if (medians.length === 0) return null;

  const lines: BreakdownLine[] = [];
  let projects = 0;
  for (const g of BREAKDOWN_GROUPS) {
    // A group can span several steps (the writing steps do), so its per-video
    // quantity is the sum of their medians.
    let quantity = 0;
    let groupProjects = 0;
    for (const row of medians) {
      if (row.unit_kind !== g.unitKind || !(g.steps as string[]).includes(row.step)) continue;
      quantity += Number(row.median_units) || 0;
      groupProjects = Math.max(groupProjects, Number(row.projects) || 0);
    }
    if (quantity <= 0 || groupProjects < MIN_PROJECTS) continue;
    projects = Math.max(projects, groupProjects);
    const rate = creditsForUnits(g.unitKind, 1, rates, { step: g.steps[0] });
    lines.push({
      label: g.label,
      unit: g.unit,
      rate,
      // KIE still reads per credit rather than per thousand, but the figure is
      // the configured rate now rather than a peg the label could assert.
      rateLabel: g.unitKind === "kie_credits"
        ? (rate === 1 ? "1 to 1" : `${rate.toLocaleString()} per credit`)
        : `${creditsForUnits(g.unitKind, 1_000, rates, { step: g.steps[0] }).toLocaleString()} per 1k`,
      quantity,
      credits: creditsForUnits(g.unitKind, quantity, rates, { step: g.steps[0] }),
    });
  }
  if (lines.length === 0) return null;

  const totalCredits = lines.reduce((sum, l) => sum + l.credits, 0);
  return {
    usdPerCredit: USD_PER_CREDIT,
    lines,
    totalCredits,
    projects,
    packVideos: packCredits && totalCredits > 0 ? packCredits / totalCredits : null,
    grantVideos: grantCredits && totalCredits > 0 ? grantCredits / totalCredits : null,
  };
}
