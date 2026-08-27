import { getPaymentSettings } from "@/lib/plans";
import type { PaymentMode } from "@/lib/plans";

export interface DodoCredentials {
  env: PaymentMode;
  secretKey: string;
  baseUrl: string;
}

/**
 * The Dodo key and API base for the env this deployment runs in.
 *
 * The resolution order is the one /api/dodo/verify established and
 * /api/dodo/cancel-subscription copied: DB-managed settings first, then the
 * env-specific variable, then the legacy single-env variable. Extracted here
 * when a third caller arrived, so the order is stated once. The two existing
 * callers are left as they are rather than refactored under a live billing
 * change; they resolve identically.
 */
export async function resolveDodoCredentials(
  /** Forces an env rather than using the deployment's. Only production-test
   *  needs this: it is a live-Dodo harness and must charge against production
   *  even from staging, or it verifies the test account and proves nothing
   *  about the one that takes money. */
  override?: PaymentMode,
): Promise<{ ok: true; creds: DodoCredentials } | { ok: false; error: string }> {
  const settings = await getPaymentSettings();
  const env = override ?? settings.mode;

  const secretKey =
    (env === "production" ? settings.secretKeyProduction : settings.secretKeyTest) ??
    (env === "production" ? process.env.DODO_SECRET_KEY_PRODUCTION : process.env.DODO_SECRET_KEY_TEST) ??
    process.env.DODO_SECRET_KEY ??
    null;

  const baseUrl =
    (env === "production" ? settings.baseUrlProduction : settings.baseUrlTest) ??
    (env === "production" ? process.env.DODO_LIVE_BASE_URL : process.env.DODO_TEST_BASE_URL) ??
    (env === "test" ? (process.env.DODO_BASE_URL ?? null) : null) ??
    (env === "production" ? "https://live.dodopayments.com" : "https://test.dodopayments.com");

  if (!secretKey) {
    return { ok: false, error: `Dodo ${env} secret key is not configured. Contact support.` };
  }
  return { ok: true, creds: { env, secretKey, baseUrl } };
}
