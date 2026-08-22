import { supabase } from "@/lib/supabase/client";
import type { CostStep, CostUnitKind } from "@/lib/costs";

// What a provider unit costs in Heclus Credits.
//
// A Heclus credit is an abstract unit worth USD_PER_CREDIT. It is deliberately
// not any one provider's credit. Every provider unit converts through a rate
// below, KIE included, so adding or retiring a media provider is a rate entry
// rather than a redenomination of every balance in the system.
//
// It used to be defined as one KIE credit, which meant images and videos needed
// no conversion at all. That definition is also what made a second media
// provider impossible to add without repricing the wallet, so KIE now carries an
// explicit rate of 1 rather than an implied one. Numerically identical, which is
// the point: the peg came out and no balance moved.
//
// The units, and why each needs the rate it has:
//
//   kie credits     – KIE bills in its own credit. Rate 1 by history, not by
//                     definition; it moves if KIE reprices, or if the pack is
//                     ever anchored to something other than their list price.
//   poyo credits    – PoYo bills in its own credit, which also happens to list
//                     at $0.005. Its own rate regardless, because two vendors
//                     agreeing on a price today is not a reason to give them
//                     one number to move.
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
  /** Credits per KIE credit. One today, but a rate like any other: KIE is one
   *  media provider this wallet can pay, no longer the unit it is denominated in. */
  perKieCredit: number;
  /** Credits per PoYo credit. One today: PoYo lists at $0.005 too (z-image at
   *  2 credits for $0.010, nano-banana-pro at 8 for $0.040). Separate from
   *  perKieCredit so one vendor repricing does not move the other. */
  perPoyoCredit: number;
  perMillionTokensIn: number;
  perMillionTokensOut: number;
  /** Cache reads and cache writes bill differently from fresh input, so they
   *  get their own rates rather than being folded into input. */
  perMillionTokensCacheRead: number;
  perMillionTokensCacheWrite: number;
  perThousandTtsChars: number;
  /** Transcription, which is NOT the same product as synthesis even though both
   *  arrive as elevenlabs_chars. Priced per hour of audio upstream, so per
   *  character it is two orders of magnitude cheaper than speaking them. */
  perThousandSttChars: number;
}

/**
 * What one credit is worth in dollars.
 *
 * The single anchor every rate below is derived from, KIE's now included. The
 * figure came from KIE's published rate: $5 buys 1,000 credits, and their
 * per-model prices agree (Veo 3 Fast at 60 credits is listed at $0.30). Large
 * top-ups carry a 10% bonus, so the effective rate is nearer $0.0045; the list
 * price is used here because over-recovering slightly is the safe direction.
 *
 * Where the number came from is history rather than a definition. The credit is
 * worth this many dollars because that is what makes perKieCredit come out at 1
 * and leaves every existing balance untouched. It does not track KIE from here:
 * if KIE reprices, perKieCredit moves and this constant does not.
 *
 * This was $0.0025 for one commit, inferred from guessed image list prices, and
 * it made every non-KIE rate half what it should be. Sanity check on any change:
 * multiply by 8 and see whether the answer is a plausible price for one
 * nano-banana image, since that model bills 8 credits.
 */
export const USD_PER_CREDIT = 0.005;

/**
 * ElevenLabs API price for the model we actually call, eleven_turbo_v2_5, which
 * sits on their Flash/Turbo tier at $0.05 per 1,000 characters.
 *
 * Not the $0.18 this used to carry. That figure is the Creator *plan* overage
 * rate, borrowed from app/api/admin/tts-cost-analysis, and it is 3.6x the API
 * price for this model. Switching to v2 Multilingual or v3 doubles it to $0.10,
 * so this constant moves with TTS_MODEL in lib/kie/tts.ts.
 */
const ELEVENLABS_USD_PER_THOUSAND_CHARS = 0.05;

/**
 * Anthropic list prices per million tokens for the default model, which is
 * Opus-class (product_config.default_claude_model, currently claude-opus-4-7).
 * Cache multipliers are the API's own: a read is a tenth of input, a write is
 * 1.25x.
 *
 * Only heclus_direct steps bill in tokens. A wallet user's Claude work normally
 * routes heclus_kie and arrives as kie_credits, which needs no rate.
 */
const CLAUDE_USD_PER_MILLION_IN = 5;
const CLAUDE_USD_PER_MILLION_OUT = 25;

