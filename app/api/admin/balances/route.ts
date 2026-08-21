import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { isAdminUser } from "@/lib/admin";
import { getActiveProductKey } from "@/lib/claude/routing";
import { checkKie, checkElevenLabs } from "@/lib/key-check";

export const dynamic = "force-dynamic";

// Every credit balance on the platform, both wallets, one row per account.
//
// Two wallets and they are not interchangeable: Heclus Credits are bought from
// us and spent across the workflow, genai credits are whole video clips with a
// monthly allowance. Reported side by side rather than summed, because a total
// of the two would be a number in no unit at all.
//
// Only accounts that hold something. An admin looking at this wants the accounts
// with credit in them, not a list of every signup with two zeros beside it.

export interface BalanceRow {
  userId: string;
  email: string | null;
  isAdmin: boolean;
  /** Heclus Credits: spendable, and what open reservations hold. */
  credits: number;
  reserved: number;
  /** Lifetime, from the ledger, so a balance can be read against what fed it. */
  purchased: number;
  granted: number;
  spent: number;
  /** The free video wallet: this period's allowance plus bought clips. */
  clipsGrant: number;
  clipsPaid: number;
  clipsReserved: number;
  /** Whose provider keys this account runs on. A wallet-funded account with an
   *  empty balance cannot generate, which is the row worth spotting. */
  fundingMode: "byo" | "wallet";
  lastMovement: string | null;
}

/**
 * Heclus's own balance at a provider, which is what wallet-funded work actually
 * draws down. The customer wallets below are the claim on it; this is the float.
 */
export interface ProviderBalance {
  /** A key is configured on the API Keys tab. */
  configured: boolean;
  /** Null when the provider could not be reached, which is different from zero. */
  valid: boolean | null;
  /** KIE credits, or ElevenLabs characters remaining this cycle. */
  balance: number | null;
  /** Characters in the plan, ElevenLabs only. */
  limit: number | null;
  /** Why there is no number, when we know it. */
  issue: "scope" | "key_id" | null;
}

export interface BalancesResponse {
  /** What Heclus holds at the providers wallet work spends. */
  providers: { kie: ProviderBalance; elevenlabs: ProviderBalance };
  rows: BalanceRow[];
  totals: {
    accounts: number;
    credits: number;
    reserved: number;
    purchased: number;
    granted: number;
    spent: number;
    clips: number;
    walletFunded: number;
  };
  /** Set when a table could not be read, so a zero column is not mistaken for
   *  an empty wallet. */
  warnings: string[];
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const warnings: string[] = [];

  const [accountsRes, clipsRes, ledgerRes, settingsRes, usersRes, providers] = await Promise.all([
    supabase.from("credit_accounts").select("user_id, credits, reserved, updated_at"),
    supabase.from("genai_credits").select("user_id, grant_credits, paid_credits, reserved_credits"),
    supabase.from("credit_ledger").select("user_id, kind, credits, created_at"),
    // select("*") so an unapplied migration 131 reads as "no funding_mode"
    // rather than failing the whole query.
    supabase.from("account_settings").select("*"),
    supabase.auth.admin.listUsers({ perPage: 1000 }),
    heclusProviderBalances(),
  ]);

  if (accountsRes.error) warnings.push(`Heclus Credits balances unreadable: ${accountsRes.error.message}`);
  if (clipsRes.error) warnings.push(`Video credit balances unreadable: ${clipsRes.error.message}`);
  if (ledgerRes.error) warnings.push(`Credit ledger unreadable, so the lifetime columns are blank: ${ledgerRes.error.message}`);
  if (usersRes.error) warnings.push(`Account list unreadable, so rows show ids rather than emails: ${usersRes.error.message}`);

  const users = new Map(
    (usersRes.data?.users ?? []).map((u) => [u.id, u]),
  );
  const fundingByUser = new Map<string, "byo" | "wallet">();
  for (const raw of (settingsRes.data ?? []) as Record<string, unknown>[]) {
    const id = String(raw.user_id ?? "");
    if (!id) continue;
    const mode = raw.funding_mode;
    // Same three readings as lib/funding.ts: a missing column is byo, an unset
    // one is wallet. A row exists here by definition, so the no-row case does
    // not arise.
    fundingByUser.set(id, mode === undefined ? "byo" : mode === null || mode === "wallet" ? "wallet" : "byo");
  }

