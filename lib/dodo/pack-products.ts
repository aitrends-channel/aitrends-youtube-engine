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

export type PackWallet = "genai" | "heclus" | "free_images";

/**
 * The Dodo product a configured value names.
 *
 * Takes a bare product id, which is what these fields hold now, and still
 * reads a /buy/ link, which is what they held before. Dodo's compliance review
 * asked us to stop using payment links, and the id is the only part of a link
 * this code ever wanted: it identifies the product for the Checkout API and
 * tells a top-up apart from a subscription on the way back.
 *
 * Keeping the link form working matters for the rows already configured. A
 * migration that had to be applied by hand before payments worked again would
 * be a worse answer than a regex.
 */
export function productIdFrom(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (/^pdt_[A-Za-z0-9_]+$/.test(raw)) return raw;
  const m = /\/buy\/([A-Za-z0-9_]+)/.exec(raw);
  return m ? m[1] : null;
}

/** @deprecated Use productIdFrom: the fields hold ids now, not links. */
export const productIdFromCheckoutUrl = productIdFrom;

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
    .select("heclus_pack_checkout_url_test, heclus_pack_checkout_url_production, credit_pack_checkout_url_test, credit_pack_checkout_url_production, heclus_free_image_top_checkout_url_test, heclus_free_image_top_checkout_url_production")
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

  const freeImages = [
    row.heclus_free_image_top_checkout_url_test,
    row.heclus_free_image_top_checkout_url_production,
  ]
    .map((u) => productIdFromCheckoutUrl(u as string | null))
    .filter((v): v is string => !!v);

  // Heclus first: if one product id were ever configured as both, crediting the
  // general wallet is the recoverable mistake. Video clips are not refundable
  // into it.
  if (ids.some((id) => heclus.includes(id))) return "heclus";
  if (ids.some((id) => genai.includes(id))) return "genai";
  // Recognised so the webhook cannot mistake it for a subscription. An
  // unrecognised product falls through to the plan branch, which flips
  // app_metadata.paid and sends a welcome mail, so a customer buying images
  // would be handed plan access nobody sold them. Crediting itself stays with
  // the verified return, which is where every free-image purchase is granted.
  if (ids.some((id) => freeImages.includes(id))) return "free_images";
  return null;
}
