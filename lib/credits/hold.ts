import { reserveHeclusCredits, settleHeclusCredits, releaseHeclusCredits } from "@/lib/heclus-credits";
import { getFundingModeById } from "@/lib/funding";
import { supabase } from "@/lib/supabase/client";
import { roundCredits, creditsForUnits, getCreditRates } from "@/lib/pricing";
import type { CostStep } from "@/lib/costs";
import { estimateRun, estimateCharacters, estimateStepFloor, type RunEstimate } from "@/lib/credits/estimate";
import { spendableCredits } from "@/lib/heclus-charge";
import { logSystemEvent } from "@/lib/system-logger";

// Hold the credits before the work, settle on what it actually cost.
//
// The pre-flight check reads the balance and then acts, which two requests can
// do at the same moment and both conclude they are fine. `credits_reserve` is
// the same question asked atomically: it takes the row FOR UPDATE and returns
// null when the balance will not cover the hold, so a second caller contending
// for the same credits loses rather than passing.
//
// Padded, because settling is capped at the hold. credits_settle takes
// LEAST(actual, reserved) by design: a provider overrunning the hold is
// Heclus's problem rather than a surprise debit for the customer. That is the
// right call for the customer and it means a hold set exactly at the estimate
// silently under-bills whenever the estimate is low, which for KIE images it
// usually is. Holding a quarter more costs the user nothing, since the unspent
// part is returned at settle, and it stops the estimate error becoming a
// write-off.
//
// Two shapes of caller:
//
//   in-request  – reserve, do the work, settle with the reported figure. The
//                 whole life of the hold is one function.
//   deferred    – reserve at submit and settle when the webhook, poll or cron
//                 finishes the task. The reservation carries project and beat,
//                 so the finisher looks its own hold up rather than threading
//                 an id through three entry points and a database column.

/**
 * How much more than the estimate to hold.
 *
 * The quarter is for an estimate that had to guess. It buys nothing when the
 * figure is a price recorded against this exact model and resolution, which is
 * now most of them: the seed tables in lib/pricing carry every resolution both
 * vendors publish, and the ledger overrides them with what was actually
 * charged. Padding a known price only takes credits out of the balance for the
 * length of the run and hands them back at settle, which looks to the customer
 * like being charged a quarter more than the screen said.
 *
 * The small margin that remains on an exact figure is for conversion. The
 * vendor's credit is turned into ours through a rate and then rounded, so a
 * figure exact in poyo_credits can land a hair under in Heclus credits, and
 * settle caps at the hold.
 */
const PADDING = 1.25;
const PADDING_EXACT = 1.02;

export interface Hold {
  id: string;
  /** What was actually held, after padding. */
  credits: number;
}

/**
 * Take a hold for one unit of work, or null when the wallet cannot cover it.
 *
 * Null means refuse. It is not advisory, and it is not the same as "no hold
 * needed": a BYO account returns null too, which is why the caller checks the
 * funding mode through `needsHold` rather than treating null as a refusal on
 * its own.
 */
export async function takeHold(opts: {
  userId: string;
  credits: number;
  provider: string;
  projectId?: string;
  beatNumber?: number;
  /** The estimate was a price, not a guess. See PADDING_EXACT. */
  exact?: boolean;
}): Promise<Hold | null> {
  const credits = roundCredits(opts.credits * (opts.exact ? PADDING_EXACT : PADDING));
  if (!(credits > 0)) return null;
  const id = await reserveHeclusCredits({
    userId: opts.userId,
    credits,
    provider: opts.provider,
    projectId: opts.projectId,
    beatNumber: opts.beatNumber,
  });
  if (id && opts.projectId && opts.beatNumber !== undefined) {
    await releaseSupersededBeatHolds(opts.userId, opts.projectId, opts.beatNumber, id);
  }
  return id ? { id, credits } : null;
}

/**
 * Give back any earlier hold on the same beat.
 *
 * A beat is generated once at a time, so a second hold on one means the first
 * submit is not coming back: it failed, it was retried, or its task was
 * abandoned. The finisher settles by looking the hold up newest-first, which
 * closes the new one and leaves the old one open for the sweeper to find six
 * hours later. Until then the credits read as spent and the customer cannot
 * use them.
 *
 * Released after the new hold is taken, never before, so the beat is never
 * momentarily unfunded.
 */
async function releaseSupersededBeatHolds(
  userId: string,
  projectId: string,
  beatNumber: number,
  keepId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("credit_reservations")
    .select("id")
    .eq("user_id", userId)
    .eq("project_id", projectId)
    .eq("beat_number", beatNumber)
    .eq("state", "open")
    .neq("id", keepId);
  if (error || !data?.length) return;
  for (const row of data as { id: string }[]) {
    const ok = await releaseHeclusCredits(row.id, "superseded by a newer hold on the same beat");
    if (ok) {
      console.warn(
        `[credits] released a superseded hold on project=${projectId} beat=${beatNumber}. ` +
        "Its submit never reported back.",
      );
    }
  }
}

