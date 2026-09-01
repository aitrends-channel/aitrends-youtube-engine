import { supabase } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { getFundingMode } from "@/lib/funding";
import { hasPaidAccess } from "@/lib/subscription";
import { planSlugOf } from "@/lib/plans-gating";
import { tierFallbacks, tierRank, type Tier } from "@/lib/plan-tier";

// Heclus Credits: the general wallet a user buys from us and spends on work that
// runs on Heclus's own provider accounts.
//
// Deliberately the same shape as lib/credits.ts, so a call site reads the same
// whichever wallet it draws on: reserve before the work, settle with what it
// actually cost, release if nothing was produced. What differs is underneath —
// a grant per billing period rather than a monthly reset, no expiry on what is
// granted, and fractional credits, because KIE charges 1.7
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
  // The plan grant is issued here, on read, rather than by the renewal webhook.
  //
  // Lazily for three reasons: no cron has to walk every account, an account
  // that never comes back never gets an allowance it cannot use, and a renewal
  // still pays out when the webhook that announced it was missed, replayed or
  // never delivered. It also means accounts that predate the grant receive it
  // the first time they look at their balance, which is what makes this rollout
  // not need a backfill.
  await ensurePeriodGrant(user);

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

/**
 * Grant this billing period's credits, if this account should have them.
 *
 * The plans sell an allowance per period, so it is issued on subscribing and
 * again on every renewal. app_metadata.paid_at is the signal for both: the
 * verify route stamps it on purchase and the Dodo webhook refreshes it on
 * renewal, so a paid_at the account has no grant against is a period that has
 * not been paid out yet.
 *
 * Driven off that stamp rather than off the renewal webhook itself, so the
 * grant does not depend on an event firing at the right moment. The webhook
 * moves paid_at; this notices. A missed or replayed delivery costs nothing
 * either way.
 *
 * Idempotent without any new schema, two ways over. The period key
 * "grant:<user id>:<paid_at>" spends the unique index on the payment id that
 * the top-up path already relies on, and the ledger is checked for a grant
 * inside the current period first so an account that was credited under the
 * old "signup:<user id>" key is not paid twice for the period it already has.
 *
 * Only wallet-funded accounts. A BYO client spends their own provider keys, so
 * credits would sit there unusable, and getFundingMode also carries the
 * admin-only rollout gate: while that is on, nothing is granted to customers.
 *
 * Fail-soft throughout. A grant that cannot be issued must not stop the balance
 * from rendering, and the next read will try again.
 */
