import { supabase } from "@/lib/supabase/client";

// Telling a credit purchase apart from a subscription payment.
//
// Both arrive on the same webhook as payment.succeeded, and the plan branch
// there flips app_metadata.paid to true and sends a welcome email. A top-up must
// not do any of that: it is a repeat purchase by an existing customer, not a new
// subscriber, and marking someone paid because they bought credits would hand
// out plan access nobody paid for.
//
// The only reliable discriminator on the payload is the product. Dodo checkout
// links carry it in the path (/buy/pdt_…), so the configured pack links are the
// source of truth for which product ids mean credits.

export type PackWallet = "genai" | "heclus";

/** Pulls pdt_… out of a Dodo checkout link. */
export function productIdFromCheckoutUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/buy\/([A-Za-z0-9_]+)/.exec(url);
  return m ? m[1] : null;
}

/** Every product id the payload could carry, cart first. */
export function productIdsOnPayment(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const cart = raw.product_cart;
  if (Array.isArray(cart)) {
    for (const item of cart) {
      const id = (item as { product_id?: unknown })?.product_id;
      if (typeof id === "string" && id) out.push(id);
    }
  }
  const flat = raw.product_id;
  if (typeof flat === "string" && flat) out.push(flat);
  return out;
}

/**
 * Which wallet this payment bought into, or null for anything else.
 *
 * Checks both environments' links rather than only this deployment's, because a
 * test purchase confirmed against the live account (and the reverse) is a case
 * the payment confirmation already handles deliberately.
 *
 * Returns null on any read failure, which routes the payment down the existing
 * plan path. That is the safe default: it is what happens today.
 */
export async function walletForPayment(raw: Record<string, unknown>): Promise<PackWallet | null> {
  const ids = productIdsOnPayment(raw);
  if (ids.length === 0) return null;

  const { data, error } = await supabase
    .from("product_config")
    .select("heclus_pack_checkout_url_test, heclus_pack_checkout_url_production, credit_pack_checkout_url_test, credit_pack_checkout_url_production")
    .eq("service", "_global")
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;

  const heclus = [row.heclus_pack_checkout_url_test, row.heclus_pack_checkout_url_production]
    .map((u) => productIdFromCheckoutUrl(u as string | null))
    .filter((v): v is string => !!v);
  const genai = [row.credit_pack_checkout_url_test, row.credit_pack_checkout_url_production]
    .map((u) => productIdFromCheckoutUrl(u as string | null))
    .filter((v): v is string => !!v);

  // Heclus first: if one product id were ever configured as both, crediting the
  // general wallet is the recoverable mistake. Video clips are not refundable
  // into it.
  if (ids.some((id) => heclus.includes(id))) return "heclus";
  if (ids.some((id) => genai.includes(id))) return "genai";
  return null;
}
