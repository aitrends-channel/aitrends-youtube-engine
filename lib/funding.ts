import { supabase } from "@/lib/supabase/client";
import { isAdminUser } from "@/lib/admin";
import { billingPlanOf } from "@/lib/plans-gating";
import { isHeclusCreditsPlan } from "@/lib/plan-tier";
import type { User } from "@supabase/supabase-js";

// Whose provider account pays for a user's generations.
//
// "byo" is the original arrangement: the client supplies a KIE key and an
// ElevenLabs key, and their own balances are spent. "wallet" runs the same work
// on Heclus's keys and meters it against the Heclus Credits wallet, so a new
// signup can make a video without connecting anything.
//
// Read here rather than from getSettings so the key-resolution choke points can
// ask the question without pulling in the whole settings row, and so the
// admin-only rollout gate lives in exactly one place.

export type FundingMode = "byo" | "wallet";

/**
 * Who the wallet is for: whoever bought a plan that sells credits.
 *
 * This was a blanket admin-only flag, and the reason it existed is the reason
 * it could not simply be flipped. account_settings.funding_mode defaults to
 * 'wallet', so 78 production accounts carried it while having no Heclus plan
 * behind them and therefore no balance — turning the flag off pointed every one
 * of them at a wallet holding nothing, and eleven were paying customers on
 * legacy Starter and Pro. That is what happened on 2026-09-01 and why it went
 * back on.
 *
 * The plan is the safer question, and the truer one. An account on
 * heclus_starter, heclus_pro or heclus_max bought credits, so it spends them; a
 * legacy Starter, a Founder or a signup with no plan keeps its own keys, which
 * is the arrangement it was sold. New subscriptions land on the new products,
 * so they get the wallet from their first generation with nothing to switch on.
 *
 * Admins stay on the wallet whatever they are on: it is how the release gets
 * exercised with real money.
 */
function walletEligible(user: User | null | undefined): boolean {
  if (isAdminUser(user)) return true;
  return isHeclusCreditsPlan(billingPlanOf(user));
}

const cacheMap = new Map<string, { mode: FundingMode; at: number }>();
const TTL_MS = 60_000;

export function invalidateFundingCache(userId: string) {
  cacheMap.delete(userId);
}

/**
 * The mode that actually applies to this user's calls.
 *
 * Fail-soft to "byo": on an unreadable row, or an unapplied migration 131, the
 * safe answer is the arrangement that spends the client's own key rather than
 * Heclus's. Being wrong the other way would generate on credit nobody has.
 */
export async function getFundingMode(user: User): Promise<FundingMode> {
  // Short-circuits the lookup inside getFundingModeById, since the plan and the
  // admin flag are both already here in the user object.
  if (!walletEligible(user)) return "byo";
  return getFundingModeById(user.id);
}

/**
 * Same answer, for the call sites that only carry a user id.
 *
 * The choke points are all in this position, and they are the ones that actually
 * move money, so this applies the admin gate too rather than trusting callers to
 * remember. It costs an admin lookup, cached with the mode: skipping it meant a
 * new signup, whose column defaults to wallet, ran their generations on Heclus's
 * keys while every gate and surface still treated them as BYO. The flag has to
 * mean the same thing everywhere or it is not a flag.
 */
export async function getFundingModeById(userId: string): Promise<FundingMode> {
  const cached = cacheMap.get(userId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.mode;

  let mode: FundingMode = "byo";
  try {
    // select("*") for the same reason getSettings does it: PostgREST fails the
    // whole query on one unknown column, and naming funding_mode before
    // migration 131 is applied would make every user unreadable here.
    const { data, error } = await supabase
      .from("account_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error && error.code !== "PGRST116") {
      console.warn("[funding] read failed, defaulting to byo:", error.message);
      return "byo";
    }
    // Three states, and the difference matters:
    //
    //   no row at all      → a brand-new account that has saved nothing. Wallet:
    //                        having nothing to connect is the whole point.
    //   column missing     → migration 131 is not applied here. Byo, because
    //                        flipping every account onto Heclus's keys on the
    //                        strength of an absent column would be the worst
    //                        possible reading. `undefined` is what PostgREST
    //                        gives for a column that does not exist.
    //   column null        → the row predates the column being written. Wallet,
    //                        matching the DB default for new rows; the migration
    //                        backfilled every pre-existing account to 'byo'
    //                        explicitly so none of them land here.
    if (!data) {
      mode = "wallet";
    } else {
      const raw = (data as Record<string, unknown>).funding_mode;
      if (raw === undefined) mode = "byo";
      else if (raw === null || raw === "wallet") mode = "wallet";
      else mode = "byo";
    }
  } catch (e) {
    console.warn("[funding] read threw, defaulting to byo:", e instanceof Error ? e.message : e);
    return "byo";
  }

  // The column says what the account asked for; the plan says what it bought.
  // Both have to agree before Heclus's keys pay for anything.
  if (mode === "wallet" && !(await walletEligibleById(userId))) {
    mode = "byo";
  }

  cacheMap.set(userId, { mode, at: Date.now() });
  return mode;
}

/** walletEligible needs the user object, and the choke points only have an id.
 *  Fail-closed: an unreadable account is not on a credits plan, so the work
 *  runs on the client's own key rather than on ours. */
async function walletEligibleById(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data.user) return false;
    return walletEligible(data.user);
  } catch {
    return false;
  }
}
