import { supabase } from "@/lib/supabase/client";
import { claudeRateFor } from "@/lib/claude/models";
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
  /**
   * What PoYo's Claude relay costs as a fraction of Anthropic's list price.
   *
   * The relay advertises $4/$20 against Anthropic's $5/$25 for Opus, so 0.8.
   * A fraction rather than its own price table because PoYo prices the relay
   * off Anthropic's list and there is no reason to maintain the same ladder
   * twice. The realised saving is smaller than the headline: PoYo adds roughly
   * 800-1000 input tokens of overhead per call (see lib/poyo/claude.ts), and
   * those extra tokens are metered like any other, so the ledger already
   * charges for them.
   */
  poyoRelayFactor: number;
  /** Per-model USD per million tokens, overriding CLAUDE_MODEL_PRICING. Lets a
   *  price change or an intro rate land as a settings edit. */
  claudeModelUsd?: Record<string, TokenUsd>;
  /** Per-model USD per thousand characters of synthesis, overriding
   *  TTS_USD_PER_THOUSAND. */
  ttsModelUsd?: Record<string, number>;
}

/**
 * What the cost row says about the work, for the rates that depend on it.
 *
 * Every field is optional and every one of them is already stored on
 * project_costs, so passing the entry through costs nothing. Omitting them all
 * reproduces the old flat-rate behaviour, which is what the admin rate card
 * wants when it quotes a headline figure with no particular call in mind.
 */
export interface UnitContext {
  step?: CostStep;
  /** The provider's model string. Decides the token and synthesis rates. */
  model?: string | null;
  /** Who billed us. The same Claude call costs less through PoYo's relay. */
  provider?: string | null;
}

/** The rate keys that are plain numbers, which is what the admin editor can
 *  render and validate. Excludes the per-model maps. */
export type NumericRateKey = {
  [K in keyof CreditRates]-?: CreditRates[K] extends number ? K : never
}[keyof CreditRates];

