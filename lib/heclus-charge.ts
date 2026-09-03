import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getFundingModeById } from "@/lib/funding";
import { getCreditRates, creditsForUnits, roundCredits } from "@/lib/pricing";
import { reserveHeclusCredits, settleHeclusCredits } from "@/lib/heclus-credits";
import type { CostEntry } from "@/lib/costs";
import { getFundingMode } from "@/lib/funding";
import type { User } from "@supabase/supabase-js";

// Spending the Heclus Credits wallet.
//
// Every provider unit the product meters already flows through logProjectCost,
// so the debit hangs off that one call rather than off ten routes. A unit kind
// that is not priced charges nothing, which is what keeps the free lanes free:
// GenAIPro clips come out of the separate video wallet, and the Qwen and ai33
// voices never reach here because they meter against their own character caps.
//
// A debit is a reserve immediately followed by a settle. There is no spend
// function in the schema, and adding one would duplicate the accounting that
// reserve/settle already gets right: the reservation is what makes the balance
// move atomically, and the settle is what writes the ledger row.

export interface ChargeResult {
  charged: number;
  /** Credits the balance could not cover. Zero on a normal charge. */
  shortfall: number;
  skipped: "byo" | "unpriced" | "held" | null;
}

const NOTHING: ChargeResult = { charged: 0, shortfall: 0, skipped: null };

/**
 * Debit the wallet for one metered cost entry.
 *
 * Fail-soft, deliberately, and this is the one place where that is a real
 * trade-off rather than an easy call. The work is already done by the time this
 * runs, so refusing here would only mean losing the record of it. What stops a
 * user generating on credit they do not have is the pre-flight check, not this.
 *
 * A shortfall is logged loudly rather than swallowed: it means the pre-flight
 * check let through more work than the balance covered, which is a bug in the
 * gate rather than in the customer's behaviour.
 */
export async function chargeForCostEntry(entry: CostEntry): Promise<ChargeResult> {
  if (!entry.userId || !(entry.units > 0)) return NOTHING;
  // Already answered for by a hold the caller settled. Charging again would
  // bill the same work twice.
  if (entry.alreadyHeld) return { ...NOTHING, skipped: "held" };

  try {
    if (await getFundingModeById(entry.userId) !== "wallet") {
      return { ...NOTHING, skipped: "byo" };
    }

    const rates = await getCreditRates();
    // Model and provider decide the token and synthesis rates, so the whole
    // entry goes in: Sonnet is not priced as Opus, and a Claude call relayed
    // through PoYo is not priced as one billed by Anthropic.
    const credits = roundCredits(creditsForUnits(entry.unitKind, entry.units, rates, {
      step: entry.step,
      model: entry.model,
      provider: entry.provider,
    }));
    if (credits <= 0) return { ...NOTHING, skipped: "unpriced" };

    // "prompts_video · beats 7-11 · 0.05 kie_credits". A separate segment, so
    // the step is still everything before the first separator, which is how
    // every reader of this note finds it.
    const covered = (entry.beatsCovered ?? []).filter((n) => Number.isFinite(n));
    const span = covered.length
      ? ` · beats ${Math.min(...covered)}-${Math.max(...covered)}`
      : "";
    const note = `${entry.step}${span} · ${entry.units.toLocaleString()} ${entry.unitKind}`;

    // Held before the work started: settle that hold rather than taking a
    // second one. Settling is capped at what was held, so an estimate that
    // came in low costs Heclus the difference instead of the customer, which
    // is the trade the schema deliberately makes.
    if (entry.reservationId) {
      const settled = await settleHeclusCredits(entry.reservationId, credits, note);
      if (settled) return { charged: Math.min(credits, credits), shortfall: 0, skipped: null };
      // The hold was already settled or released, by a retry or a sweeper.
      // Fall through and charge normally rather than losing the row.
      console.warn(`[heclus-charge] hold ${entry.reservationId} could not be settled; charging directly`);
    }

    const charged = await debit({
      userId: entry.userId,
      credits,
      provider: entry.provider,
      projectId: entry.projectId,
      beatNumber: entry.beatNumber ?? undefined,
      note,
    });

    if (charged < credits) {
      console.error(
        `[heclus-charge] shortfall for user=${entry.userId} step=${entry.step}: ` +
        `owed ${credits}, charged ${charged}. The pre-flight check let through work the balance could not cover.`,
      );
    }
    return { charged, shortfall: roundCredits(credits - charged), skipped: null };
  } catch (e) {
    console.error("[heclus-charge] threw, work was not billed:", e instanceof Error ? e.message : e);
    return NOTHING;
  }
}

