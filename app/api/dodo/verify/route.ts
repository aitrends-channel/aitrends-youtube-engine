import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { getPaymentSettings } from "@/lib/plans";

export async function POST(request: Request) {
  let user;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await request.json().catch(() => ({}));
  const { payment_id, plan } = body as { payment_id?: string; plan?: string };

  if (!payment_id) {
    return NextResponse.json({ error: "Missing payment_id" }, { status: 400 });
  }

  // Pick the Dodo environment for this payment:
  //   • production-test is always production — that plan's whole
  //     purpose is to fire a real live charge from any deployment
  //     (including staging), so the verify endpoint also has to
  //     query the live Dodo API regardless of HECLUS_ENV. Using the
  //     deployment env here would 404 when the payment is on live
  //     but the deployment is in test mode.
  //   • everything else follows the deployment env (HECLUS_ENV →
  //     getEffectivePaymentMode), so local + staging always verify
  //     against test and live prod always verifies against production
  // Then the secret key + base URL fall through this lookup chain:
  //   1. admin-managed product_config (set via the "Dodo Variables"
  //      card on the Payment tab — takes effect without a redeploy)
  //   2. environment-specific env var
  //   3. legacy DODO_SECRET_KEY / DODO_BASE_URL fallback so a one-
  //      key bootstrap setup keeps working
  const settings = await getPaymentSettings();
  const env: "test" | "production" = plan === "production-test" ? "production" : settings.mode;

  // Track which source (DB row / env-specific var / legacy var)
  // each value resolved from so the diagnostic log below can answer
  // "is verify ignoring my admin-saved value?" in one read.
  const pickSecret = () => {
    const dbVal = env === "production" ? settings.secretKeyProduction : settings.secretKeyTest;
    if (dbVal) return { value: dbVal, source: "db" as const };
    const envVal = env === "production" ? process.env.DODO_SECRET_KEY_PRODUCTION : process.env.DODO_SECRET_KEY_TEST;
    if (envVal) return { value: envVal, source: "env-specific" as const };
    if (process.env.DODO_SECRET_KEY) return { value: process.env.DODO_SECRET_KEY, source: "legacy-env" as const };
    return { value: null, source: "none" as const };
  };
  const pickBase = () => {
    const dbVal = env === "production" ? settings.baseUrlProduction : settings.baseUrlTest;
    if (dbVal) return { value: dbVal, source: "db" as const };
    const envSpecific = env === "production" ? process.env.DODO_LIVE_BASE_URL : process.env.DODO_TEST_BASE_URL;
    if (envSpecific) return { value: envSpecific, source: "env-specific" as const };
    if (env === "test" && process.env.DODO_BASE_URL) return { value: process.env.DODO_BASE_URL, source: "legacy-env" as const };
    return {
      value: env === "production" ? "https://live.dodopayments.com" : "https://test.dodopayments.com",
      source: "default" as const,
    };
  };

  const keyPick = pickSecret();
  const basePick = pickBase();
  if (!keyPick.value) {
    return NextResponse.json(
      { error: `Dodo ${env} secret key is not configured. Set it on the Payment tab.` },
      { status: 500 },
    );
  }
  const secretKey = keyPick.value;
  const dodoBase = basePick.value;

  // Surface where each value came from so a 404 from Dodo or a
  // wrong-env mismatch can be diagnosed in one log line. Key prefix
  // only — never the full secret.
  console.log(
    `[dodo-verify] plan=${plan} env=${env} ` +
    `base=${dodoBase} base_src=${basePick.source} ` +
    `key=${secretKey.slice(0, 8)}… key_src=${keyPick.source} ` +
    `payment_id=${payment_id}`,
  );

  let dodoRes: Response;
  try {
    dodoRes = await fetch(`${dodoBase}/payments/${payment_id}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
  } catch (e) {
    return NextResponse.json({ error: `Dodo fetch failed: ${(e as Error).message}` }, { status: 502 });
  }

  if (!dodoRes.ok) {
    const body = await dodoRes.text().catch(() => "");
    return NextResponse.json({ error: `Dodo API error ${dodoRes.status}: ${body}` }, { status: 502 });
  }

  const result = await dodoRes.json();

  if (result.status !== "succeeded") {
    return NextResponse.json({ error: `Payment not successful (status: ${result.status})` }, { status: 400 });
  }

  // Cross-check the paid amount against the claimed plan's price.
  // Dodo reports amounts in the smallest currency unit (cents).
  // Configurable via env so prices can change without redeploy.
  //
  // Skip the guard entirely in test mode: Dodo's test SKUs use
  // arbitrary low amounts (often $0.50 or $1) intentionally so QA
  // doesn't have to spend $40 to verify the founder flow. The price
  // guard exists to catch fraud against the LIVE prices in
  // production — applying it to test charges blocks every legitimate
  // test purchase without protecting any real revenue.
  const paidCents = Number(result.total_amount ?? result.amount ?? 0);
  // TEMPORARY — production-test rates pinned to 50¢ across every
  // plan so QA can verify the live checkout flow without spending
  // real money on each tier. REVERT to the real prices below before
  // launching to real customers, or the production price guard will
  // accept any non-zero charge as a valid plan purchase.
  const PLAN_PRICES_CENTS: Record<string, number> = {
    starter: Number(process.env.DODO_STARTER_PRICE_CENTS ?? 50),  // TEMP: was 1900 ($19)
    founder: Number(process.env.DODO_FOUNDER_PRICE_CENTS ?? 50),  // TEMP: was 4000 ($40)
    pro:     Number(process.env.DODO_PRO_PRICE_CENTS ?? 50),      // TEMP: was 4900 ($49)
  };
  const claimedPlanPrice = PLAN_PRICES_CENTS[plan ?? ""];

  if (env === "production" && paidCents > 0 && claimedPlanPrice > 0 && paidCents < claimedPlanPrice) {
    // Try to identify which plan the amount actually matches — helps support
    // figure out the right correction without spelunking through Dodo logs.
    const actualPlan = Object.entries(PLAN_PRICES_CENTS).find(([, cents]) => paidCents === cents)?.[0];
    return NextResponse.json({
      error: actualPlan
        ? `Plan mismatch: paid amount ($${paidCents / 100}) matches '${actualPlan}', not '${plan}'. Contact support to correct.`
        : `Paid amount ($${paidCents / 100}) is below the '${plan}' price ($${claimedPlanPrice / 100}). Contact support.`,
      paidCents,
      claimedPlan: plan,
      actualPlan: actualPlan ?? null,
    }, { status: 400 });
  }

  const isFounder = plan === "founder";

  if (isFounder) {

    // Atomically claim a Founder spot, keyed on payment_id for
    // idempotency. First call for a given payment_id consumes a slot;
    // duplicate calls (React StrictMode, user reload, network retry,
    // serverless cold-start retry) return the current count without
    // touching it. Returns NULL only when the promo is already inactive.
    const { data: claimed, error: claimError } = await supabase
      .rpc("claim_founder_spot", { p_payment_id: payment_id, p_user_id: user.id })
      .single();

    if (claimError) {
      return NextResponse.json({ error: `Founder claim failed: ${claimError.message}` }, { status: 500 });
    }
    if (claimed === null || typeof claimed !== "number") {
      return NextResponse.json(
        { error: "Founder promo has ended — all spots have been claimed.", promoEnded: true },
        { status: 409 },
      );
    }
  }

  const planExpiry = isFounder
    ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  try {
    await supabase.auth.admin.updateUserById(user.id, {
      app_metadata: {
        ...user.app_metadata,
        paid: true,
        paid_at: new Date().toISOString(),
        plan: plan ?? "pro",
        ...(isFounder && { plan_expires_at: planExpiry }),
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `Failed to update user: ${(e as Error).message}` }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