async function ensurePeriodGrant(user: User): Promise<void> {
  try {
    // Customers only. The grant is real provider spend and the plans sell it as
    // an allowance, so handing it to an account that has bought nothing gives
    // the product away and puts a balance in front of someone with no way to
    // use it up honestly.
    if (!hasPaidAccess(user)) return;
    if (await getFundingMode(user) !== "wallet") return;

    const meta = (user.app_metadata ?? {}) as { paid_at?: unknown };
    const paidAt = typeof meta.paid_at === "string" ? meta.paid_at : null;
    // No stamp means nothing has told us a period started. Fall back to the
    // original one-shot key so an account that predates paid_at still gets its
    // first allowance, and gets it exactly once.
    const periodKey = paidAt ? `grant:${user.id}:${paidAt}` : `signup:${user.id}`;

    if (paidAt && await hasGrantSince(user.id, paidAt)) return;

    const credits = await periodGrantCredits(user);
    if (credits <= 0) return;
    const granted = await addHeclusCredits({
      userId: user.id,
      credits,
      kind: "adjustment",
      note: `${credits} plan credits`,
      dodoPaymentId: periodKey,
    });
    if (granted) console.log(`[heclus-credits] granted ${credits} plan credits to ${user.id} (plan ${planSlugOf(user)}, period ${paidAt ?? "initial"})`);
  } catch (e) {
    console.warn("[heclus-credits] period grant failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Whether this account already has a plan grant dated inside the current
 * period.
 *
 * The check that makes the switch to per-period keys safe. An account credited
 * under the old "signup:<user id>" key has a grant row stamped at roughly its
 * paid_at, so that row sits inside the current period and this returns true
 * until a renewal moves paid_at past it. Without it, every existing wallet
 * would be paid a second time the first time its balance was read.
 *
 * Fail-soft in the direction that cannot cost money: an unreadable ledger is
 * treated as already granted, because granting twice is worse than granting
 * late, and the next read tries again.
 */
async function hasGrantSince(userId: string, periodStart: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("credit_ledger")
    .select("id")
    .eq("user_id", userId)
    .eq("kind", "adjustment")
    .gte("created_at", periodStart)
    .or(`dodo_payment_id.eq.signup:${userId},dodo_payment_id.like.grant:${userId}:%`)
    .limit(1);
  if (error) {
    console.warn("[heclus-credits] grant lookup failed:", error.message);
    return true;
  }
  return (data ?? []).length > 0;
}

/**
 * How many credits this account is granted, from config, by plan.
 *
 * Falls back to the code figures when the columns are missing, so an unapplied
 * migration 132 or 140 still grants rather than granting nothing.
 *
 * A stored value of zero is honoured as a deliberate zero. Only an absent
 * column falls back, which is the difference between "not configured" and
 * "configured to none".
 */
async function periodGrantCredits(user: User): Promise<number> {
  // The raw entitlement tier, not tierForPlan, which maps anything it does not
  // recognise to "starter". That is the right answer for a feature gate, where
  // being generous costs nothing, and the wrong one here, where the answer is
  // money: it handed Founder a 1,000-credit grant worth $5 against $3.33 of
  // revenue, because "founder" is not on the ladder.
  //
  // Fail closed instead, the same rule capFromConfig uses: a tier nobody has
  // allocated gets nothing. A plan that should have a grant carries its own
  // entry in GRANT_COLUMN.
  const tier = planSlugOf(user);
  if (tierRank(tier) < 0) return 0;
  return packCreditsForTier(tier as Tier);
}

/**
 * The credits one period on this tier is worth.
 *
 * Exported because an upgrade has to price the tier the customer is leaving as
 * well as the one they are arriving on, and the difference between the two is
 * what they are owed for the rest of the period.
 */
export async function packCreditsForTier(tier: Tier): Promise<number> {
  const fallback = GRANT_FALLBACK[tier] ?? DEFAULT_SIGNUP_GRANT_STARTER;

  // select("*"), not the three column names: PostgREST fails the whole query on
  // one unknown column, so naming heclus_signup_grant_credits_max would make
  // every tier fall back to its code figure on any database where migration 175
  // has not been applied yet, silently discarding the configured Starter and
  // Pro values. Same reasoning as the admin route, which says so too.
  const { data, error } = await supabase
    .from("product_config")
    .select("*")
    .eq("service", "_global")
    .maybeSingle();
  if (error) return fallback;

  const row = (data ?? {}) as Record<string, unknown>;
  // A tier whose own column is unset drops to the nearest tier below rather
  // than to the code default: an admin who lowered the starter grant meant to
  // lower what a new account gets, and handing a higher tier more than that
  // would be a surprise. Only when nothing on the ladder is configured does the
  // code figure apply.
  for (const below of tierFallbacks(tier)) {
    const raw = row[GRANT_COLUMN[below]];
    if (raw === undefined || raw === null) continue;
    const n = Number(raw);
    // A stored zero is a deliberate zero, not an absent value.
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return fallback;
}

/**
 * What one finished video costs on the default models is about 385 credits:
 * Grok Imagine at 4 credits a frame and 1.6 credits a second, 20 beats, plus
 * roughly 79 for the writing steps and 66 for the voiceover. These figures are
 * a finished video with room to regenerate and try a second idea, which is the
 * only thing that demonstrates the product. The launch figure of 100 bought the
 * writing steps and about five images, so it spent real money and produced
 * nothing watchable.
 *
 * Both live in product_config, so changing them is not a deploy. See migration
 * 140.
 */
const DEFAULT_SIGNUP_GRANT_STARTER = 1000;
const DEFAULT_SIGNUP_GRANT_PRO = 2000;
const DEFAULT_SIGNUP_GRANT_MAX = 6000;

/**
 * The config column each tier's grant is stored in.
 *
 * Founder is closed to new signups, so it gets no figure of its own; an
 * existing Founder account reads the Starter column like any unrecognised plan.
 * Nobody new can arrive on it, so a rule for it would be a rule about the past.
 */
const GRANT_COLUMN: Record<Tier, string> = {
  starter: "heclus_signup_grant_credits",
  pro: "heclus_signup_grant_credits_pro",
  max: "heclus_signup_grant_credits_max",
};

const GRANT_FALLBACK: Record<Tier, number> = {
  starter: DEFAULT_SIGNUP_GRANT_STARTER,
  pro: DEFAULT_SIGNUP_GRANT_PRO,
  max: DEFAULT_SIGNUP_GRANT_MAX,
};


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


/**
 * Credits refunded to this user in the last few seconds.
 *
 * For the balance chip, which flashes a refund rather than letting the number
 * quietly climb. A balance that goes up on its own is the one movement a
 * customer has no explanation for, and "held" used to be that explanation:
 * they could watch the reserve and see it come back. With the reserve no
 * longer on screen the refund has to announce itself.
 *
 * Read from the ledger rather than inferred from a rising balance, because a
 * top-up raises it too and calling that a refund would be a lie about money.
 */
export async function getRecentRefunds(
  userId: string, withinSeconds = 90,
): Promise<{ credits: number; at: string } | null> {
  const since = new Date(Date.now() - withinSeconds * 1000).toISOString();
  const { data, error } = await supabase
    .from("credit_ledger")
    .select("credits, created_at")
    .eq("user_id", userId)
    .eq("kind", "refund")
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error || !data?.length) return null;
  const rows = data as { credits: number; created_at: string }[];
  const credits = rows.reduce((sum, r) => sum + Number(r.credits || 0), 0);
  if (!(credits > 0)) return null;
  // The newest timestamp identifies this batch, so the chip can tell a second
  // refund from the same one arriving again on the next poll.
  return { credits, at: rows[0].created_at };
}