/** Whether this account's work is paid from the wallet at all. */
export async function needsHold(userId: string): Promise<boolean> {
  return (await getFundingModeById(userId)) === "wallet";
}

/**
 * Hold the estimated cost of one generation, refusing when it will not fit.
 *
 * Returns `{ hold: null, refused: false }` for the cases where there is
 * nothing to hold: a BYO account, or a model with no known rate. Only
 * `refused: true` means stop.
 */
export async function holdForRun(opts: {
  userId: string;
  provider: string;
  projectId?: string;
  beatNumber?: number;
  estimate: RunEstimate;
}): Promise<{ hold: Hold | null; refused: boolean }> {
  if (opts.estimate.total === null || opts.estimate.source === "byo") {
    return { hold: null, refused: false };
  }
  const hold = await takeHold({
    userId: opts.userId,
    credits: opts.estimate.total,
    provider: opts.provider,
    projectId: opts.projectId,
    beatNumber: opts.beatNumber,
    exact: opts.estimate.exact,
  });
  if (hold) return { hold, refused: false };

  // A refused hold is told apart from an unaffordable one.
  //
  // credits_reserve returns null for four different reasons: no account row, a
  // balance that will not cover the hold, a non-positive amount, and any error
  // the RPC itself hits. Only the second is the customer's problem, and the
  // route above cannot tell them apart, so all four came out as "Out of
  // credits, top up" — which a subscriber saw over a balance of 1,944.
  //
  // If the balance covers what we tried to hold, the refusal is ours. The work
  // proceeds unheld: it is still metered and still charged when it completes,
  // so the only thing lost is the race protection a hold gives, and losing
  // that beats refusing a customer who has the credits.
  const balance = await spendableCredits(opts.userId);
  const wanted = roundCredits(opts.estimate.total * (opts.estimate.exact ? PADDING_EXACT : PADDING));
  const covered = balance >= wanted;
  await logSystemEvent({
    level: covered ? "error" : "warn",
    source: "credits",
    message: covered
      ? `hold refused with the balance to cover it: wanted ${wanted}, balance ${balance}. Proceeding unheld.`
      : `hold refused, balance short: wanted ${wanted}, balance ${balance}.`,
    userId: opts.userId,
    projectId: opts.projectId,
    metadata: {
      wanted, balance, provider: opts.provider,
      estimate: opts.estimate.total, source: opts.estimate.source, exact: !!opts.estimate.exact,
    },
  });
  return { hold: null, refused: !covered };
}

/** Convenience for the in-request paths: estimate and hold in one step. */
export async function holdForOne(opts: {
  userId: string;
  kind: "image" | "video";
  modelId: string;
  operator: string;
  provider: string;
  resolution?: string | null;
  projectId?: string;
  beatNumber?: number;
}): Promise<{ hold: Hold | null; refused: boolean }> {
  const estimate = await estimateRun({
    userId: opts.userId,
    kind: opts.kind,
    modelId: opts.modelId,
    operator: opts.operator,
    count: 1,
    resolution: opts.resolution,
  });
  return holdForRun({ ...opts, estimate });
}

export async function settleHold(hold: Hold | null, actual: number, note: string): Promise<void> {
  if (!hold) return;
  if (actual > hold.credits) {
    console.error(
      `[credits] hold shortfall on ${note}: work cost ${actual.toFixed(2)} credits, hold was ` +
      `${hold.credits.toFixed(2)}, so Heclus absorbed ${(actual - hold.credits).toFixed(2)}. ` +
      `The estimate for this step is low.`,
    );
  }
  await settleHeclusCredits(hold.id, actual, note);
}

export async function releaseHold(hold: Hold | null, note: string): Promise<void> {
  if (!hold) return;
  await releaseHeclusCredits(hold.id, note);
}

/**
 * The open hold for a beat, for a finisher that did not take it.
 *
 * An image submitted now is finished by a webhook, a poll or a cron, none of
 * which share memory with the submit. Rather than add a column to carry the
 * id, the reservation is found by what it already records: user, project, beat
 * and open state. Newest first, because a beat regenerated twice can have more
 * than one and the one being finished is the one most recently taken.
 */
