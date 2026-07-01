export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabase as supabaseService } from "@/lib/supabase/client";
import { getPaymentSettings } from "@/lib/plans";

// POST /api/dodo/cancel-subscription
//
// Soft-cancels the caller's active Dodo subscription via Dodo's REST
// API. "Soft" = cancel_at_next_billing_date=true, so the user keeps
// the access they've already paid for through the end of the current
// period. The subscription.cancelled webhook will then fire from Dodo
// and our handler sets app_metadata.plan_expires_at to the period
// end. We don't mutate app_metadata here ourselves — the webhook is
// the single source of truth so a cancellation initiated from Dodo's
// dashboard or any other channel produces the same state.
export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dodo = (user.app_metadata?.dodo ?? {}) as Record<string, unknown>;
  const subscriptionId = (dodo.subscription_id as string | undefined) ?? null;
  if (!subscriptionId) {
    return NextResponse.json(
      { error: "No active subscription to cancel. If you believe this is wrong, contact support." },
      { status: 400 },
    );
  }

  // Match the resolution order used by /api/dodo/verify: DB-managed
  // settings first, then env-specific, then legacy single-env fallback.
  const settings = await getPaymentSettings();
  const env = settings.mode;
  const secretKey =
    (env === "production" ? settings.secretKeyProduction : settings.secretKeyTest) ??
    (env === "production" ? process.env.DODO_SECRET_KEY_PRODUCTION : process.env.DODO_SECRET_KEY_TEST) ??
    process.env.DODO_SECRET_KEY ??
    null;
  const dodoBase =
    (env === "production" ? settings.baseUrlProduction : settings.baseUrlTest) ??
    (env === "production" ? process.env.DODO_LIVE_BASE_URL : process.env.DODO_TEST_BASE_URL) ??
    (env === "test" ? (process.env.DODO_BASE_URL ?? null) : null) ??
    (env === "production" ? "https://live.dodopayments.com" : "https://test.dodopayments.com");

  if (!secretKey) {
    return NextResponse.json(
      { error: `Dodo ${env} secret key is not configured. Contact support.` },
      { status: 500 },
    );
  }

  let dodoRes: Response;
  try {
    dodoRes = await fetch(`${dodoBase}/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cancel_at_next_billing_date: true }),
    });
  } catch (e) {
    return NextResponse.json({ error: `Dodo fetch failed: ${(e as Error).message}` }, { status: 502 });
  }

  if (!dodoRes.ok) {
    const body = await dodoRes.text().catch(() => "");
    console.error(`[dodo-cancel] ${dodoRes.status} sub=${subscriptionId} body=${body.slice(0, 200)}`);
    return NextResponse.json(
      { error: `Could not cancel subscription (Dodo ${dodoRes.status}). Try again or contact support.` },
      { status: 502 },
    );
  }

  // Best-effort: optimistically stamp both plan_expires_at AND the
  // cancelled state on dodo.{status,event} so the /plan UI can flip
  // to the cancelled treatment immediately, without waiting for the
  // webhook round-trip (which can be delayed by seconds or minutes).
  // The webhook still fires afterwards and will overwrite these with
  // the authoritative values — same pattern as /api/dodo/verify.
  const result = await dodoRes.json().catch(() => ({} as Record<string, unknown>));
  const periodEnd =
    (result.current_period_end as string | undefined) ??
    (result.next_billing_date as string | undefined) ??
    (user.app_metadata?.plan_expires_at as string | undefined) ??
    null;

  const baseMeta = user.app_metadata ?? {};
  const baseDodo = (baseMeta.dodo ?? {}) as Record<string, unknown>;
  const mergedDodo = {
    ...baseDodo,
    event: "subscription.cancelled",
    status: "cancelled",
    updated_at: new Date().toISOString(),
    ...(periodEnd ? { current_period_end: periodEnd } : {}),
  };
  await supabaseService.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...baseMeta,
      dodo: mergedDodo,
      ...(periodEnd ? { plan_expires_at: periodEnd } : {}),
    },
  });

  return NextResponse.json({ success: true, period_end: periodEnd });
}
