import { supabase } from "@/lib/supabase/client";
import { isProductionEnv } from "@/lib/env";

// The Heclus Credits top-up pack: where the button points, and what one purchase
// grants.
//
// Its own link and its own numbers, never the video pack's. That one credits
// genai_credits, so borrowing it would charge a customer for Heclus Credits and
// hand them video clips instead. Migration 130.
//
// Read here rather than in each route so the Balance panel and the crediting
// route cannot disagree about what a purchase is worth. The panel decides
// whether to show a button; the topup route decides what to grant; both have to
// be looking at the same row.

export interface HeclusPack {
  /** Credits granted per unit bought. Null when unconfigured. */
  credits: number | null;
  /** Price per unit, for display only. Never used to derive what to grant: see
   *  purchasedQuantity in lib/dodo/payment.ts. */
  priceUsd: number | null;
  /** Where Top up sends the customer, for this deployment's environment. */
  checkoutUrl: string | null;
  /** Why there is nothing to sell, for the admin-only hint. */
  reason: "ok" | "no-columns" | "no-link" | "no-credits";
}

const NONE: HeclusPack = { credits: null, priceUsd: null, checkoutUrl: null, reason: "no-link" };

export async function getHeclusPack(): Promise<HeclusPack> {
  try {
    const { data, error } = await supabase
      .from("product_config")
      .select("heclus_pack_checkout_url_test, heclus_pack_checkout_url_production, heclus_pack_credits, heclus_pack_price_usd")
      .eq("service", "_global")
      .maybeSingle();
    // Migrations here are applied by hand, so the columns may not exist yet.
    // That reads as "nothing to sell" to a customer either way, but an
    // unapplied migration and an unset field need different fixes, so they are
    // told apart for the admin hint.
    if (error) {
      return { ...NONE, reason: /column .* does not exist/i.test(error.message) ? "no-columns" : "no-link" };
    }
    if (!data) return NONE;

    const row = data as Record<string, unknown>;
    const rawUrl = isProductionEnv()
      ? row.heclus_pack_checkout_url_production
      : row.heclus_pack_checkout_url_test;
    const checkoutUrl = typeof rawUrl === "string" && rawUrl.trim() ? rawUrl.trim() : null;
    const credits = positive(row.heclus_pack_credits);
    const priceUsd = positive(row.heclus_pack_price_usd);

    if (!checkoutUrl) return NONE;
    // Both the link AND the pack size are required to open the button.
    //
    // The link alone used to be enough, from when nothing credited this wallet
    // and a dead button was the worst outcome. Now that a purchase is credited
    // from this number, a checkout with no pack size would take the money and
    // grant nothing, which is the one outcome worth keeping a button disabled
    // over. The price is still optional: it only sharpens what the button says.
    if (credits === null) return { credits: null, priceUsd, checkoutUrl: null, reason: "no-credits" };

    return { credits, priceUsd, checkoutUrl, reason: "ok" };
  } catch {
    return NONE;
  }
}

function positive(v: unknown): number | null {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}
