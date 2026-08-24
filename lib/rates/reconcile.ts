import { getActiveProductKey } from "@/lib/claude/routing";
import { claudeRateFor } from "@/lib/claude/models";
import { getCreditRates, USD_PER_CREDIT } from "@/lib/pricing";
import { getPoyoImageModel } from "@/lib/poyo/imageModels";
import { supabase } from "@/lib/supabase/client";
import { reconcileDrawdown, type DrawdownFinding } from "@/lib/providers/drawdown";

// Do the rates we bill at still match what the providers charge?
//
// Nothing tells us when Anthropic or ElevenLabs reprices. The rate tables are
// hand-maintained, so a price change is noticed by whoever happens to read a
// changelog, and until then every generation is billed at last quarter's
// number. This compares the two the only way that cannot be argued with: what
// the provider actually invoiced, divided by what it actually served.
//
// Deliberately not a pricing-page scraper. An invoice catches a repricing, but
// also a tier split, a batch discount, a context-window surcharge and a
// metering bug on our side, none of which a published price would show. It is
// also the number that decides whether the wallet made money.
//
// Anthropic is read entirely from its own reports — cost from
// /v1/organizations/cost_report, tokens from /v1/organizations/usage_report,
// both grouped by model. Dividing their dollars by our token counts would have
// been wrong the moment anything else used the same Anthropic org.
//
// ElevenLabs has no usage report to divide, so its figure is the invoice over
// the characters spoken in the billing period, which on a quota plan is an
// average rather than a marginal rate. Treated as indicative: it answers "is
// the rate roughly right", not "what does the next character cost".
//
// KIE has no row in any of that, and it is the largest spender. It issues no
// invoice and publishes no price list a credit count could drift against: it
// reports creditsConsumed per task and the wallet settles on that figure, so
// the number is KIE's own and cannot disagree with a KIE list that does not
// exist. What can still be wrong is whether we saw every charge, which is a
// different question and is answered by reconcileDrawdown: the fall in the
// provider's own balance against the credits our ledger recorded. That covers
// PoYo too, and it is the check that would have caught August's double-bought
// clips.
//
// Warn only. Nothing here writes a rate.

const ANTHROPIC_BASE = "https://api.anthropic.com";
const ELEVENLABS_BASE = "https://api.elevenlabs.io";

/** Cost report amounts are in the currency's lowest unit, so USD arrives in
 *  cents. Missing this is a hundredfold error in the safe-looking direction. */
const CENTS_PER_USD = 100;

export interface RateFinding {
  provider: "anthropic" | "elevenlabs" | "poyo";
  /** The model, or "all" for a provider billed as one pool. */
  model: string;
  /** input | output | cache_read | cache_write | characters */
  kind: string;
  /** What the table says we charge for, in USD. */
  tableUsd: number;
  /** What the provider actually charged, same unit. */
  actualUsd: number;
  /** actual / table - 1. Positive means the provider costs more than we bill. */
  drift: number;
  /** Volume behind the figure, for judging whether the drift is meaningful. */
  units: number;
  unit: "per 1M tokens" | "per 1k characters" | "credits per image";
  /** What tableUsd and actualUsd are counted in. The PoYo catalog check
   *  compares provider credits, not dollars, and formatting those with a
   *  currency symbol would read as a hundredfold error. */
  measure?: "usd" | "credits";
}

export interface RateReconciliation {
  /** When this ran, ISO. */
  at: string;
  /** The window read, ISO dates. */
  from: string;
  to: string;
  findings: RateFinding[];
  /** Findings past the noticeable threshold, worth an admin's attention. */
  drifted: RateFinding[];
  /** The account drawdown against recorded spend, per provider. A different
   *  question from the rate findings above: those ask whether the price is
   *  right, this asks whether every charge was recorded at all. KIE has no
   *  invoice and no price list, so this is the only check it has. */
  drawdown?: DrawdownFinding[];
  /** What could not be read, and why. Never throws: a provider that is down
   *  must not hide the one that answered. */
  problems: string[];
}

/** Below this, a difference is rounding, minimum-spend effects, or a day
 *  boundary. Above it, something changed. */
const DRIFT_THRESHOLD = 0.05;

/** Volume under which a rate is too noisy to conclude anything from. */
const MIN_TOKENS = 50_000;
const MIN_CHARS = 5_000;
const MIN_GENERATIONS = 3;

