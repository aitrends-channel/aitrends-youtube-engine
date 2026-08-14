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

export function buildTopUpUrl(checkoutUrl: string, origin: string, units = 1): string {
  try {
    const callback = new URL("/payment/callback", origin);
    // Third fallback after the two storages, for a private window that blocks
    // both: Dodo preserves the caller's query params on the way back.
    callback.searchParams.set("type", "credits");

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
export function startTopUp(checkoutUrl: string, units = 1): void {
  try { localStorage.setItem(PENDING_CREDIT_PURCHASE_KEY, "credits"); } catch {}
  try { sessionStorage.setItem(PENDING_CREDIT_PURCHASE_KEY, "credits"); } catch {}
  window.location.href = buildTopUpUrl(checkoutUrl, window.location.origin, units);
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
