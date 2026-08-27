import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { resolveDodoCredentials } from "@/lib/dodo/credentials";
import { productIdFromCheckoutUrl } from "@/lib/dodo/pack-products";
import { productIdForPlan } from "@/lib/dodo/plan-products";
import { getHeclusPack } from "@/lib/heclus-pack";
import { supabase } from "@/lib/supabase/client";
import { getPaymentSettings } from "@/lib/plans";

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

  const settings = await getPaymentSettings();
  // Same rule /api/dodo/verify applies: production-test is the live-Dodo
  // harness, so it resolves its product and its credentials against production
  // whatever this deployment runs as.
  const mode = plan === "production-test" ? "production" : settings.mode;

  // The configured link is still the source of truth for which product is sold.
  // Resolved here rather than accepted from the client: this decides what is
  // charged.
  let fallbackUrl: string | null = null;
  let productId: string | null = null;
  if (plan) {
    productId = await productIdForPlan(plan, mode);
  } else if (wallet === "heclus") {
    const pack = await getHeclusPack();
    fallbackUrl = pack.checkoutUrl;
    productId = productIdFromCheckoutUrl(pack.checkoutUrl);
  } else if (wallet === "genai") {
    fallbackUrl = await genaiPackUrl(mode);
    productId = productIdFromCheckoutUrl(fallbackUrl);
  } else {
    return NextResponse.json({ error: "wallet must be 'heclus' or 'genai', or pass a plan" }, { status: 400 });
  }

  if (!productId) {
    return NextResponse.json({ error: "Nothing is configured to sell here yet.", url: fallbackUrl }, { status: 409 });
  }

  const origin = new URL(req.url).origin;
  const returnUrl = new URL("/payment/callback", origin);
  // Third fallback behind the two storages, same as buildTopUpUrl: Dodo returns
  // the caller's query params, so a private window that blocks both still knows
  // which wallet it bought.
  if (plan) {
    returnUrl.searchParams.set("plan", plan);
  } else {
    returnUrl.searchParams.set("type", wallet === "heclus" ? "heclus" : "credits");
  }

  const resolved = await resolveDodoCredentials(mode);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error, url: fallbackUrl }, { status: 500 });
  }
  const { secretKey, baseUrl } = resolved.creds;

  const dodo = ((user.app_metadata ?? {}) as { dodo?: { customer_id?: unknown } }).dodo ?? {};
  const customerId = typeof dodo.customer_id === "string" ? dodo.customer_id : null;
  const name =
    ((user.user_metadata ?? {}) as { full_name?: unknown }).full_name;

  const payload: Record<string, unknown> = {
    product_cart: [{ product_id: productId, quantity }],
    // An id makes this a returning customer, details and saved cards included.
    // Without one, email and name still prefill the form and create the record,
    // so the NEXT purchase is the remembered one.
    customer: customerId
      ? { customer_id: customerId }
      : { email: user.email, ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) },
    show_saved_payment_methods: true,
    return_url: returnUrl.toString(),
  };

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/checkouts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn("[dodo-checkout] unreachable:", (e as Error).message);
    return NextResponse.json({ url: fallbackUrl, fallback: true });
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    console.warn(`[dodo-checkout] ${res.status} product=${productId} body=${text}`);
    // A stale customer_id is the expected failure here, and it must not stop
    // someone spending money. The static link still works, it just asks again.
    return NextResponse.json({ url: fallbackUrl, fallback: true });
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const url =
    (json.checkout_url as string | undefined) ??
    (json.url as string | undefined) ??
    ((json.data as Record<string, unknown> | undefined)?.checkout_url as string | undefined) ??
    null;

  if (!url) {
    console.warn("[dodo-checkout] no url in response:", JSON.stringify(json).slice(0, 200));
    return NextResponse.json({ url: fallbackUrl, fallback: true });
  }
  return NextResponse.json({ url, fallback: false });
}
