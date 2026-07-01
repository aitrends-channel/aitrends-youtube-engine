import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { getPaymentSettings, getPlanBySlug, getPlans } from "@/lib/plans";

export async function POST(request: Request) {
  let user;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await request.json().catch(() => ({}));
  const { payment_id, subscription_id, plan } = body as {
    payment_id?: string;
    subscription_id?: string;
    plan?: string;
  };

  // Subscription products come back with subscription_id (no payment_id
  // until the first invoice). One-time products come back with payment_id.
  // Either is enough to look the record up on Dodo and confirm the sale.
  if (!payment_id && !subscription_id) {
    return NextResponse.json({ error: "Missing payment_id or subscription_id" }, { status: 400 });
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

  // Which endpoint on Dodo we hit depends on which id we received.
  // Subscription products yield subscription_id + status=active|on_trial;
  // one-time products yield payment_id + status=succeeded. Both are
  // legitimate purchases — we accept either and route accordingly.
  const usePath = payment_id ? `payments/${payment_id}` : `subscriptions/${subscription_id}`;
  const idLabel = payment_id ? `payment_id=${payment_id}` : `subscription_id=${subscription_id}`;
  const acceptableStatuses = payment_id ? ["succeeded"] : ["active", "on_trial"];

  // Surface where each value came from so a 404 from Dodo or a
  // wrong-env mismatch can be diagnosed in one log line. Key prefix
  // only — never the full secret.
  console.log(
    `[dodo-verify] plan=${plan} env=${env} ` +
    `base=${dodoBase} base_src=${basePick.source} ` +
    `key=${secretKey.slice(0, 8)}… key_src=${keyPick.source} ` +
    `${idLabel} path=${usePath}`,
  );

  let dodoRes: Response;
  try {
    dodoRes = await fetch(`${dodoBase}/${usePath}`, {
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

  if (!acceptableStatuses.includes(result.status)) {
    return NextResponse.json(
      { error: `${payment_id ? "Payment" : "Subscription"} not active (status: ${result.status})` },
      { status: 400 },
    );
  }

  // Log the full Dodo response on success so we can inspect available
  // fields (e.g. subscription_id presence, period dates) for a given
  // plan/product configuration. Safe to keep on — Dodo doesn't return
  // card numbers in this payload.
  console.log(
    `DODO RESPONSE: plan=${plan} payment_id=${payment_id} body=${JSON.stringify(result)}`,
  );

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
  // Subscription responses use recurring_amount instead of total_amount.
  // Falling through them all keeps the price guard useful across both
  // flows without needing separate branches.
  const paidCents = Number(result.total_amount ?? result.amount ?? result.recurring_amount ?? 0);
  const claimedPlanRow = plan ? await getPlanBySlug(plan) : null;
  const claimedPlanPrice = claimedPlanRow?.priceCents ?? 0;

  if (env === "production" && paidCents > 0 && claimedPlanPrice > 0 && paidCents < claimedPlanPrice) {
    // Try to identify which plan the amount actually matches — helps support
    // figure out the right correction without spelunking through Dodo logs.
    const allPlans = await getPlans();
    const actualPlan = allPlans.find((p) => p.priceCents === paidCents)?.slug ?? null;
    return NextResponse.json({
      error: actualPlan
        ? `Plan mismatch: paid amount ($${paidCents / 100}) matches '${actualPlan}', not '${plan}'. Contact support to correct.`
        : `Paid amount ($${paidCents / 100}) is below the '${plan}' price ($${claimedPlanPrice / 100}). Contact support.`,
      paidCents,
      claimedPlan: plan,
      actualPlan,
    }, { status: 400 });
  }

  const isFounder = plan === "founder";

  if (isFounder) {
    // Founder is one-time — we should always have payment_id here. If
    // someone claims founder via a subscription redirect, reject up-
    // front instead of feeding NULL into the RPC.
    if (!payment_id) {
      return NextResponse.json(
        { error: "Founder plan requires a one-time payment; got a subscription redirect. Contact support." },
        { status: 400 },
      );
    }
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

  // Pull subscription identifiers from Dodo's payment response when
  // present (subscription products fill these in; one-time purchases
  // don't). Persisting them here means the /plan Cancel button shows
  // immediately on redirect, without waiting for the webhook to
  // arrive separately. Mirrors the merge logic in the webhook so
  // either entry point produces the same shape.
  const subscriptionIdFromResult =
    (result.subscription_id as string | undefined) ??
    ((result.subscription as Record<string, unknown> | undefined)?.subscription_id as string | undefined) ??
    subscription_id ??
    null;
  // Dodo returns customer_id both on top-level and nested under customer
  // depending on the payload shape. Persisting it lets us substitute
  // {customer_id} into the admin-configured portal URL later.
  const customerIdFromResult =
    (result.customer_id as string | undefined) ??
    ((result.customer as Record<string, unknown> | undefined)?.customer_id as string | undefined) ??
    null;
  const periodEndFromResult =
    (result.current_period_end as string | undefined) ??
    (result.next_billing_date as string | undefined) ??
    ((result.subscription as Record<string, unknown> | undefined)?.next_billing_date as string | undefined) ??
    null;

  const planExpiry = isFounder
    ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    : periodEndFromResult;

  const baseDodo = (user.app_metadata?.dodo ?? {}) as Record<string, unknown>;
  const mergedDodo = {
    ...baseDodo,
    event: "payment.verified",
    status: result.status,
    updated_at: new Date().toISOString(),
    ...(subscriptionIdFromResult ? { subscription_id: subscriptionIdFromResult } : {}),
    ...(customerIdFromResult ? { customer_id: customerIdFromResult } : {}),
    ...(periodEndFromResult ? { current_period_end: periodEndFromResult } : {}),
    ...(!subscriptionIdFromResult && baseDodo.subscription_id ? { subscription_id: baseDodo.subscription_id } : {}),
    ...(!customerIdFromResult && baseDodo.customer_id ? { customer_id: baseDodo.customer_id } : {}),
  };

  try {
    await supabase.auth.admin.updateUserById(user.id, {
      app_metadata: {
        ...user.app_metadata,
        paid: true,
        paid_at: new Date().toISOString(),
        plan: plan ?? "pro",
        dodo: mergedDodo,
        ...(planExpiry ? { plan_expires_at: planExpiry } : {}),
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `Failed to update user: ${(e as Error).message}` }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
