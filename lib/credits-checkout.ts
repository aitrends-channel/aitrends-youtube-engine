// Building the top-up checkout URL.
//
// Dodo leaves the customer on its own receipt page unless the caller supplies a
// redirect_url, which is why a paid top-up stranded the buyer on
// checkout.dodopayments.com/status/… and never credited anything: the page that
// confirms the payment was never reached.
//
// The return URL is set here rather than in the Dodo product for the same reason
// the plan flow does it: it has to point at whichever host the customer is
// actually on, so one product works from localhost, staging and production
// without three products or an edit between environments.

/** Marks the purchase so the callback routes it to credits, not to a plan. */
export const PENDING_CREDIT_PURCHASE_KEY = "dodo_pending_purchase";

/**
 * Which wallet a top-up is buying into.
 *
 * Two wallets take money now, and they are not interchangeable: "genai" grants
 * video clips from genai_credits, "heclus" grants the general Heclus Credits.
 * The marker travels with the purchase so the return page credits the one that
 * was actually bought. "credits" is the genai value for backwards compatibility
 * with links already in flight when this split landed.
 */
export type TopUpWallet = "genai" | "heclus";

export function walletParam(wallet: TopUpWallet): string {
  return wallet === "heclus" ? "heclus" : "credits";
}

export function buildTopUpUrl(
  checkoutUrl: string,
  origin: string,
  units = 1,
  wallet: TopUpWallet = "genai",
): string {
  try {
    const callback = new URL("/payment/callback", origin);
    // Third fallback after the two storages, for a private window that blocks
    // both: Dodo preserves the caller's query params on the way back.
    callback.searchParams.set("type", walletParam(wallet));

    const url = new URL(checkoutUrl);
    url.searchParams.set("redirect_url", callback.toString());
    // How the picker's options are bought: quantity of one product, overwriting
    // the ?quantity=1 the configured link carries. Floored and floored again at
    // one, since this ends up as money — and it is only the request. What gets
    // credited is read back from the confirmed payment, never from this.
    url.searchParams.set("quantity", String(Math.max(1, Math.floor(units))));
    return url.toString();
  } catch {
    // A malformed configured link should still be clickable rather than dead.
    return checkoutUrl;
  }
}

/** Remembers the intent, then leaves for Dodo. */
export function startTopUp(checkoutUrl: string, units = 1, wallet: TopUpWallet = "genai"): void {
  markPendingTopUp(wallet);
  window.location.href = buildTopUpUrl(checkoutUrl, window.location.origin, units, wallet);
}

/**
 * Records which wallet is being bought into, without navigating.
 *
 * Split out for the surfaces that hand the customer a link instead of driving
 * the navigation themselves (the Balance page opens checkout in a new tab). The
 * query param on the return URL is the primary signal; these two are the
 * fallbacks for a product whose own return URL drops it. localStorage is what
 * survives a new-tab checkout, since sessionStorage is per-tab.
 */
export function markPendingTopUp(wallet: TopUpWallet): void {
  const value = walletParam(wallet);
  try { localStorage.setItem(PENDING_CREDIT_PURCHASE_KEY, value); } catch {}
  try { sessionStorage.setItem(PENDING_CREDIT_PURCHASE_KEY, value); } catch {}
}

/**
 * Which checkout link to use, in priority order.
 *
 * The admin dashboard is the source of truth: a value saved on the Payment tab
 * takes effect immediately, with no redeploy and without any env var being able
 * to override it. The env vars exist only so a fresh deployment with no config
 * row yet is not dead, and the legacy unsuffixed one only for the bootstrap
 * setup that predates per-environment links.
 *
 * Pure, so the ordering is testable instead of asserted.
 */
export function pickPackLink(
  mode: "test" | "production",
  db: { test?: string | null; production?: string | null },
  env: { test?: string | null; production?: string | null; legacy?: string | null } = {},
): string | null {
  const fromDb = mode === "production" ? db.production : db.test;
  if (fromDb?.trim()) return fromDb.trim();

  const fromEnv = mode === "production" ? env.production : env.test;
  if (fromEnv?.trim()) return fromEnv.trim();

  return env.legacy?.trim() || null;
}