/** The catalog check reads metered history rather than an invoice, so it can
 *  look further back than the rate window without costing anything. */
const CATALOG_DAYS = 90;

async function anthropicAdminKey(): Promise<string | null> {
  return (await getActiveProductKey("anthropic_admin_key"))
    ?? process.env.ANTHROPIC_ADMIN_KEY?.trim()
    ?? null;
}

/** Admin keys authenticate as x-api-key; an OAuth token as a bearer. Both are
 *  accepted by the org endpoints and only the caller knows which they pasted,
 *  so the shape decides. */
function anthropicAuthHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (key.startsWith("sk-ant-")) headers["x-api-key"] = key;
  else headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

interface CostResult {
  amount?: string;
  currency?: string;
  model?: string | null;
  token_type?: string | null;
  cost_type?: string | null;
}

interface UsageResult {
  model?: string | null;
  uncached_input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

interface Bucket<T> { starting_at?: string; ending_at?: string; results?: T[] }
interface Report<T> { data?: Bucket<T>[]; has_more?: boolean; next_page?: string | null }

async function anthropicReport<T>(
  path: string,
  key: string,
  params: Record<string, string>,
): Promise<T[]> {
  const out: T[] = [];
  let page: string | null = null;

  // Paginated by time bucket. Bounded rather than while(true): a month of
  // daily buckets is one or two pages, and an endpoint that kept saying
  // has_more would otherwise hold the cron open until it timed out.
  for (let i = 0; i < 10; i++) {
    const url = new URL(`${ANTHROPIC_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (page) url.searchParams.set("page", page);

    const res = await fetch(url, { headers: anthropicAuthHeaders(key), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`${path} returned ${res.status}: ${body}`);
    }
    const body = (await res.json()) as Report<T>;
    for (const bucket of body.data ?? []) out.push(...(bucket.results ?? []));
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return out;
}

/** Which of our four rate kinds a reported token type belongs to. Cache writes
 *  come in two TTLs at different prices; only the 5-minute one is comparable to
 *  the 1.25x multiplier we bill, so the 1-hour rows are left out rather than
 *  averaged into it. */
function kindOfTokenType(tokenType: string | null | undefined): RateFinding["kind"] | null {
  switch (tokenType) {
    case "uncached_input_tokens": return "input";
    case "output_tokens": return "output";
    case "cache_read_input_tokens": return "cache_read";
    case "cache_creation.ephemeral_5m_input_tokens": return "cache_write";
    default: return null;
  }
}

function tokensOfKind(usage: UsageResult, kind: string): number {
  switch (kind) {
    case "input": return usage.uncached_input_tokens ?? 0;
    case "output": return usage.output_tokens ?? 0;
    case "cache_read": return usage.cache_read_input_tokens ?? 0;
    case "cache_write": return usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    default: return 0;
  }
}

/** What we bill for this model and kind, in USD per million, from the same
 *  table the charge path uses. */
function tableUsdFor(model: string, kind: string): number | null {
  const rate = claudeRateFor(model);
  if (!rate) return null;
  switch (kind) {
    case "input": return rate.in;
    case "output": return rate.out;
    case "cache_read": return rate.in * 0.1;
    case "cache_write": return rate.in * 1.25;
    default: return null;
  }
}

async function reconcileAnthropic(from: Date, to: Date, problems: string[]): Promise<RateFinding[]> {
  const key = await anthropicAdminKey();
  if (!key) {
    problems.push(
      "No Anthropic admin key. Set ANTHROPIC_ADMIN_KEY, or add one in Config → API Keys "
      + "(service: anthropic_admin_key). This is the org admin key, not the key the app generates with.",
    );
    return [];
  }

  const window = {
    starting_at: from.toISOString(),
    ending_at: to.toISOString(),
    bucket_width: "1d",
    limit: "31",
  };

  let costs: CostResult[];
  let usage: UsageResult[];
  try {
    [costs, usage] = await Promise.all([
      anthropicReport<CostResult>("/v1/organizations/cost_report", key, { ...window, "group_by[]": "description" }),
      anthropicReport<UsageResult>("/v1/organizations/usage_report/messages", key, { ...window, "group_by[]": "model" }),
    ]);
  } catch (e) {
    problems.push(`Anthropic: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  // Sum both sides across the window before dividing. A per-day rate would be
  // noisier for no gain, and the daily buckets do not line up when a request
  // spans midnight.
  const spentCents = new Map<string, number>();
  for (const row of costs) {
    if (row.cost_type && row.cost_type !== "tokens") continue;
    const kind = kindOfTokenType(row.token_type);
    if (!kind || !row.model) continue;
    if (row.currency && row.currency !== "USD") {
      problems.push(`Anthropic reported ${row.currency}, which this comparison does not convert.`);
      continue;
    }
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    const key = `${row.model}::${kind}`;
    spentCents.set(key, (spentCents.get(key) ?? 0) + amount);
  }

  const served = new Map<string, number>();
  for (const row of usage) {
    if (!row.model) continue;
    for (const kind of ["input", "output", "cache_read", "cache_write"]) {
      const tokens = tokensOfKind(row, kind);
      if (!tokens) continue;
      const key = `${row.model}::${kind}`;
      served.set(key, (served.get(key) ?? 0) + tokens);
    }
  }

  const findings: RateFinding[] = [];
  for (const [key, cents] of spentCents) {
    const [model, kind] = key.split("::");
    const tokens = served.get(key) ?? 0;
    if (tokens < MIN_TOKENS) continue;

    const actualUsd = (cents / CENTS_PER_USD) / (tokens / 1_000_000);
    const tableUsd = tableUsdFor(model, kind);
    if (tableUsd === null) {
      problems.push(`No table price for ${model}; Anthropic billed $${actualUsd.toFixed(2)} per 1M ${kind} tokens.`);
      continue;
    }
    findings.push({
      provider: "anthropic",
      model,
      kind,
      tableUsd,
      actualUsd,
      drift: tableUsd > 0 ? actualUsd / tableUsd - 1 : 0,
      units: tokens,
      unit: "per 1M tokens",
    });
  }
  return findings;
}

interface ElevenSubscription {
  tier?: string;
  character_count?: number;
  character_limit?: number;
  currency?: string;
  next_invoice?: { amount_due_cents?: number };
  current_overage?: { amount?: number; currency?: string };
}

async function reconcileElevenLabs(problems: string[]): Promise<RateFinding[]> {
  const key = (await getActiveProductKey("heclus_elevenlabs_api_key"))
    ?? process.env.HECLUS_ELEVENLABS_API_KEY?.trim()
    ?? null;
  if (!key) {
    problems.push("No ElevenLabs key, so its rate could not be checked.");
    return [];
  }

  let sub: ElevenSubscription;
  try {
    const res = await fetch(`${ELEVENLABS_BASE}/v1/user/subscription`, {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      // Their 400 for a bad credential explains itself ("API key ID used as API
      // key"), and a bare status code would send someone looking at the wrong
      // thing.
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`subscription returned ${res.status}${body ? `: ${body}` : ""}`);
    }
    sub = (await res.json()) as ElevenSubscription;
  } catch (e) {
    problems.push(`ElevenLabs: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  const chars = Number(sub.character_count ?? 0);
  const cents = Number(sub.next_invoice?.amount_due_cents ?? 0);
  if (chars < MIN_CHARS || cents <= 0) {
    problems.push(
      `ElevenLabs: nothing to divide yet (${chars.toLocaleString()} characters, `
      + `$${(cents / CENTS_PER_USD).toFixed(2)} invoiced this period).`,
    );
    return [];
  }
  if (sub.currency && sub.currency.toUpperCase() !== "USD") {
    problems.push(`ElevenLabs bills in ${sub.currency}, which this comparison does not convert.`);
    return [];
  }

  const rates = await getCreditRates();
  const actualUsd = (cents / CENTS_PER_USD) / (chars / 1_000);
  const tableUsd = rates.perThousandTtsChars * USD_PER_CREDIT;

  return [{
    provider: "elevenlabs",
    // The invoice covers every model on the plan, so this is the blended rate
    // rather than one model's price.
    model: sub.tier ? `plan: ${sub.tier}` : "all",
    kind: "characters",
    tableUsd,
    actualUsd,
    drift: tableUsd > 0 ? actualUsd / tableUsd - 1 : 0,
    units: chars,
    unit: "per 1k characters",
  }];
}

/**
 * Does PoYo's catalog still match what PoYo charges?
 *
 * A different problem from the token rates, and a smaller one, because the
 * charge is already correct: PoYo reports credits_amount on a finished task and
 * finishImageTask settles on that, so a model that quietly doubles in price
 * bills correctly without anyone editing anything.
 *
 * What goes stale is POYO_IMAGE_MODELS, which is what the wallet reserves
 * against before the task exists and what the picker prints on the model card.
 * It was already wrong on two models when this was written — nano-banana-pro
 * listed 8 and billed 18, Grok Imagine 2.0 listed 8 and billed 12 — so the
 * drift is not hypothetical.
 *
 * Median rather than mean: one 4K generation at four times the base rate should
 * not move a figure that describes the common case.
 *
 * One caveat on a zero reading. When PoYo does not report credits_amount the
 * ledger falls back to the catalog price, so those rows agree with the catalog
 * by construction and quietly drag a median toward it. A drift of exactly zero
 * on a model with few samples is therefore weaker evidence than a drift of
 * sixty percent, which is what nano-banana-2 showed the first time this ran.
 *
 * KIE has no equivalent because it has no static catalog. Its estimate() returns
 * null and the picker prices from observed ledger history, so there is nothing
 * to drift.
 */
async function reconcilePoyoCatalog(from: Date, problems: string[]): Promise<RateFinding[]> {
  const { data, error } = await supabase
    .from("project_costs")
    .select("model, units")
    .eq("provider", "poyo")
    .eq("unit_kind", "poyo_credits")
    .gte("created_at", from.toISOString())
    .limit(5000);

  if (error) {
    problems.push(`PoYo catalog: could not read project_costs (${error.message}).`);
    return [];
  }

  const byModel = new Map<string, number[]>();
  for (const row of (data ?? []) as Array<{ model: string | null; units: number | null }>) {
    const units = Number(row.units ?? 0);
    if (!row.model || !(units > 0)) continue;
    const list = byModel.get(row.model) ?? [];
    list.push(units);
    byModel.set(row.model, list);
  }

  const findings: RateFinding[] = [];
  for (const [model, samples] of byModel) {
    // Three generations is the fewest a median says anything about. Below that
    // one unusual run would look like a repricing.
    if (samples.length < MIN_GENERATIONS) continue;
    samples.sort((a, b) => a - b);
    const actual = samples[Math.floor(samples.length / 2)];

    const listed = getPoyoImageModel(model);
    if (!listed) {
      problems.push(`PoYo billed for ${model}, which is not in the catalog at all. Median ${actual} credits.`);
      continue;
    }
    findings.push({
      provider: "poyo",
      model,
      kind: "catalog",
      tableUsd: listed.credits,
      actualUsd: actual,
      drift: listed.credits > 0 ? actual / listed.credits - 1 : 0,
      units: samples.length,
      unit: "credits per image",
      measure: "credits",
    });
  }
  return findings;
}

/**
 * Compare billed rates against invoiced rates for the last `days`.
 *
 * Never throws. Everything that failed is in `problems`, because a report that
 * refuses to render when one provider is unreachable is a report nobody keeps
 * running.
 */
export async function reconcileRates(days = 30): Promise<RateReconciliation> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const problems: string[] = [];

  const [anthropic, elevenlabs, poyo, drawdown] = await Promise.all([
    reconcileAnthropic(from, to, problems),
    reconcileElevenLabs(problems),
    reconcilePoyoCatalog(new Date(to.getTime() - CATALOG_DAYS * 86_400_000), problems),
    reconcileDrawdown(days),
  ]);

  problems.push(...drawdown.problems);

  const findings = [...anthropic, ...elevenlabs, ...poyo].sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
  return {
    at: to.toISOString(),
    from: from.toISOString(),
    to: to.toISOString(),
    findings,
    drifted: findings.filter((f) => Math.abs(f.drift) >= DRIFT_THRESHOLD),
    drawdown: drawdown.findings,
    problems,
  };
}

/** Store the last run so the admin panel can show it without re-billing the
 *  two APIs on every page load. */
export async function saveReconciliation(report: RateReconciliation): Promise<void> {
  const { error } = await supabase
    .from("product_config")
    .update({ rate_reconciliation: report })
    .eq("service", "_global");
  if (error) console.warn(`[rates/reconcile] could not store the report: ${error.message}`);
}

export async function loadReconciliation(): Promise<RateReconciliation | null> {
  const { data, error } = await supabase
    .from("product_config")
    .select("rate_reconciliation")
    .eq("service", "_global")
    .maybeSingle();
  if (error) return null;
  const raw = (data as { rate_reconciliation?: unknown } | null)?.rate_reconciliation;
  return raw && typeof raw === "object" ? (raw as RateReconciliation) : null;
}