export interface TokenUsd {
  /** USD per million input tokens. */
  in: number;
  /** USD per million output tokens. */
  out: number;
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
 * ElevenLabs API price per 1,000 characters, by model.
 *
 * A single constant used to stand for whatever TTS_MODEL happened to be, with a
 * comment asking whoever changed the model to remember to change the price too.
 * Turbo and Flash are $0.05, Multilingual v2 and v3 are $0.10, so forgetting
 * halved the recovered cost on every voiceover. The model is on the cost row;
 * it decides.
 *
 * Not the $0.18 an earlier version carried. That figure is the Creator *plan*
 * overage rate, borrowed from app/api/admin/tts-cost-analysis, and it is 3.6x
 * the API price for the model we actually call.
 */
const TTS_USD_PER_THOUSAND: Record<string, number> = {
  eleven_turbo_v2_5: 0.05,
  eleven_flash_v2_5: 0.05,
  eleven_turbo_v2: 0.05,
  eleven_multilingual_v2: 0.10,
  eleven_v3: 0.10,
};

/** The rate the default lands on, and what an unlisted synthesis model is
 *  priced at through perThousandTtsChars. */
const ELEVENLABS_USD_PER_THOUSAND_CHARS = 0.05;

/**
 * Anthropic list prices come from lib/claude/models.ts, which already keeps
 * them for the admin cost readouts and already handles an intro rate expiring
 * on its date. A second copy here is how the two drift: one gets edited when
 * Anthropic reprices and the other quietly bills last quarter's number.
 *
 * One Opus-class figure used to price everything, which was wrong in both
 * directions the moment a step moved off the default: the ledger shows
 * claude-sonnet-5 rows billed at Opus rates, 1.7x what that work costs, beside
 * claude-opus-5 rows that happen to be right. The model is already stored on
 * every cost row, so it may as well decide the rate.
 *
 * Cache multipliers are the API's own and apply to every model: a read is a
 * tenth of input, a write is 1.25x.
 *
 * Only direct-routed steps bill in tokens. A wallet user's Claude work normally
 * routes heclus_kie and arrives as kie_credits, which needs no rate.
 */

/** What an id matching no family is priced at, through the editable flat
 *  rates below. */
const CLAUDE_FALLBACK_USD: TokenUsd = { in: 5, out: 25 };

const CLAUDE_FAMILY_USD: [prefix: string, usd: TokenUsd][] = [
  ["claude-fable",  { in: 10, out: 50 }],
  ["claude-mythos", { in: 10, out: 50 }],
  ["claude-opus",   { in: 5,  out: 25 }],
  ["claude-sonnet", { in: 3,  out: 15 }],
  ["claude-haiku",  { in: 1,  out: 5 }],
];

/** Null for an id that is not a Claude model at all, which falls back to the
 *  flat perMillionTokens* rates: those stay admin-editable and are what an
 *  unrecognised model is priced at. */
function claudeUsd(model: string | null | undefined, rates: CreditRates): TokenUsd | null {
  const id = (model ?? "").trim();
  const override = rates.claudeModelUsd?.[id];
  if (override) return override;
  // claudeRateFor applies an intro price only while it is in force, so a
  // launch rate stops being charged on its expiry date without an edit here.
  const listed = claudeRateFor(id);
  if (listed) return { in: listed.in, out: listed.out };
  const family = CLAUDE_FAMILY_USD.find(([prefix]) => id.startsWith(prefix));
  return family ? family[1] : null;
}

/**
 * What a million tokens costs us on this row, in credits.
 *
 * Provider matters as much as model. The same Opus call billed through PoYo's
 * relay costs $4/$20 rather than $5/$25, and the ledger already records which
 * one served it, so pricing both at Anthropic's list overcharged every relayed
 * call by a quarter.
 */
function tokenCredits(
  units: number,
  kind: "in" | "out" | "cacheRead" | "cacheWrite",
  rates: CreditRates,
  ctx: UnitContext,
): number {
  const factor = ctx.provider === "poyo" ? rates.poyoRelayFactor : 1;
  const usd = claudeUsd(ctx.model, rates);

  if (!usd) {
    const flat = kind === "out" ? rates.perMillionTokensOut
      : kind === "cacheRead" ? rates.perMillionTokensCacheRead
      : kind === "cacheWrite" ? rates.perMillionTokensCacheWrite
      : rates.perMillionTokensIn;
    return (units / 1_000_000) * flat * factor;
  }

  const base = kind === "out" ? usd.out : usd.in;
  const multiplier = kind === "cacheRead" ? 0.1 : kind === "cacheWrite" ? 1.25 : 1;
  return (units / 1_000_000) * ((base * factor * multiplier) / USD_PER_CREDIT);
}

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
  // The fallback for a model id that matches nothing in CLAUDE_MODEL_PRICING or its
  // families, and the only token rates an admin can edit directly. Opus-class,
  // which is what the default model has always been.
  perMillionTokensIn: perMillion(CLAUDE_FALLBACK_USD.in),
  perMillionTokensOut: perMillion(CLAUDE_FALLBACK_USD.out),
  perMillionTokensCacheRead: perMillion(CLAUDE_FALLBACK_USD.in * 0.1),
  perMillionTokensCacheWrite: perMillion(CLAUDE_FALLBACK_USD.in * 1.25),
  perThousandTtsChars: Math.ceil(ELEVENLABS_USD_PER_THOUSAND_CHARS / USD_PER_CREDIT),
  perThousandSttChars: Math.ceil(STT_USD_PER_THOUSAND_CHARS / USD_PER_CREDIT),
  // PoYo relays Claude at $4/$20 against Anthropic's $5/$25.
  poyoRelayFactor: 0.8,
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
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_CREDIT_RATES) as (keyof CreditRates)[]) {
    const n = Number(raw[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  // The two per-model maps are not numbers and are absent from the defaults, so
  // the loop above cannot carry them. Parsed key by key: a malformed entry is
  // dropped rather than allowed to price a generation as NaN.
  const claude = parseTokenUsdMap(raw.claudeModelUsd);
  if (claude) out.claudeModelUsd = claude;
  const tts = parseNumberMap(raw.ttsModelUsd);
  if (tts) out.ttsModelUsd = tts;
  return out as Partial<CreditRates>;
}

function parseTokenUsdMap(raw: unknown): Record<string, TokenUsd> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, TokenUsd> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const usdIn = Number((value as { in?: unknown }).in);
    const usdOut = Number((value as { out?: unknown }).out);
    if (!Number.isFinite(usdIn) || !Number.isFinite(usdOut)) continue;
    if (usdIn < 0 || usdOut < 0) continue;
    out[model] = { in: usdIn, out: usdOut };
  }
  return Object.keys(out).length ? out : null;
}

function parseNumberMap(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, number> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out[model] = n;
  }
  return Object.keys(out).length ? out : null;
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
/**
 * Credits per thousand ElevenLabs characters.
 *
 * Transcription and synthesis arrive as the same unit and differ by a factor of
 * twenty-five, so telling them apart is not cosmetic. The model says which:
 * Scribe is the transcription family. The assemble step stays as a fallback for
 * rows written before the model was recorded, since that step is caption
 * alignment and nothing else.
 */
function elevenlabsRate(rates: CreditRates, ctx: UnitContext): number {
  const model = (ctx.model ?? "").trim();
  if (model.startsWith("scribe") || ctx.step === "assemble") return rates.perThousandSttChars;

  const usd = rates.ttsModelUsd?.[model] ?? TTS_USD_PER_THOUSAND[model];
  return usd === undefined ? rates.perThousandTtsChars : usd / USD_PER_CREDIT;
}

export function creditsForUnits(
  unitKind: CostUnitKind,
  units: number,
  rates: CreditRates,
  ctx: UnitContext = {},
): number {
  if (!(units > 0)) return 0;
  switch (unitKind) {
    case "kie_credits":
      return units * rates.perKieCredit;
    case "poyo_credits":
      return units * rates.perPoyoCredit;
    case "claude_tokens_in":
      return tokenCredits(units, "in", rates, ctx);
    case "claude_tokens_out":
      return tokenCredits(units, "out", rates, ctx);
    case "claude_tokens_cache_read":
      return tokenCredits(units, "cacheRead", rates, ctx);
    case "claude_tokens_cache_creation":
      return tokenCredits(units, "cacheWrite", rates, ctx);
    case "elevenlabs_chars":
      return (units / 1_000) * elevenlabsRate(rates, ctx);
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
