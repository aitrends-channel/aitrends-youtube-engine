import { fetchPoyoBalance } from "@/lib/poyo/client";

// Refuse work a provider cannot pay for, before submitting it.
//
// PoYo answers an exhausted account differently depending on the endpoint. The
// media submit returns a clean 400 "Insufficient credits", which is fine. The
// Claude relay returns HTTP 200 with a text/event-stream content type and an
// empty body, which reaches the customer as "request ended without sending any
// chunks" and reaches an operator as nothing at all.
//
// Worse is the state just above zero: on 2026-08-27 nine consecutive calls in
// the minute before the balance went negative each reported one input token and
// billed 17,670 to 22,596 output tokens for text written from no prompt. That
// was never reproduced with a healthy balance, so a floor rather than a
// zero-check is the guard: the failure appears while there is still credit.

/** Below this a PoYo call is refused. One large clip settled at 75 credits on
 *  2026-08-27, so this is roughly one unit of expensive work in reserve. */
const POYO_FLOOR = 80;

const CACHE_MS = 60_000;
let cached: { balance: number; at: number } | null = null;

async function poyoBalance(): Promise<number | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.balance;
  try {
    const { balance, valid } = await fetchPoyoBalance();
    // An unreadable balance is not a refusal. Blocking every generation because
    // a balance endpoint hiccuped would be a worse outage than the one this
    // prevents.
    if (!valid || typeof balance !== "number") return null;
    cached = { balance, at: Date.now() };
    return balance;
  } catch {
    return null;
  }
}

/** Clears the cache so a top-up takes effect without waiting out the TTL. */
export function invalidateProviderBalanceCache(): void {
  cached = null;
}

export interface PreflightResult {
  ok: boolean;
  /** Customer-facing, and specific: "try again" is useless when the fix is a
   *  top-up nobody has been told about. */
  error?: string;
  balance?: number;
}

/**
 * Whether this operator can fund the next unit of work.
 *
 * Only PoYo is checked. KIE's balance is already read per call by the client,
 * and Anthropic returns a real error when it runs out rather than a plausible
 * empty answer.
 */
export async function assertProviderFunded(operator: string | null | undefined): Promise<PreflightResult> {
  if (operator !== "poyo") return { ok: true };
  const balance = await poyoBalance();
  if (balance === null) return { ok: true };
  if (balance >= POYO_FLOOR) return { ok: true, balance };
  return {
    ok: false,
    balance,
    error:
      `Generation is paused: the PoYo provider account is down to ${balance.toFixed(2)} credits. ` +
      `Top it up, or switch this surface to another provider in Admin, Config, Operators.`,
  };
}
