import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { getPaymentSettings } from "@/lib/plans";

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

  // Price guard temporarily disabled: FX-converted charges (Dodo
  // returns total_amount in the buyer's local currency) were tripping
  // it for legitimate non-USD payments. For now we trust any Dodo-
  // acknowledged charge with an acceptable status regardless of
  // amount; Dodo already enforces the correct converted price at
  // checkout on its side.

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

  // Immutable revenue ledger — mirrors the insert in the Dodo webhook
  // so a payment is recorded by whichever path lands first. Unique on
  // dodo_payment_id: when both paths run (the normal case) the second
  // insert dedupes as 23505. This closed a real gap where Dodo webhook
  // delivery stopped and payments granted access via this verify path
  // but never appeared in revenue stats. Fail-soft: the customer is
  // paid regardless; ledger logging is best-effort.
  //
  // Subscription checkouts give us only a subscription_id, and Dodo's
  // subscription object holds no payment reference or usable amount —
  // hence the lookup by subscription.
  const resolveLedgerPayment = async (): Promise<Record<string, unknown> | null> => {
    if (payment_id) return result;

    const subId = subscriptionIdFromResult ?? subscription_id;
    if (!subId) return null;

    const listRes = await fetch(`${dodoBase}/payments?subscription_id=${encodeURIComponent(subId)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    }).catch(() => null);
    if (!listRes?.ok) return null;

    const list = await listRes.json().catch(() => null);
    const items = (list?.items ?? list?.data ?? []) as Record<string, unknown>[];
    const succeeded = items.find((p) => p.status === "succeeded");
    const pid = succeeded?.payment_id as string | undefined;
    if (!pid) return null;

    // Only the single-payment endpoint returns settlement_amount.
    const oneRes = await fetch(`${dodoBase}/payments/${pid}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    }).catch(() => null);
    return (oneRes?.ok ? await oneRes.json().catch(() => succeeded) : succeeded) ?? null;
  };

  const paymentForLedger = await resolveLedgerPayment();
  const ledgerPaymentId = paymentForLedger?.payment_id as string | undefined;
  const ledgerSettlement = Number(paymentForLedger?.settlement_amount ?? 0);
  const ledgerAmountCents = ledgerSettlement > 0
    ? ledgerSettlement
    : Number(paymentForLedger?.total_amount ?? paymentForLedger?.amount ?? 0);
  if (!ledgerPaymentId || !(ledgerAmountCents > 0)) {
    console.warn(
      `[dodo-verify] no ledger row written — plan=${plan} ${idLabel} ` +
      `resolved_payment=${ledgerPaymentId ?? "none"} amount=${ledgerAmountCents}`,
    );
  }
  if (ledgerPaymentId && ledgerAmountCents > 0) {
    const { error: revErr } = await supabase
      .from("revenue_events")
      .insert({
        user_id: user.id,
        user_email: (user.email ?? "").toLowerCase() || null,
        event_type: "payment_succeeded",
        amount_cents: ledgerAmountCents,
        currency: ledgerSettlement > 0
          ? (((paymentForLedger?.settlement_currency as string | undefined) ?? "usd").toLowerCase())
          : (((paymentForLedger?.currency as string | undefined) ?? "usd").toLowerCase()),
        plan: plan ?? null,
        dodo_payment_id: ledgerPaymentId,
        dodo_raw: paymentForLedger,
        occurred_at: (paymentForLedger?.created_at as string | undefined) ?? new Date().toISOString(),
      });
    if (revErr && revErr.code !== "23505") {
      console.warn("[dodo-verify] revenue_events insert failed:", revErr.message);
    }
  }

  return NextResponse.json({ success: true });
}
