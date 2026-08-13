import { getPaymentSettings } from "@/lib/plans";

// Confirming a one-time payment with Dodo.
//
// The plan-purchase route (app/api/dodo/verify) does this inline for
// subscriptions, plan carry-over, welcome mail and the founder claim. This is
// the same credential chain and the same confirmation, pulled out for callers
// that only need "did this payment actually succeed, and for how much".
//
// It is a separate module rather than a refactor of that route on purpose: that
// route is the live money path for every subscription, and a credit top-up is
// not worth the risk of restructuring it.

export interface DodoCredentials {
  secretKey: string;
  baseUrl: string;
  mode: "test" | "production";
}

/**
 * Resolve the Dodo key and base URL for the current environment.
 *
 * The lookup order mirrors the plan route exactly, because an admin who sets a
 * key on the Payment tab expects it to take effect everywhere:
 *   1. product_config, editable in admin without a redeploy
 *   2. the environment-specific env var
 *   3. the legacy single-key env var, so a bootstrap setup keeps working
 */
export async function resolveDodoCredentials(
  forceMode?: "test" | "production",
): Promise<DodoCredentials | { error: string }> {
  const settings = await getPaymentSettings();
  const mode = forceMode ?? settings.mode;

  const secretKey =
    (mode === "production" ? settings.secretKeyProduction : settings.secretKeyTest) ??
    (mode === "production" ? process.env.DODO_SECRET_KEY_PRODUCTION : process.env.DODO_SECRET_KEY_TEST) ??
    process.env.DODO_SECRET_KEY ??
    null;

  if (!secretKey) {
    return { error: `Dodo ${mode} secret key is not configured. Set it on the Payment tab.` };
  }

  const baseUrl =
    (mode === "production" ? settings.baseUrlProduction : settings.baseUrlTest) ??
    (mode === "production" ? process.env.DODO_LIVE_BASE_URL : process.env.DODO_TEST_BASE_URL) ??
    (mode === "test" ? process.env.DODO_BASE_URL : null) ??
    (mode === "production" ? "https://live.dodopayments.com" : "https://test.dodopayments.com");

  return { secretKey, baseUrl, mode };
}

export interface ConfirmedPayment {
  paymentId: string;
  /** Minor units. settlement_amount when Dodo gives one, since that is what
   *  actually landed; total_amount otherwise. */
  amountCents: number;
  currency: string;
  createdAt: string | null;
  raw: Record<string, unknown>;
}

/**
 * Ask Dodo whether a payment succeeded.
 *
 * Never trust the redirect: the browser can be replayed, edited or shared, so
 * the payment id from a return URL means nothing until Dodo confirms it. This
 * is the whole security of crediting on return rather than on a webhook.
 */
export async function confirmDodoPayment(
  paymentId: string,
): Promise<ConfirmedPayment | { error: string; status: number }> {
  const settings = await getPaymentSettings();
  // Try the deployment's own mode first, then the other one.
  //
  // Dodo's test and live modes are separate accounts, and a payment made in one
  // is invisible to the other's key: the lookup 404s. That happens for real
  // whenever a live product link is used from a non-production deployment,
  // which is exactly what the existing "production-test" plan does on purpose.
  // Falling back means a customer who genuinely paid gets their credits instead
  // of an error caused by which host they happened to be on.
  const order: ("test" | "production")[] = settings.mode === "production"
    ? ["production", "test"]
    : ["test", "production"];

  let lastError: { error: string; status: number } = {
    error: "Payment could not be found on Dodo.",
    status: 404,
  };

  for (const mode of order) {
    const creds = await resolveDodoCredentials(mode);
    if ("error" in creds) {
      lastError = { error: creds.error, status: 500 };
      continue;
    }

    let res: Response;
    try {
      res = await fetch(`${creds.baseUrl}/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: `Bearer ${creds.secretKey}` },
      });
    } catch (e) {
      lastError = {
        error: `Dodo fetch failed: ${e instanceof Error ? e.message : "network error"}`,
        status: 502,
      };
      continue;
    }

    if (res.status === 404) {
      // Not this account's payment. Try the other mode before giving up.
      lastError = { error: "Payment could not be found on Dodo.", status: 404 };
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      lastError = { error: `Dodo API error ${res.status}: ${body.slice(0, 200)}`, status: 502 };
      continue;
    }

    const result = await res.json() as Record<string, unknown>;
    if (result.status !== "succeeded") {
      // A real payment in a known state: report it rather than trying the other
      // account, where the same id cannot exist anyway.
      return { error: `Payment not completed (status: ${String(result.status)})`, status: 400 };
    }

    const settlement = Number(result.settlement_amount ?? 0);
    const amountCents = settlement > 0
      ? settlement
      : Number(result.total_amount ?? result.amount ?? 0);

    if (mode !== settings.mode) {
      console.log(`[dodo] payment ${paymentId} confirmed against ${mode} while running in ${settings.mode}`);
    }

    return {
      paymentId: String(result.payment_id ?? paymentId),
      amountCents,
      currency: String((settlement > 0 ? result.settlement_currency : result.currency) ?? "usd").toLowerCase(),
      createdAt: typeof result.created_at === "string" ? result.created_at : null,
      raw: result,
    };
  }

  return lastError;
}