export async function findOpenHold(opts: {
  userId: string;
  projectId: string;
  beatNumber: number;
}): Promise<Hold | null> {
  const { data, error } = await supabase
    .from("credit_reservations")
    .select("id, credits")
    .eq("user_id", opts.userId)
    .eq("project_id", opts.projectId)
    .eq("beat_number", opts.beatNumber)
    .eq("state", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as { id: string; credits: number | string };
  return { id: row.id, credits: Number(row.credits) };
}

/**
 * A hold for a voiceover, priced from the characters about to be sent.
 *
 * The only step where the estimate and the charge are the same measurement, so
 * the padding matters least here. It is applied anyway: the provider counts
 * what it synthesised, which is not always what we sent.
 */
export async function holdForCharacters(opts: {
  userId: string;
  characters: number;
  model: string;
  step?: "tts" | "assemble";
  projectId?: string;
  beatNumber?: number;
}): Promise<{ hold: Hold | null; refused: boolean }> {
  if (!(await needsHold(opts.userId)) || !(opts.characters > 0)) {
    return { hold: null, refused: false };
  }
  const estimate = await estimateCharacters({
    userId: opts.userId,
    characters: opts.characters,
    model: opts.model,
    step: opts.step,
  });
  return holdForRun({
    userId: opts.userId,
    provider: "elevenlabs",
    projectId: opts.projectId,
    beatNumber: opts.beatNumber,
    estimate,
  });
}

/**
 * A hold for one Claude call, settled on the tokens it actually used.
 *
 * Token steps do not fit the pattern the other holds use. One call produces
 * four cost rows (input, output, cache read, cache write), and a reservation
 * settles once, so handing the id to the first row would close the hold and
 * leave the other three to charge again on top. The call therefore settles the
 * hold itself, with the total of all four, and the rows are logged for
 * reporting with `alreadyHeld` so the charge path leaves them alone.
 *
 * The estimate behind the hold is the step's median cost, which is the only
 * figure available before a call whose token count does not exist yet. Padding
 * matters more here than anywhere else for the same reason.
 */
export async function settleTokenHold(opts: {
  hold: Hold | null;
  model: string;
  provider: string;
  step: CostStep;
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null | undefined;
}): Promise<void> {
  if (!opts.hold) return;
  const u = opts.usage;
  if (!u) {
    await releaseHold(opts.hold, `${opts.step} reported no usage`);
    return;
  }

  const rates = await getCreditRates();
  const ctx = { step: opts.step, model: opts.model, provider: opts.provider };
  const total =
    creditsForUnits("claude_tokens_in", Number(u.input_tokens ?? 0), rates, ctx) +
    creditsForUnits("claude_tokens_out", Number(u.output_tokens ?? 0), rates, ctx) +
    creditsForUnits("claude_tokens_cache_read", Number(u.cache_read_input_tokens ?? 0), rates, ctx) +
    creditsForUnits("claude_tokens_cache_creation", Number(u.cache_creation_input_tokens ?? 0), rates, ctx);

  if (!(total > 0)) {
    await releaseHold(opts.hold, `${opts.step} used no billable tokens`);
    return;
  }
  await settleHold(opts.hold, roundCredits(total), `${opts.step} · claude tokens`);
}

/**
 * Hold a token step's typical cost before the call.
 *
 * Returns no hold when there is not enough history to price the step, which is
 * the same silence estimateStepFloor keeps: a step nobody has run cannot be
 * held against a number nobody has.
 */
export async function holdForStep(opts: {
  userId: string;
  step: CostStep;
  provider: string;
  projectId?: string;
}): Promise<{ hold: Hold | null; refused: boolean }> {
  if (!(await needsHold(opts.userId))) return { hold: null, refused: false };
  const estimate = await estimateStepFloor({ userId: opts.userId, step: opts.step });
  return holdForRun({ ...opts, estimate });
}

/**
 * One hold for a run that makes many Claude calls.
 *
 * The chunked prompt steps do not fit the one-call shape: a run fans out over
 * chunks, retries a truncated one, and may sweep the leftovers, so a hold
 * settled on the first call would close while the rest of the run was still
 * spending. This accumulates the usage every call reports and settles once,
 * when the run ends, however it ends.
 *
 * `add` is deliberately synchronous and total-only. It is called from inside
 * parallel chunk work, and anything awaited there would need a lock.
 */
export interface StepHold {
  hold: Hold | null;
  refused: boolean;
  add(usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null | undefined): void;
  finish(model: string, provider: string): Promise<void>;
}

export async function createStepHold(opts: {
  userId: string;
  step: CostStep;
  provider: string;
  projectId?: string;
}): Promise<StepHold> {
  const { hold, refused } = await holdForStep(opts);
  const total = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  return {
    hold,
    refused,
    add(usage) {
      if (!usage) return;
      total.input_tokens += Number(usage.input_tokens ?? 0);
      total.output_tokens += Number(usage.output_tokens ?? 0);
      total.cache_read_input_tokens += Number(usage.cache_read_input_tokens ?? 0);
      total.cache_creation_input_tokens += Number(usage.cache_creation_input_tokens ?? 0);
    },
    async finish(model, provider) {
      await settleTokenHold({ hold, model, provider, step: opts.step, usage: total });
    },
  };
}
