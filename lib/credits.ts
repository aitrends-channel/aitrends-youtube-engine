import { supabase } from "@/lib/supabase/client";
import { getQuotaConfig, capFromConfig } from "@/lib/quota-config";
import { planSlugOf } from "@/lib/plans-gating";
import { isAdminUser } from "@/lib/admin";
import { hasPaidAccess } from "@/lib/subscription";
import type { User } from "@supabase/supabase-js";
import { FREE_VIDEO_COMING_SOON } from "@/lib/free-tier-flag";

// The FREE GENAI VIDEO wallet, in TypeScript. genai_credits since migration
// 129, which handed the general names to Heclus Credits (lib/heclus-credits.ts).
// This one is whole clips and a monthly grant; that one is fractional and
// purchased-only.
//
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
 * What the top-up picker offers: one to four packs.
 *
 * Derived from CREDIT_PACK rather than written out, so the pack price stays the
 * only place a price lives. Strictly linear, with no bulk discount, because the
 * pack is sold at the provider's own price: a discount here would be sold at a
 * loss. That is also why no option is badged "best value" — none of them is.
 *
 * Bought as a quantity of one Dodo product, not four products, so the checkout
 * link an admin configures keeps working for every option.
 */
export const CREDIT_PACK_OPTIONS = [1, 2, 3, 4].map((units) => ({
  units,
  credits: CREDIT_PACK.credits * units,
  priceUsd: CREDIT_PACK.priceUsd * units,
}));

/**
 * Restrict the whole credits feature to admins.
 *
 * OFF: starter, pro and admin now have the free video lane. Who gets what is
 * decided by the allowance, not by this flag — genaipro_video_credits in
 * QUOTA_DEFAULTS carries starter 300, pro 300 and founder 0, and capFromConfig
 * resolves an admin to pro's number. A plan with no entry gets nothing, which
 * is how founder and demo stay out.
 *
 * Turning it back on is still the one-line way to withdraw the feature from
 * customers without touching allowances, and FREE_VIDEO_COMING_SOON in
 * lib/free-tier-flag.ts is the harder switch that hides it from admins too.
 *
 * Enforced in monthlyGrantFor rather than in each surface, so one flag governs
 * all of them: the Balance section on the account page, the balance panel on
 * the Generate step, the free model in the picker and in the per-beat edit
 * modal, and the top-up button. A zero allowance with no bought credit is what
 * every one of those already treats as "no wallet".
 */
export const VIDEO_CREDITS_ADMIN_ONLY = true;

/**
 * Whether anyone may buy more free-video credits.
 *
 * Separate from the lane itself, because the two questions are different: a
 * customer already holding credits should be able to spend them, and should not
 * be able to buy more of something that has not been released. One account
 * bought three packs before the lane was meant to be reachable at all.
 *
 * Closed for everyone, admins included. An admin who needs to test the purchase
 * flow can flip this for the duration rather than leaving the door open, which
 * is what let the first purchase through.
 */
export const VIDEO_CREDITS_TOPUP_OPEN = false;

/**
 * Accounts the free video lane stays open to while it is otherwise coming soon.
 *
 * The lane reached customers before it was meant to, and one of them bought
 * credits against it. Switching it off wholesale would take away something
 * already paid for, and hiding a wallet is not the same as refunding it — so
 * the switch is admins plus this list rather than admins alone.
 *
 * An allowance rather than only their bought credits, because the picker drops
 * the free model when the allowance is zero: without this they would keep a
 * balance they could no longer see a model to spend.
 *
 * Lowercased on both sides. An email that does not match here silently loses
 * access, which is the failure worth being careful about.
 */
export const VIDEO_CREDITS_ALLOWED_EMAILS = [
  "davidstamu80@gmail.com",
];

function videoCreditsAllowed(user: User): boolean {
  const email = (user.email ?? "").trim().toLowerCase();
  return !!email && VIDEO_CREDITS_ALLOWED_EMAILS.includes(email);
}

/**
 * Grant one pack per confirmed payment regardless of quantity bought.
 *
 * OFF, and it has to stay off now that the top-up picker sells quantities. With
 * it on, the 1,200-credit option takes $24 and credits 300: the picker would be
 * a way to overcharge, not a choice. purchasedQuantity() reads the cart instead,
 * so what was paid for is what lands.
 *
 * It was on while the flow was tested with small real charges, where granting a
 * full pack for $1 was a deliberate and harmless loss.
 */
export const TOPUP_GRANTS_FLAT_PACK = false;

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
  if (FREE_VIDEO_COMING_SOON) return 0;
  // videoCreditsAllowed is production's allowlist for the one customer who
  // bought before the lane was closed; hasPaidAccess is staging's guard against
  // an unpaid signup drawing the Starter allowance of clips we pay for. Both
  // sides are load-bearing, so both are kept.
  if (VIDEO_CREDITS_ADMIN_ONLY && !isAdminUser(user) && !videoCreditsAllowed(user)) return 0;
  if (!hasPaidAccess(user)) return 0;
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
  // Zeroing the allowance is not enough on its own: an account holding bought
  // credits would still render a wallet, and admins bringing GenAIPro up have
  // some. Report empty and skip ensure_monthly_grant entirely, so the flag also
  // stops issuing allowances for a period nobody can spend in.
  if (FREE_VIDEO_COMING_SOON) return { ...EMPTY, period };
  try {
    const { data, error } = await supabase.rpc("genai_credits_ensure_grant", {
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
  const { data, error } = await supabase.rpc("genai_credits_reserve", {
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
    const { data, error } = await supabase.rpc("genai_credits_settle", {
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
    const { data, error } = await supabase.rpc("genai_credits_release", {
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
  const { data, error } = await supabase.rpc("genai_credits_add", {
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

export interface CreditsUsed {
  /** Credits spent on clips during the current grant period. */
  thisMonth: number;
  /** Credits spent on clips since the account existed. */
  allTime: number;
}

/**
 * How many credits have actually been spent.
 *
 * Summed from debit rows rather than derived from the balance, because a
 * refunded clip returns its credit: balance arithmetic would report a failed
 * generation as usage. Refund rows are excluded, so this is work delivered.
 *
 * Fail-soft: this is a display figure, and reporting zero is better than
 * breaking the panel that shows the balance beside it.
 */
export async function getCreditsUsed(userId: string): Promise<CreditsUsed> {
  try {
    const { data, error } = await supabase
      .from("genai_credits_ledger")
      .select("credits, created_at")
      .eq("user_id", userId)
      .eq("kind", "debit");
    if (error) {
      console.warn("[credits] used read failed:", error.message);
      return { thisMonth: 0, allTime: 0 };
    }
    const monthStart = `${currentPeriod()}-01`;
    let thisMonth = 0, allTime = 0;
    for (const row of (data ?? []) as { credits: number; created_at: string }[]) {
      const spent = Math.abs(row.credits ?? 0);
      allTime += spent;
      if (row.created_at >= monthStart) thisMonth += spent;
    }
    return { thisMonth, allTime };
  } catch (e) {
    console.warn("[credits] used threw:", e instanceof Error ? e.message : e);
    return { thisMonth: 0, allTime: 0 };
  }
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
    .from("genai_credits_ledger")
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
    .from("genai_credits_reservations")
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
    .from("genai_credits_reservations")
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
