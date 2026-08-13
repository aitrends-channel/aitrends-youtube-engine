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

export function buildTopUpUrl(checkoutUrl: string, origin: string): string {
  try {
    const callback = new URL("/payment/callback", origin);
    // Third fallback after the two storages, for a private window that blocks
    // both: Dodo preserves the caller's query params on the way back.
    callback.searchParams.set("type", "credits");

    const url = new URL(checkoutUrl);
    url.searchParams.set("redirect_url", callback.toString());
    return url.toString();
  } catch {
    // A malformed configured link should still be clickable rather than dead.
    return checkoutUrl;
  }
}

/** Remembers the intent, then leaves for Dodo. */
export function startTopUp(checkoutUrl: string): void {
  try { localStorage.setItem(PENDING_CREDIT_PURCHASE_KEY, "credits"); } catch {}
  try { sessionStorage.setItem(PENDING_CREDIT_PURCHASE_KEY, "credits"); } catch {}
  window.location.href = buildTopUpUrl(checkoutUrl, window.location.origin);
}
