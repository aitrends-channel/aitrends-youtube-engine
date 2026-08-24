import { supabase } from "@/lib/supabase/client";
import { fetchKieBalance } from "@/lib/kie/client";
import { fetchPoyoBalance } from "@/lib/poyo/client";
import { getActiveProductKey } from "@/lib/claude/routing";

// Does the provider's balance fall by what we recorded spending?
//
// The monthly rate check divides an invoice by a volume, which needs a provider
// that issues invoices. KIE issues none and publishes no price list to compare
// a credit count against, so it has no check at all; PoYo has only its catalog.
// Neither would catch the failure that actually happens: a task that bills and
// whose finish we never read is charged upstream and missing from
// project_costs, so the wallet under-bills and nothing says so.
//
// This is the check that fits. It compares two numbers that come from different
// places and must agree: what the provider's account lost, and what our ledger
// says we spent.
//
// Only drops count as spend. A rise is a top-up, and treating it as negative
// consumption would let one purchase paper over a month of unrecorded charges.
// It also means the estimate is a floor: a top-up and spend inside the same
// gap between snapshots partially cancel, and the drop we see is the net. Hourly
// snapshots keep that rare, and a floor errs toward reporting less spend than
// happened, which understates a gap rather than inventing one.

export type TrackedProvider = "kie" | "poyo";

/** The unit_kind each provider's generation spend is metered in. Token rows
 *  are excluded on purpose: a provider relaying Claude bills those against a
 *  different balance, and folding them in would compare a credit account
 *  against token spend. */
const SPEND_UNIT_KIND: Record<TrackedProvider, string> = {
  kie: "kie_credits",
  poyo: "poyo_credits",
};

export interface BalanceSnapshot {
  provider: TrackedProvider;
  credits: number | null;
  /** Why the read failed, when it did. Recorded rather than thrown: one
   *  provider being unreachable must not lose the other's snapshot. */
  problem?: string;
}

/** Read both balances. Never throws. */
export async function readProviderBalances(): Promise<BalanceSnapshot[]> {
  const [kie, poyo] = await Promise.all([
    (async (): Promise<BalanceSnapshot> => {
      const key = (await getActiveProductKey("heclus_kie_api_key")) ?? process.env.KIE_API_KEY?.trim() ?? "";
      if (!key) return { provider: "kie", credits: null, problem: "no KIE key configured" };
      const credits = await fetchKieBalance(key);
      return credits === null
        ? { provider: "kie", credits: null, problem: "KIE balance read failed" }
        : { provider: "kie", credits };
    })(),
    (async (): Promise<BalanceSnapshot> => {
      const { balance, valid } = await fetchPoyoBalance();
      if (balance === null) {
        return { provider: "poyo", credits: null, problem: valid === false ? "PoYo rejected the key" : "PoYo balance read failed" };
      }
      return { provider: "poyo", credits: balance };
    })(),
  ]);
  return [kie, poyo];
}

/**
 * Take a snapshot of both balances and store it.
 *
 * The snapshots are worthless until they accumulate: the first comparison
 * cannot happen before there are two of them, and a useful one needs a window
 * with real spend in it. That is the argument for running this well before the
 * report that reads it.
 */
export async function snapshotProviderBalances(): Promise<{
  stored: number;
  problems: string[];
}> {
  const snapshots = await readProviderBalances();
  const problems = snapshots.filter((s) => s.problem).map((s) => `${s.provider}: ${s.problem}`);
  const rows = snapshots
    .filter((s) => s.credits !== null)
    .map((s) => ({ provider: s.provider, credits: s.credits as number }));

  if (rows.length === 0) return { stored: 0, problems };

  const { error } = await supabase.from("provider_balances").insert(rows);
  if (error) {
    problems.push(`could not store snapshots: ${error.message}`);
    return { stored: 0, problems };
  }
  return { stored: rows.length, problems };
}

export interface DrawdownFinding {
  provider: TrackedProvider;
  /** Credits the account lost, summed over the drops between snapshots. */
  observedSpend: number;
  /** Credits project_costs recorded for that provider over the same window. */
  recordedSpend: number;
  /** observed - recorded. Positive means spend nobody wrote down. */
  gap: number;
  /** gap / observed. The figure worth alerting on. */
  gapShare: number;
  /** Credits the account gained, which is top-ups. Reported so an unexplained
   *  rise is visible rather than silently dropped. */
  toppedUp: number;
  snapshots: number;
  from: string;
  to: string;
}

/** Below this a difference is a snapshot boundary or a task that finished
 *  between the two reads. Above it, charges are going unrecorded. */
export const DRAWDOWN_THRESHOLD = 0.05;

/** Two snapshots is the minimum for a delta and says almost nothing. Under
 *  this many the window is reported but never flagged. */
const MIN_SNAPSHOTS = 12;

/** A window whose observed spend is this small cannot support a percentage:
 *  one clip out of three is a 33 percent gap and means nothing. */
const MIN_OBSERVED_CREDITS = 50;

/**
 * Compare the account drawdown against recorded spend, per provider.
 *
 * Reads what is there and says how thin it is rather than refusing to answer,
 * because "nine snapshots so far" is the useful reply in the first week and
 * "off by 12 percent over 300 credits" is the useful reply later.
 */