/**
 * Transcription, for caption alignment. Scribe v2 is billed by the hour of audio
 * rather than by the character, $0.22, so it converts through a speech-rate
 * assumption: about 900 characters a minute, 54,000 an hour.
 *
 * Worth keeping separate rather than reusing the synthesis rate. Speaking a
 * thousand characters costs $0.05; transcribing a thousand costs about four
 * tenths of a cent, and charging the one for the other would bill a customer
 * more than ten times what the caption pass costs. Both arrive as
 * elevenlabs_chars, which is exactly why the step has to disambiguate them.
 */
const STT_USD_PER_THOUSAND_CHARS = 0.22 / 54;

const perMillion = (usd: number) => Math.ceil(usd / USD_PER_CREDIT);

// Derived, not typed in. Two versions of this file carried hand-written or
// mis-anchored numbers before the rate was looked up: the mistake can only be
// made once now, in USD_PER_CREDIT, where it is visible and sourced.
export const DEFAULT_CREDIT_RATES: CreditRates = {
  perKieCredit: 1,
  perPoyoCredit: 1,
  perMillionTokensIn: perMillion(CLAUDE_USD_PER_MILLION_IN),
  perMillionTokensOut: perMillion(CLAUDE_USD_PER_MILLION_OUT),
  perMillionTokensCacheRead: perMillion(CLAUDE_USD_PER_MILLION_IN * 0.1),
  perMillionTokensCacheWrite: perMillion(CLAUDE_USD_PER_MILLION_IN * 1.25),
  perThousandTtsChars: Math.ceil(ELEVENLABS_USD_PER_THOUSAND_CHARS / USD_PER_CREDIT),
  perThousandSttChars: Math.ceil(STT_USD_PER_THOUSAND_CHARS / USD_PER_CREDIT),
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
 * Returns 0 for the free lanes, and only for them: genaipro_clips comes out of
 * the separate video wallet, and supadata transcripts are a flat-rate service
 * rather than per-use spend. Both are listed explicitly, so a new unit kind
 * cannot join them by accident.
 *
 * Anything else must have a rate. Strict mode already refused to compile an
 * unhandled unit kind, but it refused with "function lacks ending return
 * statement" pointing at the signature, which is a poor description of the
 * actual mistake. The `never` names it at the line that is wrong.
 *
 * The throw is for the case types cannot cover: a unit kind read back from the
 * database rather than written as a literal. No caller does that today, and the
 * one likely to start is a per-operator cost breakdown grouping on
 * project_costs.unit_kind. Failing loudly beats NaN credits, which would neither
 * refuse the work nor bill for it.
 */
export function creditsForUnits(
  unitKind: CostUnitKind,
  units: number,
  rates: CreditRates,
  step?: CostStep,
): number {
  if (!(units > 0)) return 0;
  switch (unitKind) {
    case "kie_credits":
      return units * rates.perKieCredit;
    case "poyo_credits":
      return units * rates.perPoyoCredit;
    case "claude_tokens_in":
      return (units / 1_000_000) * rates.perMillionTokensIn;
    case "claude_tokens_out":
      return (units / 1_000_000) * rates.perMillionTokensOut;
    case "claude_tokens_cache_read":
      return (units / 1_000_000) * rates.perMillionTokensCacheRead;
    case "claude_tokens_cache_creation":
      return (units / 1_000_000) * rates.perMillionTokensCacheWrite;
    case "elevenlabs_chars":
      // The assemble step is transcription, every other step is synthesis. Same
      // unit, different product, and a factor of twenty-five between them.
      return (units / 1_000) * (step === "assemble" ? rates.perThousandSttChars : rates.perThousandTtsChars);
    case "genaipro_clips":
    case "supadata_transcripts":
      return 0;
    default:
      return assertPriced(unitKind);
  }
}

/** Unreachable while every unit kind is either priced above or listed as free.
 *  Typed as never so adding a unit kind without doing one of those fails the
 *  build; throws at runtime so a hand-written unit kind cannot bill NaN. */
function assertPriced(unitKind: never): never {
  throw new Error(`No credit rate for unit kind: ${String(unitKind)}`);
}

/** Credits are stored NUMERIC(14,4), so anything finer is not money. Rounded up:
 *  a fraction of a credit that vanished on every call would add up to Heclus
 *  paying for it. */
export function roundCredits(credits: number): number {
  return Math.ceil(credits * 10_000) / 10_000;
}
