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
async function walletEligible(user: User | null | undefined): Promise<boolean> {
  if (isAdminUser(user)) {
    // The New/Old switch decides for an admin, because being able to be billed
    // as either kind of account is the whole reason it exists. No choice made
    // is "new": an admin is on the current product by default.
    //
    // Imported lazily so this module stays usable outside a request, where
    // next/headers throws — a worker settling a charge has no switch to read.
    const { adminPlanViewFor } = await import("@/lib/admin-view-server");
    return (await adminPlanViewFor(user)) !== "old";
  }
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
  if (!(await walletEligible(user))) return "byo";
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

  // The plan decides. The column used to have to agree with it, and that AND
  // is what stopped the first subscriber on a credits plan from spending the
  // credits they had just bought: migration 131 backfilled every pre-existing
  // account to 'byo', so anyone who signed up before the new products and
  // subscribed after them was pinned to keys they do not have.
  //
  // Reading the column could only ever turn the wallet off for someone whose
  // plan sells credits, which is not a state anybody can want: a credits plan
  // has no other way to pay. It still records what the account asked for, and
  // the admin panel still shows it.
  const check = await walletEligibleById(userId);
  const mode: FundingMode = check.eligible ? "wallet" : "byo";
  if (!check.admin) cacheMap.set(userId, { mode, at: Date.now() });
  return mode;
}

/** The account's own record of the arrangement. Kept for the admin views and
 *  for the funding routes that write it; no longer a gate on the plan. */
export async function storedFundingMode(userId: string): Promise<FundingMode | null> {
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
      console.warn("[funding] stored mode read failed:", error.message);
      return null;
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
    if (!data) return null;
    const raw = (data as Record<string, unknown>).funding_mode;
    if (raw === undefined || raw === null) return null;
    return raw === "wallet" ? "wallet" : "byo";
  } catch (e) {
    console.warn("[funding] stored mode threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** walletEligible needs the user object, and the choke points only have an id.
 *  Fail-closed: an unreadable account is not on a credits plan, so the work
 *  runs on the client's own key rather than on ours. */
async function walletEligibleById(userId: string): Promise<{ eligible: boolean; admin: boolean }> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data.user) return { eligible: false, admin: false };
    return { eligible: await walletEligible(data.user), admin: isAdminUser(data.user) };
  } catch {
    return { eligible: false, admin: false };
  }
}
