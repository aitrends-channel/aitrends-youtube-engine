import "server-only";
import { supabase } from "@/lib/supabase/client";
import { getPlans } from "@/lib/plans";
import { getQuotaConfig } from "@/lib/quota-config";

// Facts about the product rather than about one account: what the plans cost,
// whether the founder promo is still open, what perk allowance each plan
// carries.
//
// The account evidence in lib/diagnose/evidence.ts is deliberately scoped to
// one user, which is right for "why did my video fail" and useless for "what
// does Pro cost". Without this the agent had to say it could not see pricing —
// true, and a poor answer to a question every plans page answers.
//
// Everything here is public-facing information already rendered on the pricing
// page, so there is nothing to redact. It is read live rather than hardcoded so
// a price change in the admin dashboard reaches the agent without a deploy.

export interface ProductFacts {
  plans: {
    name: string;
    slug: string;
    price: string;
    period: string;
    /** What the plan's headline limit is, as shown on the pricing page. */
    limit: string;
    nichesPerMonth: number | null;
    features: string[];
    isFounder: boolean;
    /** Not on sale — mentioning it as available would be wrong. */
    unavailable: boolean;
  }[];
  founderPromo: {
    active: boolean;
    spotsLeft: number | null;
    limit: number | null;
  } | null;
  /** Heclus-funded perk allowance per plan, in characters per month. */
  perkVoiceCharsByPlan: Record<string, number>;
  gaps: string[];
}

/** Rows that exist for our own plumbing, never sold. */
const INTERNAL_PLAN_SLUGS = new Set(["production-test"]);

export async function gatherProductFacts(): Promise<ProductFacts> {
  const gaps: string[] = [];

  const [plans, founderPromo, quotas] = await Promise.all([
    getPlans().catch((e) => { gaps.push(`plans unreadable: ${e instanceof Error ? e.message : e}`); return []; }),
    readFounderPromo().catch(() => { gaps.push("founder promo state unreadable"); return null; }),
    getQuotaConfig().catch(() => { gaps.push("perk allowances unreadable"); return null; }),
  ]);

  return {
    // The verification harness is a row in the same table but not a product.
    // Left in, the agent would happily quote "Production test — Test" as a tier.
    plans: plans.filter((p) => !INTERNAL_PLAN_SLUGS.has(p.slug)).map((p) => ({
      name: p.name,
      slug: p.slug,
      price: p.priceDisplay,
      period: p.periodDisplay,
      limit: p.limitDisplay,
      nichesPerMonth: p.nichesPerMonth,
      features: p.features,
      isFounder: p.isFounder,
      unavailable: p.disabled,
    })),
    founderPromo,
    perkVoiceCharsByPlan: quotas ? { ...quotas.ai33_tts_chars.byPlan } : {},
    gaps,
  };
}

/** Same RPC the public founder counter reads, so the two can never disagree. */
async function readFounderPromo(): Promise<ProductFacts["founderPromo"]> {
  const { data, error } = await supabase.rpc("get_founder_promo_state").single();
  if (error || !data) return null;
  const row = data as { taken?: number; remaining?: number; active?: boolean; limit?: number };
  const limit = typeof row.limit === "number"
    ? row.limit
    : typeof row.taken === "number" && typeof row.remaining === "number"
      ? row.taken + row.remaining
      : null;
  return {
    active: row.active !== false,
    spotsLeft: typeof row.remaining === "number" ? row.remaining : null,
    limit,
  };
}
