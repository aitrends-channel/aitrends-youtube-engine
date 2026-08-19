import { supabase } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

// Heclus Credits: the general wallet a user buys from us and spends on work that
// runs on Heclus's own provider accounts.
//
// Deliberately the same shape as lib/credits.ts, so a call site reads the same
// whichever wallet it draws on: reserve before the work, settle with what it
// actually cost, release if nothing was produced. What differs is underneath —
// no monthly grant, no expiry, and fractional credits, because KIE charges 1.7
// for an image prompt rather than a whole unit. See migration 129, which renamed the old wallet to genai_credits so this one could take the general names.
//
// Every balance-changing operation is a Postgres function call rather than a
// read-modify-write here, so two concurrent generations cannot both see the same
// balance and both decide they can afford it.

/** What a reservation is for. A label on the ledger row, not a separate balance:
 *  one wallet pays for all of them. */
export const HECLUS_PROVIDER_KIE = "kie";
export const HECLUS_PROVIDER_GENAIPRO = "genaipro";
export const HECLUS_PROVIDER_ANTHROPIC = "anthropic";

export interface HeclusBalance {
  /** Spendable now. */
  credits: number;
  /** Held by generations in flight. Already out of `credits`. */
  reserved: number;
}

export interface HeclusLedgerRow {
  id: string;
  kind: "topup" | "spend" | "refund" | "adjustment";
  credits: number;
  note: string | null;
  provider: string | null;
  created_at: string;
}

const EMPTY: HeclusBalance = { credits: 0, reserved: 0 };

/**
 * The user's balance.
 *
 * Fail-soft: a balance that cannot be read reports zero rather than throwing,
 * because this feeds a display. The reserve call is the one that actually
 * refuses work, and that one is not fail-soft.
 */
export async function getHeclusBalance(user: User): Promise<HeclusBalance> {
  try {
    const { data, error } = await supabase
      .from("credit_accounts")
      .select("credits, reserved")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      console.warn("[heclus-credits] balance read failed:", error.message);
      return EMPTY;
    }
    // No row simply means they have never topped up.
    const row = data as { credits?: number | string; reserved?: number | string } | null;
    return {
      credits: Number(row?.credits ?? 0),
      reserved: Number(row?.reserved ?? 0),
    };
  } catch (e) {
    console.warn("[heclus-credits] balance threw:", e instanceof Error ? e.message : e);
    return EMPTY;
  }
}

/** Recent movements, newest first, for the Balance panel and admin views. */
export async function listHeclusLedger(userId: string, limit = 50): Promise<HeclusLedgerRow[]> {
  const { data, error } = await supabase
    .from("credit_ledger")
    .select("id, kind, credits, note, provider, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[heclus-credits] ledger read failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => ({
    ...(r as HeclusLedgerRow),
    // NUMERIC arrives as a string over PostgREST, and a string here would sort
    // and format as text further up.
    credits: Number((r as { credits: number | string }).credits),
  }));
}

/**
 * Hold credit before doing the work.
 *
 * Returns null when the balance will not cover it, and that is a refusal the
 * caller must obey rather than a warning. This is the one function here that is
 * deliberately NOT fail-soft: a transient error blocks a generation, which is
 * annoying, and the alternative is generating on credit nobody has.
 */
export async function reserveHeclusCredits(opts: {
  userId: string;
  credits: number;
  provider?: string;
  projectId?: string;
  beatNumber?: number;
}): Promise<string | null> {
  if (!(opts.credits > 0)) return null;
  const { data, error } = await supabase.rpc("credits_reserve", {
    p_user: opts.userId,
    p_credits: opts.credits,
    p_provider: opts.provider ?? null,
    p_project: opts.projectId ?? null,
    p_beat: opts.beatNumber ?? null,
  });
  if (error) {
    console.warn("[heclus-credits] reserve failed:", error.message);
    return null;
  }
  return (data as string | null) ?? null;
}

/** Turn a hold into a debit for what it actually cost. Anything held and not
 *  spent goes back. */
export async function settleHeclusCredits(
  reservationId: string,
  actual?: number,
  note?: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("credits_settle", {
    p_reservation: reservationId,
    p_actual: actual ?? null,
    p_note: note ?? null,
  });
  if (error) {
    console.warn("[heclus-credits] settle failed:", error.message);
    return false;
  }
  return data === true;
}

/** Nothing was produced, so nothing is charged. */
export async function releaseHeclusCredits(reservationId: string, note?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("credits_release", {
    p_reservation: reservationId,
    p_note: note ?? null,
  });
  if (error) {
    console.warn("[heclus-credits] release failed:", error.message);
    return false;
  }
  return data === true;
}

/**
 * Credit an account, normally after a payment.
 *
 * Pass the Dodo payment id: the unique index behind it is what makes a replayed
 * webhook credit once rather than twice. A false return means "already credited",
 * which is a success from the caller's point of view.
 */
export async function addHeclusCredits(opts: {
  userId: string;
  credits: number;
  kind?: "topup" | "refund" | "adjustment";
  note?: string;
  dodoPaymentId?: string;
}): Promise<boolean> {
  const { data, error } = await supabase.rpc("credits_add", {
    p_user: opts.userId,
    p_credits: opts.credits,
    p_kind: opts.kind ?? "topup",
    p_note: opts.note ?? null,
    p_payment: opts.dodoPaymentId ?? null,
  });
  if (error) {
    console.warn("[heclus-credits] add failed:", error.message);
    return false;
  }
  return data === true;
}
