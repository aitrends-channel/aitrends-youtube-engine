import { supabase } from "@/lib/supabase/client";
import { isAdminUser } from "@/lib/admin";
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
 * Wallet funding is admin-only while it is brought up.
 *
 * The same shape as VIDEO_CREDITS_ADMIN_ONLY in lib/credits.ts, and for the same
 * reason: routing customer generations onto Heclus's provider keys is a spend
 * decision, and it should be one flag rather than a deploy.
 *
 * While true, every non-admin resolves to "byo" whatever their column says, so
 * an accidental early flip of a user's mode cannot start spending Heclus's
 * balance. Flipping this to false is what puts the feature in front of
 * customers.
 *
 * Back ON 2026-09-01. It was off since 2026-08-26 to open the wallet on
 * staging, where every account is ours. Promoting that to production honoured
 * account_settings.funding_mode for real customers for the first time: the
 * column defaults to 'wallet', 78 production accounts carried it, and with no
 * Heclus plan behind them their balance is zero, so every one of them was
 * refused at generation with "empty, cannot generate". Eleven were paying
 * customers on legacy Starter and Pro.
 *
 * True restores exactly what production did before that deploy, which is to
 * ignore the column and run every non-admin on their own keys. It belongs with
 * the flags in lib/rollout.ts: the wallet is part of this release and should
 * have shipped gated with the rest of it.
 */
export const WALLET_FUNDING_ADMIN_ONLY = true;

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
  // Short-circuits the admin lookup inside getFundingModeById, since the answer
  // is already here in the user object.
  if (WALLET_FUNDING_ADMIN_ONLY && !isAdminUser(user)) return "byo";
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

  if (mode === "wallet" && WALLET_FUNDING_ADMIN_ONLY && !(await isAdminById(userId))) {
    mode = "byo";
  }

  cacheMap.set(userId, { mode, at: Date.now() });
  return mode;
}

/** isAdminUser needs the user object, and the choke points only have an id.
 *  Fail-closed: an unreadable account is not an admin, so the gate holds. */
async function isAdminById(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data.user) return false;
    return isAdminUser(data.user);
  } catch {
    return false;
  }
}
