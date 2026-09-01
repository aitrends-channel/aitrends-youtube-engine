import { supabase } from "@/lib/supabase/client";
import { isProductionEnv } from "@/lib/env";

// The free-image top-up pack: its own product, its own link, its own numbers.
//
// Deliberately not the Heclus wallet's pack. The two buy different things: the
// wallet is spent on whatever the customer generates at whatever that model
// costs, where this buys images on the one cheap model the free lane runs on.
// Borrowing the other pack's link would charge for one and deliver the other,
// which is the mistake the separate heclus and genai top-up routes already
// exist to prevent.
//
// Read here rather than in each route so the panel and the crediting route
// cannot disagree about what a purchase is worth: the panel decides whether to
// show a button, the topup route decides what to grant, and both look at this.

export interface FreeImagePack {
  /** Images granted per unit bought. Null when unconfigured. */
  images: number | null;
  /** Price per unit, for display. Never used to derive what to grant: see
   *  purchasedQuantity in lib/dodo/payment.ts. */
  priceUsd: number | null;
  /** Where Top up sends the customer, for this deployment's environment. */
  checkoutUrl: string | null;
  /** Why there is nothing to sell, for the admin-only hint. */
  reason: "ok" | "no-columns" | "no-link" | "no-images";
}

const NONE: FreeImagePack = { images: null, priceUsd: null, checkoutUrl: null, reason: "no-link" };

const positive = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export async function getFreeImagePack(): Promise<FreeImagePack> {
  try {
    const { data, error } = await supabase
      .from("product_config")
      .select("heclus_free_image_top_checkout_url_test, heclus_free_image_top_checkout_url_production, heclus_free_image_top_credits, heclus_free_image_top_price_usd")
      .eq("service", "_global")
      .maybeSingle();
    // Migrations here are applied by hand, so the columns may not exist yet.
    // That reads as "nothing to sell" either way, but an unapplied migration
    // and an unset field need different fixes, so they are told apart.
    if (error) {
      return { ...NONE, reason: /column .* does not exist/i.test(error.message) ? "no-columns" : "no-link" };
    }
    if (!data) return NONE;

    const row = data as Record<string, unknown>;
    const rawUrl = isProductionEnv()
      ? row.heclus_free_image_top_checkout_url_production
      : row.heclus_free_image_top_checkout_url_test;
    const checkoutUrl = typeof rawUrl === "string" && rawUrl.trim() ? rawUrl.trim() : null;
    const images = positive(row.heclus_free_image_top_credits);
    const priceUsd = positive(row.heclus_free_image_top_price_usd);

    if (!checkoutUrl) return NONE;
    // Both the link AND the pack size are required to open the button. A
    // checkout with no pack size would take the money and grant nothing, which
    // is the one outcome worth keeping a button disabled over.
    if (images === null) return { images: null, priceUsd, checkoutUrl: null, reason: "no-images" };

    return { images, priceUsd, checkoutUrl, reason: "ok" };
  } catch {
    return NONE;
  }
}
