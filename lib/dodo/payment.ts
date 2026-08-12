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
export async function resolveDodoCredentials(): Promise<DodoCredentials | { error: string }> {
  const settings = await getPaymentSettings();
  const mode = settings.mode;

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
  const creds = await resolveDodoCredentials();
  if ("error" in creds) return { error: creds.error, status: 500 };

  let res: Response;
  try {
    res = await fetch(`${creds.baseUrl}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${creds.secretKey}` },
    });
  } catch (e) {
    return { error: `Dodo fetch failed: ${e instanceof Error ? e.message : "network error"}`, status: 502 };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { error: `Dodo API error ${res.status}: ${body.slice(0, 200)}`, status: 502 };
  }

  const result = await res.json() as Record<string, unknown>;
  if (result.status !== "succeeded") {
    return { error: `Payment not completed (status: ${String(result.status)})`, status: 400 };
  }

  const settlement = Number(result.settlement_amount ?? 0);
  const amountCents = settlement > 0
    ? settlement
    : Number(result.total_amount ?? result.amount ?? 0);

  return {
    paymentId: String(result.payment_id ?? paymentId),
    amountCents,
    currency: String(
      (settlement > 0 ? result.settlement_currency : result.currency) ?? "usd",
    ).toLowerCase(),
    createdAt: typeof result.created_at === "string" ? result.created_at : null,
    raw: result,
  };
}
