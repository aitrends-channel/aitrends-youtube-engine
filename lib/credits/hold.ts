import { reserveHeclusCredits, settleHeclusCredits, releaseHeclusCredits } from "@/lib/heclus-credits";
import { getFundingModeById } from "@/lib/funding";
import { supabase } from "@/lib/supabase/client";
import { roundCredits } from "@/lib/pricing";
import { estimateRun, type RunEstimate } from "@/lib/credits/estimate";

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

/** How much more than the estimate to hold. See the note above. */
const PADDING = 1.25;

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
}): Promise<Hold | null> {
  const credits = roundCredits(opts.credits * PADDING);
  if (!(credits > 0)) return null;
  const id = await reserveHeclusCredits({
    userId: opts.userId,
    credits,
    provider: opts.provider,
    projectId: opts.projectId,
    beatNumber: opts.beatNumber,
  });
  return id ? { id, credits } : null;
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
  });
  return { hold, refused: hold === null };
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
