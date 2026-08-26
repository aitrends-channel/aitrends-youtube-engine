import { getAllPlans } from "@/lib/plans";
import type { PaymentMode } from "@/lib/plans";
import { productIdFromCheckoutUrl } from "@/lib/dodo/pack-products";

// Which Dodo product sells which plan.
//
// There is no product_id column: a plan carries a checkout link per env, and
// the id is the /buy/ segment of it. Same derivation lib/dodo/pack-products.ts
// already uses for the credit packs, so the link stays the single place a
// product is configured.

/** The Dodo product that sells this plan in the given env, or null. */
export async function productIdForPlan(slug: string, mode: PaymentMode): Promise<string | null> {
  const plans = await getAllPlans();
  const plan = plans.find((p) => p.slug === slug);
  if (!plan) return null;
  const link = mode === "production" ? plan.paymentLinkProduction : plan.paymentLinkTest;
  return productIdFromCheckoutUrl(link);
}

/**
 * The plan a Dodo product sells, or null when the id belongs to nothing we
 * sell as a subscription (a credit pack, a deleted product).
 *
 * Reads legacy rows too, and checks both envs' links rather than only this
 * deployment's. A renewal has to resolve to the product the customer actually
 * bought, which for every existing subscriber is a legacy row, and a live
 * purchase confirmed against test credentials is a case the payment path
 * already handles deliberately.
 */
export async function planSlugForProductId(productId: string | null | undefined): Promise<string | null> {
  const id = (productId ?? "").trim();
  if (!id) return null;
  const plans = await getAllPlans();
  for (const p of plans) {
    const ids = [p.paymentLinkTest, p.paymentLinkProduction]
      .map(productIdFromCheckoutUrl)
      .filter((v): v is string => !!v);
    if (ids.includes(id)) return p.slug;
  }
  return null;
}

/** Every product id a subscription payload could carry, most specific first. */
export function productIdOnSubscription(raw: Record<string, unknown>): string | null {
  const direct = raw.product_id;
  if (typeof direct === "string" && direct) return direct;
  const nested = (raw.subscription as Record<string, unknown> | undefined)?.product_id;
  if (typeof nested === "string" && nested) return nested;
  const cart = raw.product_cart;
  if (Array.isArray(cart)) {
    for (const item of cart) {
      const id = (item as { product_id?: unknown })?.product_id;
      if (typeof id === "string" && id) return id;
    }
  }
  return null;
}