export async function reconcileDrawdown(days = 30): Promise<{
  findings: DrawdownFinding[];
  problems: string[];
}> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const problems: string[] = [];
  const findings: DrawdownFinding[] = [];

  for (const provider of ["kie", "poyo"] as TrackedProvider[]) {
    const { data, error } = await supabase
      .from("provider_balances")
      .select("credits, taken_at")
      .eq("provider", provider)
      .gte("taken_at", from.toISOString())
      .order("taken_at", { ascending: true })
      .limit(5000);
    if (error) {
      problems.push(`${provider}: could not read balance snapshots (${error.message}).`);
      continue;
    }

    const snaps = (data ?? []) as Array<{ credits: number | string; taken_at: string }>;
    if (snaps.length < 2) {
      problems.push(
        `${provider}: ${snaps.length} balance snapshot${snaps.length === 1 ? "" : "s"} in the window, `
        + `so there is nothing to compare yet. The hourly cron builds this up.`,
      );
      continue;
    }

    let observedSpend = 0;
    let toppedUp = 0;
    for (let i = 1; i < snaps.length; i++) {
      const delta = Number(snaps[i].credits) - Number(snaps[i - 1].credits);
      if (delta < 0) observedSpend += -delta;
      else toppedUp += delta;
    }

    const { data: costRows, error: costErr } = await supabase
      .from("project_costs")
      .select("units")
      .eq("provider", provider)
      .eq("unit_kind", SPEND_UNIT_KIND[provider])
      .gte("created_at", snaps[0].taken_at)
      .lte("created_at", snaps[snaps.length - 1].taken_at)
      .limit(50_000);
    if (costErr) {
      problems.push(`${provider}: could not read recorded spend (${costErr.message}).`);
      continue;
    }
    const recordedSpend = (costRows ?? []).reduce((sum, r) => sum + (Number((r as { units: unknown }).units) || 0), 0);

    const gap = observedSpend - recordedSpend;
    findings.push({
      provider,
      observedSpend,
      recordedSpend,
      gap,
      gapShare: observedSpend > 0 ? gap / observedSpend : 0,
      toppedUp,
      snapshots: snaps.length,
      from: snaps[0].taken_at,
      to: snaps[snaps.length - 1].taken_at,
    });
  }

  return { findings, problems };
}

/** A finding worth an admin's attention, rather than one the window is too thin
 *  to support. Kept beside the thresholds so the report and the alert cannot
 *  disagree about what counts. */
export function drawdownIsMeaningful(f: DrawdownFinding): boolean {
  return f.snapshots >= MIN_SNAPSHOTS
    && f.observedSpend >= MIN_OBSERVED_CREDITS
    && Math.abs(f.gapShare) >= DRAWDOWN_THRESHOLD;
}

export interface CreditPrice {
  provider: string;
  credits: number;
  usdPaid: number;
  usdPerCredit: number;
  note: string | null;
  confirmedAt: string;
  /** Days since. The number that decides whether the figure is still worth
   *  trusting, given nothing else can verify it. */
  ageDays: number;
}

/** The most recent confirmation per provider. */
export async function latestCreditPrices(): Promise<CreditPrice[]> {
  const { data, error } = await supabase
    .from("provider_credit_prices")
    .select("provider, credits, usd_paid, usd_per_credit, note, confirmed_at")
    .order("confirmed_at", { ascending: false })
    .limit(200);
  if (error) return [];

  const seen = new Set<string>();
  const out: CreditPrice[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const provider = String(row.provider);
    if (seen.has(provider)) continue;
    seen.add(provider);
    const confirmedAt = String(row.confirmed_at);
    out.push({
      provider,
      credits: Number(row.credits),
      usdPaid: Number(row.usd_paid),
      usdPerCredit: Number(row.usd_per_credit),
      note: (row.note as string | null) ?? null,
      confirmedAt,
      ageDays: Math.floor((Date.now() - new Date(confirmedAt).getTime()) / 86_400_000),
    });
  }
  return out;
}

/**
 * The credits half of a price, taken from the balance rather than from memory.
 *
 * A top-up shows up as a rise between two snapshots, so the admin only has to
 * supply the dollars. Returns the largest rise in the window, which is the
 * purchase; several small rises in one window cannot be told apart and the
 * caller is expected to let the figure be edited.
 */
export async function detectLastTopUp(
  provider: TrackedProvider,
  days = 30,
): Promise<{ credits: number; at: string } | null> {
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("provider_balances")
    .select("credits, taken_at")
    .eq("provider", provider)
    .gte("taken_at", from)
    .order("taken_at", { ascending: true })
    .limit(5000);
  if (error) return null;

  const snaps = (data ?? []) as Array<{ credits: number | string; taken_at: string }>;
  let best: { credits: number; at: string } | null = null;
  for (let i = 1; i < snaps.length; i++) {
    const delta = Number(snaps[i].credits) - Number(snaps[i - 1].credits);
    if (delta > 0 && (!best || delta > best.credits)) best = { credits: delta, at: snaps[i].taken_at };
  }
  return best;
}
