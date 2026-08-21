import { supabase } from "@/lib/supabase/client";
import type { CostUnitKind } from "@/lib/costs";

// What a provider unit costs in Heclus Credits.
//
// One Heclus credit is one KIE credit. That choice is what keeps this file
// small: the cost ledger already records kie_credits per generation, so images,
// videos and KIE-mediated Claude calls need no conversion at all, and the margin
// lives entirely in the pack price rather than in a rate table nobody can audit.
//
// The other two units are not KIE's, so they need a rate:
//
//   claude tokens   – a heclus_direct step bills Anthropic per token. Converted
//                     at a rate per million, separately for input and output,
//                     because output is several times the price.
//   elevenlabs chars – billed per character. Converted per thousand, which is
//                     the granularity a voiceover actually moves in.
//
// Rates are overridable in product_config.credit_rates (JSONB) so a provider
// price change is a settings edit rather than a deploy. The defaults below are
// the fallback, and a missing column reads as "use them".

export interface CreditRates {
  /** Credits per KIE credit. One, unless the pack is ever repriced against KIE. */
  perKieCredit: number;
  perMillionTokensIn: number;
  perMillionTokensOut: number;
  /** Cache reads and cache writes bill differently from fresh input, so they
   *  get their own rates rather than being folded into input. */
  perMillionTokensCacheRead: number;
  perMillionTokensCacheWrite: number;
  perThousandTtsChars: number;
}

// Anchored on list prices at the time of writing, converted at the same
// KIE-credit-to-dollar ratio the pack is priced on, and rounded up. Deliberately
// not exact: they are a floor under Heclus's cost, not a bill.
export const DEFAULT_CREDIT_RATES: CreditRates = {
  perKieCredit: 1,
  perMillionTokensIn: 300,
  perMillionTokensOut: 1500,
  perMillionTokensCacheRead: 30,
  perMillionTokensCacheWrite: 375,
  perThousandTtsChars: 3,
};

let cached: { rates: CreditRates; at: number } | null = null;
const TTL_MS = 60_000;

export function invalidateRatesCache() {
  cached = null;
}

export async function getCreditRates(): Promise<CreditRates> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.rates;
  let rates = DEFAULT_CREDIT_RATES;
  try {
    const { data, error } = await supabase
      .from("product_config")
      .select("credit_rates")
      .eq("service", "_global")
      .maybeSingle();
    if (!error && data) {
      const raw = (data as { credit_rates?: unknown }).credit_rates;
      if (raw && typeof raw === "object") {
        rates = { ...DEFAULT_CREDIT_RATES, ...pickNumbers(raw as Record<string, unknown>) };
      }
    }
  } catch {
    // Defaults. A rate table that cannot be read must not stop a generation, and
    // the defaults are deliberately on the safe side of Heclus's own cost.
  }
  cached = { rates, at: Date.now() };
  return rates;
}

function pickNumbers(raw: Record<string, unknown>): Partial<CreditRates> {
  const out: Partial<CreditRates> = {};
  for (const key of Object.keys(DEFAULT_CREDIT_RATES) as (keyof CreditRates)[]) {
    const n = Number(raw[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

/**
 * Credits for a metered quantity of one provider unit.
 *
 * Returns 0 for anything Heclus does not charge for, which is the free lanes:
 * genaipro_clips comes out of the separate video wallet, and supadata
 * transcripts are a flat-rate service rather than per-use spend. Returning 0
 * rather than throwing means a new unit kind added upstream is free until
 * somebody prices it, which is the failure everyone would rather have.
 */
export function creditsForUnits(unitKind: CostUnitKind, units: number, rates: CreditRates): number {
  if (!(units > 0)) return 0;
  switch (unitKind) {
    case "kie_credits":
      return units * rates.perKieCredit;
    case "claude_tokens_in":
      return (units / 1_000_000) * rates.perMillionTokensIn;
    case "claude_tokens_out":
      return (units / 1_000_000) * rates.perMillionTokensOut;
    case "claude_tokens_cache_read":
      return (units / 1_000_000) * rates.perMillionTokensCacheRead;
    case "claude_tokens_cache_creation":
      return (units / 1_000_000) * rates.perMillionTokensCacheWrite;
    case "elevenlabs_chars":
      return (units / 1_000) * rates.perThousandTtsChars;
    case "genaipro_clips":
    case "supadata_transcripts":
      return 0;
  }
}

/** Credits are stored NUMERIC(14,4), so anything finer is not money. Rounded up:
 *  a fraction of a credit that vanished on every call would add up to Heclus
 *  paying for it. */
export function roundCredits(credits: number): number {
  return Math.ceil(credits * 10_000) / 10_000;
}
