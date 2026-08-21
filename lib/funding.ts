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
  if (WALLET_FUNDING_ADMIN_ONLY && !isAdminUser(user)) return "byo";
  return getFundingModeById(user.id);
}

/** For the call sites that only carry a user id. Does NOT apply the admin gate,
 *  which needs the user object: pass through getFundingMode where you have one. */
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

  cacheMap.set(userId, { mode, at: Date.now() });
  return mode;
}
