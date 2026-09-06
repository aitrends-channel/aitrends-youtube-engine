export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getPaymentSettings } from "@/lib/plans";
import { dodoHeaders } from "@/lib/dodo/credentials";

// POST /api/dodo/portal-session
//
// Creates a Dodo customer-portal session for the logged-in user and
// returns a short-lived signed URL. The /plan page's "Manage" button
// POSTs here on click, then window.open()'s the returned URL — the
// user goes straight into the portal without a Dodo login step.
//
// customer_id must be stamped on app_metadata.dodo (populated by
// /api/dodo/verify and the webhook starting from commit 7bc1a72).
// Users who paid before that landed won't have it — surface a clear
// 400 so support can backfill from Dodo's dashboard.
export async function POST() {
  let user;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const dodo = (user.app_metadata?.dodo ?? {}) as Record<string, unknown>;
  const customerId = (dodo.customer_id as string | undefined) ?? null;
  if (!customerId) {
    return NextResponse.json(
      { error: "No Dodo customer_id on record. Contact support to backfill." },
      { status: 400 },
    );
  }

  // Same env / secret / base resolution the other Dodo routes use.
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
      { error: `Dodo ${env} secret key is not configured.` },
      { status: 500 },
    );
  }

  // Dodo's session-create endpoint. Docs:
  // https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session
  const url = `${dodoBase}/customers/${customerId}/customer-portal/session`;
  console.log(`[dodo-portal] user=${user.id} env=${env} url=${url}`);

  let dodoRes: Response;
  try {
    dodoRes = await fetch(url, {
      method: "POST",
      headers: dodoHeaders(secretKey),
      body: "{}",
    });
  } catch (e) {
    return NextResponse.json({ error: `Dodo fetch failed: ${(e as Error).message}` }, { status: 502 });
  }

  if (!dodoRes.ok) {
    const body = await dodoRes.text().catch(() => "");
    console.error(`[dodo-portal] ${dodoRes.status} url=${url} body=${body.slice(0, 400)}`);
    return NextResponse.json(
      { error: `Could not create portal session (Dodo ${dodoRes.status}).` },
      { status: 502 },
    );
  }

  const result = await dodoRes.json().catch(() => ({} as Record<string, unknown>));
  // Different providers name this field differently — accept any of
  // the common ones so we don't have to guess Dodo's exact spelling.
  const portalUrl =
    (result.link as string | undefined) ??
    (result.url as string | undefined) ??
    (result.portal_url as string | undefined) ??
    (result.session_url as string | undefined) ??
    null;

  if (!portalUrl) {
    console.error(`[dodo-portal] unexpected response shape: ${JSON.stringify(result).slice(0, 400)}`);
    return NextResponse.json(
      { error: "Dodo returned no portal URL. Check server logs." },
      { status: 502 },
    );
  }

  return NextResponse.json({ url: portalUrl });
}