/**
 * Move credits out of the wallet, or as much of them as there is.
 *
 * Charging what is available rather than nothing at all: the alternative is a
 * user whose balance ran out mid-project keeping the last few generations for
 * free, and a ledger that no longer explains the balance.
 */
async function debit(opts: {
  userId: string;
  credits: number;
  provider: string;
  projectId?: string;
  beatNumber?: number;
  note: string;
}): Promise<number> {
  const reservation = await reserveHeclusCredits({
    userId: opts.userId,
    credits: opts.credits,
    provider: opts.provider,
    projectId: opts.projectId,
    beatNumber: opts.beatNumber,
  });
  if (reservation) {
    await settleHeclusCredits(reservation, opts.credits, opts.note);
    return opts.credits;
  }

  // The full amount did not fit. Take what is there, so the ledger still
  // accounts for the work and the balance lands on zero rather than staying
  // stuck above it.
  const available = await spendableCredits(opts.userId);
  if (available <= 0) return 0;
  const partial = roundCredits(Math.min(available, opts.credits));
  const fallback = await reserveHeclusCredits({
    userId: opts.userId,
    credits: partial,
    provider: opts.provider,
    projectId: opts.projectId,
    beatNumber: opts.beatNumber,
  });
  if (!fallback) return 0;
  await settleHeclusCredits(fallback, partial, `${opts.note} (partial)`);
  return partial;
}

/** Spendable now, excluding what open reservations already hold. */
export async function spendableCredits(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("credit_accounts")
    .select("credits")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.warn("[heclus-charge] balance read failed:", error.message);
    return 0;
  }
  return Number((data as { credits?: number | string } | null)?.credits ?? 0);
}

/** The message a refusal shows. One string, so every surface refuses in the same
 *  words and friendlyError can route it to the top-up. Defined in
 *  lib/out-of-credits.ts because the modal that now shows it is a client
 *  component and cannot import this file. */
import { OUT_OF_CREDITS_MESSAGE } from "./out-of-credits";
export { OUT_OF_CREDITS_MESSAGE };

/**
 * Whether this user may start work that will be billed to the wallet.
 *
 * Called before submitting, and inside the per-item loops of the bulk steps: a
 * project is hundreds of generations, so checking once at the start would let a
 * wallet that empties on beat 12 keep spending Heclus's balance to beat 147.
 *
 * BYO users always pass. Their own key is what runs out, and their provider
 * says so in its own words.
 */
export async function canStartWalletWork(userId: string, minCredits = 1): Promise<boolean> {
  if (await getFundingModeById(userId) !== "wallet") return true;
  return (await spendableCredits(userId)) >= minCredits;
}

/**
 * The route-entry gate, in the shape the other gates use: a Response to return,
 * or null to carry on.
 *
 * Same idea as requireActiveSubscription and requireStorageHeadroom, and it sits
 * beside them in every generating route. An empty wallet is refused before any
 * provider is called, because the alternative is doing the work and then
 * discovering there was nothing to bill it to.
 */
export async function requireWalletFunds(user: User, minCredits = 1): Promise<NextResponse | null> {
  if (await getFundingMode(user) !== "wallet") return null;
  const credits = await spendableCredits(user.id);
  if (credits >= minCredits) return null;
  return NextResponse.json(
    { error: OUT_OF_CREDITS_MESSAGE, outOfCredits: true, credits },
    { status: 402 },
  );
}
