import { supabase } from "@/lib/supabase/client";
import { getQuotaConfig, capFromConfig } from "@/lib/quota-config";
import { planSlugOf } from "@/lib/plans-gating";
import { isAdminUser } from "@/lib/admin";
import type { User } from "@supabase/supabase-js";

// The credit wallet, in TypeScript. Every balance-changing operation is a
// Postgres function call (migration 125) rather than a read-modify-write here,
// because a 300-beat project fires many submits at once and JS cannot hold a
// row lock across them.
//
// One credit is one clip. That is deliberately the provider's unit rather than
// a currency: GenAIPro sells 300 generations for $6, so a credit is worth
// $0.02 of capacity and the arithmetic a customer does in their head is right.

/** What a top-up buys, and what it costs. Sold at cost: the pack price is the
 *  provider's price, so a top-up is a pass-through rather than a margin line. */
export const CREDIT_PACK = { credits: 300, priceUsd: 6 } as const;

/**
 * TESTING SHIM — grant one full pack for any confirmed payment, whatever was
 * paid and whatever quantity was bought.
 *
 * On while the flow is being tested with small real charges: a $1 payment still
 * yields 300 credits, which is $6 of GenAIPro capacity. That is a deliberate
 * loss for the sake of exercising the path end to end.
 *
 * Turn this off before real customers can buy: with it on, anyone who finds the
 * checkout link and edits the amount gets a full pack for whatever they pay.
 * The correct behaviour is already implemented behind it — purchasedQuantity()
 * reads the cart — so this is a one-line switch, not a rewrite.
 */
export const TOPUP_GRANTS_FLAT_PACK = true;

/** Provider tag written onto ledger and reservation rows. */
export const CREDIT_PROVIDER_GENAIPRO = "genaipro";