  // Lifetime totals per account, from the ledger rather than from the balance:
  // a balance says what is left, these say what happened.
  const lifetime = new Map<string, { purchased: number; granted: number; spent: number; last: string | null }>();
  for (const raw of (ledgerRes.data ?? []) as { user_id: string; kind: string; credits: number | string; created_at: string }[]) {
    const bucket = lifetime.get(raw.user_id) ?? { purchased: 0, granted: 0, spent: 0, last: null };
    const n = Number(raw.credits) || 0;
    if (raw.kind === "topup") bucket.purchased += n;
    else if (n > 0) bucket.granted += n;
    else bucket.spent += -n;
    if (!bucket.last || raw.created_at > bucket.last) bucket.last = raw.created_at;
    lifetime.set(raw.user_id, bucket);
  }

  const byUser = new Map<string, BalanceRow>();
  const row = (userId: string): BalanceRow => {
    const existing = byUser.get(userId);
    if (existing) return existing;
    const user = users.get(userId);
    const life = lifetime.get(userId);
    const fresh: BalanceRow = {
      userId,
      email: user?.email ?? null,
      isAdmin: isAdminUser(user),
      credits: 0, reserved: 0,
      purchased: life?.purchased ?? 0,
      granted: life?.granted ?? 0,
      spent: life?.spent ?? 0,
      clipsGrant: 0, clipsPaid: 0, clipsReserved: 0,
      fundingMode: fundingByUser.get(userId) ?? "byo",
      lastMovement: life?.last ?? null,
    };
    byUser.set(userId, fresh);
    return fresh;
  };

  for (const raw of (accountsRes.data ?? []) as { user_id: string; credits: number | string; reserved: number | string; updated_at: string }[]) {
    const r = row(raw.user_id);
    r.credits = Number(raw.credits) || 0;
    r.reserved = Number(raw.reserved) || 0;
  }
  for (const raw of (clipsRes.data ?? []) as { user_id: string; grant_credits: number; paid_credits: number; reserved_credits: number }[]) {
    const r = row(raw.user_id);
    r.clipsGrant = Number(raw.grant_credits) || 0;
    r.clipsPaid = Number(raw.paid_credits) || 0;
    r.clipsReserved = Number(raw.reserved_credits) || 0;
  }
  // An account with ledger history but no balance row still belongs here: it
  // spent everything it had, which is exactly the account somebody is looking
  // for when they open this view.
  for (const userId of lifetime.keys()) row(userId);

  const rows = [...byUser.values()]
    .filter((r) => r.credits > 0 || r.reserved > 0 || r.purchased > 0 || r.spent > 0
      || r.clipsGrant > 0 || r.clipsPaid > 0 || r.clipsReserved > 0)
    .sort((a, b) => (b.credits + b.reserved) - (a.credits + a.reserved) || b.spent - a.spent);

  const totals = rows.reduce((t, r) => ({
    accounts: t.accounts + 1,
    credits: t.credits + r.credits,
    reserved: t.reserved + r.reserved,
    purchased: t.purchased + r.purchased,
    granted: t.granted + r.granted,
    spent: t.spent + r.spent,
    clips: t.clips + r.clipsGrant + r.clipsPaid,
    walletFunded: t.walletFunded + (r.fundingMode === "wallet" ? 1 : 0),
  }), { accounts: 0, credits: 0, reserved: 0, purchased: 0, granted: 0, spent: 0, clips: 0, walletFunded: 0 });

  return NextResponse.json({ providers, rows, totals, warnings } satisfies BalancesResponse);
}

/**
 * What Heclus holds at KIE and ElevenLabs.
 *
 * The same live checks the client-facing status card uses, pointed at the
 * product keys instead of a customer's. Read here rather than left to the API
 * Keys tab because this is the view where it means something: the customer
 * wallets are a claim on these two balances, and a wallet full of credit against
 * an empty KIE account is a promise nobody can keep.
 *
 * An unreachable provider reports null rather than zero. The distinction is the
 * whole point: zero means stop generating, null means we could not ask.
 */
async function heclusProviderBalances(): Promise<BalancesResponse["providers"]> {
  const [kieKey, elKey] = await Promise.all([
    getActiveProductKey("heclus_kie_api_key"),
    getActiveProductKey("heclus_elevenlabs_api_key"),
  ]);

  const [kie, elevenlabs] = await Promise.all([
    kieKey ? checkKie(kieKey) : null,
    elKey ? checkElevenLabs(elKey) : null,
  ]);

  return {
    kie: {
      configured: !!kieKey,
      valid: kie?.valid ?? null,
      balance: kie?.credits ?? null,
      limit: null,
      issue: kie?.balanceIssue ?? null,
    },
    elevenlabs: {
      configured: !!elKey,
      valid: elevenlabs?.valid ?? null,
      balance: elevenlabs?.remaining ?? null,
      limit: elevenlabs?.limit ?? null,
      issue: elevenlabs?.balanceIssue ?? null,
    },
  };
}
