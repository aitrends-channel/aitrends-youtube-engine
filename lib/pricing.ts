import { supabase } from "@/lib/supabase/client";
import type { CostStep, CostUnitKind } from "@/lib/costs";

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
  /** Transcription, which is NOT the same product as synthesis even though both
   *  arrive as elevenlabs_chars. Priced per hour of audio upstream, so per
   *  character it is two orders of magnitude cheaper than speaking them. */
  perThousandSttChars: number;
}

/**
 * What one credit is worth in dollars.
 *
 * The single anchor every non-KIE rate below is derived from. KIE's published
 * rate: $5 buys 1,000 credits, and their per-model prices agree (Veo 3 Fast at
 * 60 credits is listed at $0.30). Large top-ups carry a 10% bonus, so the
 * effective rate is nearer $0.0045; the list price is used here because
 * over-recovering slightly is the safe direction.
 *
 * This was $0.0025 for one commit, inferred from guessed image list prices, and
 * it made every non-KIE rate half what it should be. Sanity check on any change:
 * multiply by 8 and see whether the answer is a plausible price for one
 * nano-banana image, since that model bills 8 credits.
 *
 * Not used for KIE units at all, which are one to one by definition. It exists
 * so ElevenLabs characters and Anthropic tokens can be expressed in the same
 * currency as everything else.
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
 * Returns 0 for anything Heclus does not charge for, which is the free lanes:
 * genaipro_clips comes out of the separate video wallet, and supadata
 * transcripts are a flat-rate service rather than per-use spend. Returning 0
 * rather than throwing means a new unit kind added upstream is free until
 * somebody prices it, which is the failure everyone would rather have.
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
  }
}

/** Credits are stored NUMERIC(14,4), so anything finer is not money. Rounded up:
 *  a fraction of a credit that vanished on every call would add up to Heclus
 *  paying for it. */
export function roundCredits(credits: number): number {
  return Math.ceil(credits * 10_000) / 10_000;
}
