import { NextResponse } from "next/server";
import { getFreeImagePack } from "@/lib/free-image-pack";
import { walletParam, type TopUpWallet } from "@/lib/credits-checkout";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { resolveDodoCredentials } from "@/lib/dodo/credentials";
import { productIdFrom } from "@/lib/dodo/pack-products";
import { productIdForPlan } from "@/lib/dodo/plan-products";
import { getHeclusPack } from "@/lib/heclus-pack";
import { supabase } from "@/lib/supabase/client";
import { getPaymentSettings } from "@/lib/plans";
import { canSeeNewPlans, isGatedPlan } from "@/lib/rollout";
import { dodoHeaders } from "@/lib/dodo/credentials";

export const dynamic = "force-dynamic";

// A checkout the customer does not have to fill in again.
//
// A static /buy/pdt_… link is an anonymous purchase: Dodo builds a fresh
// customer record for it, so name, email and billing address are asked for on
// every top-up and a card saved last time is never offered. Attaching the
// customer we already have turns the same purchase into a returning one.
//
// show_saved_payment_methods defaults to false, which is why saved cards never
// appeared even where Dodo had them.
//
// Falls back to the static link on any failure rather than blocking the
// purchase. A customer re-typing their address is a worse checkout; no checkout
// at all is a lost sale.

interface Body {
  /** Which wallet is being topped up. */
  wallet?: unknown;
  /** Or a plan slug, for a subscription purchase. */
  plan?: unknown;
  quantity?: unknown;
}

async function genaiPackUrl(mode: "test" | "production"): Promise<string | null> {
  const { data } = await supabase
    .from("product_config")
    .select("credit_pack_checkout_url_test, credit_pack_checkout_url_production")
    .eq("service", "_global")
    .maybeSingle();
  const row = (data ?? {}) as Record<string, string | null>;
  const fromDb = mode === "production"
    ? row.credit_pack_checkout_url_production
    : row.credit_pack_checkout_url_test;
  return (fromDb ?? null)
    ?? (mode === "production"
      ? process.env.NEXT_PUBLIC_DODO_CREDIT_PACK_LINK_PRODUCTION
      : process.env.NEXT_PUBLIC_DODO_CREDIT_PACK_LINK_TEST)
    ?? process.env.NEXT_PUBLIC_DODO_CREDIT_PACK_LINK
    ?? null;
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = (await req.json().catch(() => ({}))) as Body;
  const wallet = typeof body.wallet === "string" ? body.wallet : null;
  const plan = typeof body.plan === "string" ? body.plan : null;
  const quantity = Math.max(1, Math.floor(Number(body.quantity) || 1));

  // The card is hidden from customers in /api/plans, but hiding a card is not
  // a gate: this route takes a slug from the client and is what turns it into a
  // real charge. Refused here, a customer who guesses the slug still cannot buy
  // a plan whose entitlements are not switched on for them yet.
  if (plan && isGatedPlan(plan) && !canSeeNewPlans(user)) {
    return NextResponse.json({ error: "That plan is not available yet." }, { status: 403 });
  }

  const settings = await getPaymentSettings();
  // Same rule /api/dodo/verify applies: production-test is the live-Dodo
  // harness, so it resolves its product and its credentials against production
  // whatever this deployment runs as.
  const mode = plan === "production-test" ? "production" : settings.mode;

  // Which product is being sold, resolved here rather than accepted from the
  // client: this decides what is charged.
  //
  // No fallback link any more. Dodo's compliance review asked that payment
  // links stop being used for customer payments, so a checkout that cannot be
  // created is an error the customer sees and retries, not a redirect to a
  // link that asks for their details again.
  let productId: string | null = null;
  if (plan) {
    productId = await productIdForPlan(plan, mode);
  } else if (wallet === "heclus") {
    productId = productIdFrom((await getHeclusPack()).checkoutUrl);
  } else if (wallet === "genai") {
    productId = productIdFrom(await genaiPackUrl(mode));
  } else if (wallet === "free_images") {
    productId = productIdFrom((await getFreeImagePack()).checkoutUrl);
  } else {
    return NextResponse.json({ error: "wallet must be 'heclus', 'genai' or 'free_images', or pass a plan" }, { status: 400 });
  }

  if (!productId) {
    return NextResponse.json({ error: "Nothing is configured to sell here yet." }, { status: 409 });
  }

  const origin = new URL(req.url).origin;
  const returnUrl = new URL("/payment/callback", origin);
  // Third fallback behind the two storages, same as buildTopUpUrl: Dodo returns
  // the caller's query params, so a private window that blocks both still knows
  // which wallet it bought.
  if (plan) {
    returnUrl.searchParams.set("plan", plan);
  } else {
    // walletParam, not a ternary: three wallets now, and the callback picks a
    // crediting route off this string.
    returnUrl.searchParams.set("type", walletParam((wallet ?? "genai") as TopUpWallet));
  }

  const resolved = await resolveDodoCredentials(mode);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 500 });
  }
  const { secretKey, baseUrl } = resolved.creds;

  const dodo = ((user.app_metadata ?? {}) as { dodo?: { customer_id?: unknown } }).dodo ?? {};
  const customerId = typeof dodo.customer_id === "string" ? dodo.customer_id : null;
  const name =
    ((user.user_metadata ?? {}) as { full_name?: unknown }).full_name;

  const buildPayload = (withCustomerId: boolean): Record<string, unknown> => ({
    product_cart: [{ product_id: productId, quantity }],
    // An id makes this a returning customer, details and saved cards included.
    // Without one, email and name still prefill the form and create the record,
    // so the NEXT purchase is the remembered one.
    customer: withCustomerId && customerId
      ? { customer_id: customerId }
      : { email: user.email, ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) },
    show_saved_payment_methods: true,
    return_url: returnUrl.toString(),
  });

  const create = (withCustomerId: boolean) => fetch(`${baseUrl}/checkouts`, {
    method: "POST",
    headers: dodoHeaders(secretKey),
    body: JSON.stringify(buildPayload(withCustomerId)),
  });

  let res: Response;
  try {
    res = await create(true);
  } catch (e) {
    console.error("[dodo-checkout] unreachable:", (e as Error).message);
    return NextResponse.json({ error: "Could not reach the checkout. Try again in a moment." }, { status: 502 });
  }

  // A stale customer_id is the expected failure, and it used to be answered
  // with a payment link. Answered by dropping the id and asking again instead:
  // the customer still gets a Dodo-hosted checkout, and still must not be
  // stopped from spending money by a record of ours being out of date.
  if (!res.ok && customerId) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    console.warn(`[dodo-checkout] ${res.status} product=${productId} body=${text} — retrying without the customer id`);
    try {
      res = await create(false);
    } catch (e) {
      console.error("[dodo-checkout] unreachable on retry:", (e as Error).message);
      return NextResponse.json({ error: "Could not reach the checkout. Try again in a moment." }, { status: 502 });
    }
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    console.error(`[dodo-checkout] ${res.status} product=${productId} body=${text}`);
    return NextResponse.json({ error: "Could not start the checkout. Try again, or contact support." }, { status: 502 });
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const url =
    (json.checkout_url as string | undefined) ??
    (json.url as string | undefined) ??
    ((json.data as Record<string, unknown> | undefined)?.checkout_url as string | undefined) ??
    null;

  if (!url) {
    console.error("[dodo-checkout] no url in response:", JSON.stringify(json).slice(0, 200));
    return NextResponse.json({ error: "Could not start the checkout. Try again, or contact support." }, { status: 502 });
  }
  return NextResponse.json({ url });
}
