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
 * Three wallets take money now, and none are interchangeable: "genai" grants
 * video clips from genai_credits, "heclus" grants the general Heclus Credits,
 * and "free_images" grants images on the free lane's model. Each has its own
 * product, its own checkout link and its own crediting route, so a mismatch
 * here is a customer paying for one and receiving another.
 * The marker travels with the purchase so the return page credits the one that
 * was actually bought. "credits" is the genai value for backwards compatibility
 * with links already in flight when this split landed.
 */
export type TopUpWallet = "genai" | "heclus" | "free_images";

/** The ?type on the return URL, which is how the callback knows which route to
 *  hand the payment to. Each wallet grants a different thing, so getting this
 *  wrong is a customer paying for one and receiving another. */
export function walletParam(wallet: TopUpWallet): string {
  switch (wallet) {
    case "heclus": return "heclus";
    case "free_images": return "free_images";
    default: return "credits";
  }
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

/**
 * Remembers the intent, then leaves for Dodo.
 *
 * `newTab` keeps the app open behind the checkout, which is what the Balance
 * page wants: a customer who abandons the payment comes back to the page they
 * were on rather than to a Dodo receipt with no way back. The callback still
 * works there, because the marker is written to localStorage, which is shared
 * across tabs, and carried on the return URL besides.
 */
export function startTopUp(
  checkoutUrl: string,
  units = 1,
  wallet: TopUpWallet = "genai",
  newTab = false,
): void {
  markPendingTopUp(wallet);
  const start = new URL("/payment/start", window.location.origin);
  start.searchParams.set("wallet", wallet);
  start.searchParams.set("qty", String(Math.max(1, Math.floor(units))));
  // No fallback link. Dodo asked that payment links stop being used for
  // customer payments, so a checkout that cannot be created says so and is
  // retried rather than quietly becoming a link.
  const url = start.toString();
  if (newTab) {
    // A synthetic anchor click, not window.open: under noopener the browser
    // returns null even when the tab opened fine, so the "pop-up was blocked"
    // fallback fired on a successful open and dragged the Heclus tab to the
    // checkout as well. An anchor reports nothing, which is exactly right —
    // there is no failure case to fall back from. Same approach as
    // SubscriptionModal.
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  window.location.href = url;
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