/** 'YYYY-MM'. The grant period, and the idempotency key for a monthly grant. */
export function currentPeriod(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export interface CreditBalance {
  /** Remaining monthly allowance. Expires at period end. */
  grant: number;
  /** Bought credit. Never expires. */
  paid: number;
  /** What can be spent right now. */
  total: number;
  /** Held by generations currently in flight. */
  reserved: number;
  /** The allowance this plan gets each month. 0 means not included. */
  monthlyGrant: number;
  period: string;
}

const EMPTY: CreditBalance = { grant: 0, paid: 0, total: 0, reserved: 0, monthlyGrant: 0, period: "" };

/** The monthly allowance for a user's plan. 0 for any plan the admin has not
 *  allocated, which is how Founder is excluded. */
export async function monthlyGrantFor(user: User): Promise<number> {
  const config = await getQuotaConfig();
  return capFromConfig(config, "genaipro_video_credits", planSlugOf(user), isAdminUser(user));
}

/**
 * The user's balance, with this period's allowance issued if it has not been
 * yet. Granting lazily on read means no cron has to walk every account on the
 * 1st, and a user who never logs in never gets an allowance they cannot use.
 *
 * Fail-soft on read: a balance that cannot be read reports zero, and the
 * reserve call is what actually refuses a generation.
 */
export async function getCreditBalance(user: User): Promise<CreditBalance> {
  const monthlyGrant = await monthlyGrantFor(user);
  const period = currentPeriod();
  try {
    const { data, error } = await supabase.rpc("ensure_monthly_grant", {
      p_user: user.id,
      p_credits: monthlyGrant,
      p_period: period,
    });
    if (error) {
      console.warn("[credits] ensure_monthly_grant failed:", error.message);
      return { ...EMPTY, monthlyGrant, period };
    }
    const row = (Array.isArray(data) ? data[0] : data) as {
      grant_credits?: number; paid_credits?: number; reserved_credits?: number;
    } | null;
    const grant = row?.grant_credits ?? 0;
    const paid = row?.paid_credits ?? 0;
    return { grant, paid, total: grant + paid, reserved: row?.reserved_credits ?? 0, monthlyGrant, period };
  } catch (e) {
    console.warn("[credits] balance threw:", e instanceof Error ? e.message : e);
    return { ...EMPTY, monthlyGrant, period };
  }
}

/**
 * Hold credit before submitting a generation.
 *
 * Returns null when the balance will not cover it, and that is a refusal, not
 * a warning: the caller must not submit. This is the one place in the credit
 * path that is deliberately NOT fail-soft. A transient database error here
 * blocks a render, which is annoying; the alternative is generating on credit
 * nobody has, which is a hole in the floor.
 */
export async function reserveCredits(opts: {
  userId: string;
  credits: number;
  provider?: string;
  projectId?: string | null;
  beatNumber?: number | null;
}): Promise<string | null> {
  if (opts.credits <= 0) return null;
  const { data, error } = await supabase.rpc("reserve_credits", {
    p_user: opts.userId,
    p_credits: opts.credits,
    p_provider: opts.provider ?? CREDIT_PROVIDER_GENAIPRO,
    p_project: opts.projectId ?? null,
    p_beat: opts.beatNumber ?? null,
  });
  if (error) {
    console.warn("[credits] reserve failed:", error.message);
    return null;
  }
  return typeof data === "string" && data ? data : null;
}

/** The generation delivered. Turn the hold into a debit. Fail-soft by design:
 *  a lost settle leaves a reservation open, which the sweep resolves, and it
 *  costs cents rather than a customer's render. */
export async function settleReservation(
  reservationId: string, actual?: number, note?: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("settle_reservation", {
      p_reservation: reservationId,
      p_actual: actual ?? null,
      p_note: note ?? null,
    });
    if (error) {
      console.warn("[credits] settle failed:", error.message);
      return false;
    }
    return data === true;
  } catch (e) {
    console.warn("[credits] settle threw:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** The generation failed. Put the credit back and charge nothing. Roughly a
 *  fifth of video generations fail, so this path is ordinary, not exceptional. */
export async function releaseReservation(reservationId: string, reason?: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("release_reservation", {
      p_reservation: reservationId,
      p_reason: reason ?? null,
    });
    if (error) {
      console.warn("[credits] release failed:", error.message);
      return false;
    }
    return data === true;
  } catch (e) {
    console.warn("[credits] release threw:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Credit a paid top-up, or an admin adjustment. `externalRef` carries the
 *  idempotency: the same payment id can never credit twice, so a refreshed
 *  payment-return page is harmless. Returns false when it was a duplicate. */
export async function addCredits(opts: {
  userId: string;
  credits: number;
  kind: "topup" | "adjustment";
  externalRef?: string | null;
  note?: string | null;
}): Promise<boolean> {
  const { data, error } = await supabase.rpc("add_credits", {
    p_user: opts.userId,
    p_credits: opts.credits,
    p_kind: opts.kind,
    p_external_ref: opts.externalRef ?? null,
    p_note: opts.note ?? null,
  });
  if (error) {
    console.warn("[credits] add failed:", error.message);
    return false;
  }
  return data === true;
}

export interface LedgerRow {
  id: string;
  kind: string;
  credits: number;
  bucket: string;
  note: string | null;
  created_at: string;
}

/** History for the user-facing balance panel and the admin account view. */
export async function listLedger(userId: string, limit = 50): Promise<LedgerRow[]> {
  const { data, error } = await supabase
    .from("credit_ledger")
    .select("id, kind, credits, bucket, note, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[credits] ledger read failed:", error.message);
    return [];
  }
  return (data ?? []) as LedgerRow[];
}

/** Open reservations older than this are assumed lost and are released by the
 *  sweep. Generous: a Veo clip can take minutes, and releasing a live
 *  reservation would let the same generation be paid for twice. */
export const RESERVATION_STALE_MINUTES = 60;

/** The open reservation for a beat, so a completing generation can be settled
 *  without threading a reservation id through the provider round trip. */
export async function findOpenReservation(
  projectId: string, beatNumber: number,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("credit_reservations")
    .select("id")
    .eq("project_id", projectId)
    .eq("beat_number", beatNumber)
    .eq("state", "open")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    console.warn("[credits] reservation lookup failed:", error.message);
    return null;
  }
  return (data?.[0] as { id?: string } | undefined)?.id ?? null;
}

/**
 * Release reservations whose generation never reported back.
 *
 * Without this, a submit that crashed between reserve and provider call holds
 * a customer's credit for ever. Deliberately blunt: anything open past the
 * stale window is released, because the alternative is credit that leaks and
 * never comes back, and a released reservation for a generation that somehow
 * does complete is caught by the debit that never lands.
 */
export async function sweepStaleReservations(limit = 50): Promise<number> {
  const cutoff = new Date(Date.now() - RESERVATION_STALE_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase
    .from("credit_reservations")
    .select("id")
    .eq("state", "open")
    .lt("created_at", cutoff)
    .limit(limit);
  if (error) {
    console.warn("[credits] stale sweep query failed:", error.message);
    return 0;
  }
  let released = 0;
  for (const row of (data ?? []) as { id: string }[]) {
    if (await releaseReservation(row.id, "Generation never reported back")) released++;
  }
  return released;
}
