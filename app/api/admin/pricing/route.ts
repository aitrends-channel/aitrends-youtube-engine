export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-server";
import { getAllPlans } from "@/lib/plans";
import { packCreditsForTier } from "@/lib/heclus-credits";
import { tierForPlan } from "@/lib/plans-gating";
import { QUOTA_DEFAULTS, GENAIPRO_USD_PER_MILLION_CLIPS, AI33_TTS_USD_PER_MILLION_CHARS } from "@/lib/quota-config";
import { USD_PER_CREDIT } from "@/lib/credit-unit";
import { supabase } from "@/lib/supabase/client";

// What each plan actually earns, line by line.
//
// Every figure is computed from the same constants the product runs on rather
// than typed in here, so a change to an allowance or a rate shows up on this
// page without anyone remembering to update it. The one exception is the fixed
// infrastructure list, which has no source in the codebase: those are invoices,
// and they are marked as estimates until somebody puts the real ones in.
//
// Read as a CEILING on margin, not a forecast. It assumes every customer
// exhausts every allowance every month, which the usage data says almost none
// of them do.

/** Cloudflare R2 standard storage. */
const R2_USD_PER_GB = 0.015;

/** Free images run on z-image at 0.8 KIE credits, the cheapest model we carry.
 *  The blended rate across everything production generates on is $0.0231, so
 *  pinning the free allowance to z-image is what keeps it affordable. */
const FREE_IMAGE_CREDITS = 0.8;

/** Not a quota kind yet: there is no counter or migration behind these, only
 *  the numbers on the plan cards. Here so the margin is honest about them. */
const FREE_IMAGES: Record<string, number> = { starter: 300, pro: 900, max: 1500 };

/** Taken off gross revenue rather than off cost: both are a slice of what the
 *  customer pays, so they scale with price and not with usage. */
const FEES = [
  { key: "dodo", label: "Dodo", rate: 0.10 },
  { key: "gog", label: "GOG", rate: 0.05 },
];

const cap = (k: keyof typeof QUOTA_DEFAULTS, tier: string) => QUOTA_DEFAULTS[k].byPlan[tier] ?? 0;

export interface PricingLine { label: string; qty: string; usd: number }
export interface PricingPlan {
  slug: string; name: string; tier: string; price: number;
  /** True when the price above was divided down from a yearly one, so the row
   *  can say so rather than looking like a very cheap monthly plan. */
  annualised: boolean;
  cogs: PricingLine[]; fees: PricingLine[];
  cogsTotal: number; feesTotal: number;
  total: number; net: number; marginPct: number;
}

export interface PricingReport {
  plans: PricingPlan[];
  /** Retired products, still billing the customers who are on them. Same
   *  arithmetic, shown separately because they are not on sale. */
  legacy: PricingPlan[];
  rates: { creditUsd: number; clipUsd: number; storageUsdPerGb: number; imageUsd: number; ttsUsdPerMillion: number | null };
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const clipUsd = GENAIPRO_USD_PER_MILLION_CLIPS / 1e6;
  const imageUsd = FREE_IMAGE_CREDITS * USD_PER_CREDIT;

  // getAllPlans, not getPlans: the retired products are the point of the second
  // table, and getPlans drops them.
  const all = (await getAllPlans()).sort((a, b) => a.sortOrder - b.sortOrder);

  const build = async (p: (typeof all)[number]): Promise<PricingPlan> => {
    const tier = tierForPlan(p.slug);
    // A yearly plan divided to a month, so every row compares against the same
    // period. Founder is $40 once a year, which is $3.33 a month of revenue
    // against allowances granted monthly.
    const annualised = /year|yr|annual/i.test(p.periodDisplay ?? "");
    const price = ((p.priceCents ?? 0) / 100) / (annualised ? 12 : 1);

    const credits = await packCreditsForTier(tier);
    const clips = cap("genaipro_video_credits", tier);
    const gb = cap("storage_bytes", tier);
    const chars = cap("ai33_tts_chars", tier);
    const images = FREE_IMAGES[tier] ?? 0;

    const cogs: PricingLine[] = [
      { label: "Heclus credits", qty: `${credits.toLocaleString()} cr`, usd: credits * USD_PER_CREDIT },
      { label: "Free video credits", qty: `${clips} clips`, usd: clips * clipUsd },
      { label: "Free images", qty: `${images} images`, usd: images * imageUsd },
      { label: "Asset storage", qty: gb < 0 ? "unlimited" : `${gb} GB`, usd: Math.max(0, gb) * R2_USD_PER_GB },
      {
        label: "Free voiceover",
        qty: `${(chars / 1000).toLocaleString()}k chars`,
        usd: AI33_TTS_USD_PER_MILLION_CHARS ? chars * (AI33_TTS_USD_PER_MILLION_CHARS / 1e6) : 0,
      },
    ];
    const fees: PricingLine[] = FEES.map((f) => ({
      label: f.label, qty: `${(f.rate * 100).toFixed(0)}%`, usd: price * f.rate,
    }));

    const cogsTotal = cogs.reduce((a, l) => a + l.usd, 0);
    const feesTotal = fees.reduce((a, l) => a + l.usd, 0);
    const total = cogsTotal + feesTotal;
    return {
      slug: p.slug, name: p.name, tier, price, annualised,
      cogs, fees, cogsTotal, feesTotal,
      total, net: price - total,
      marginPct: price > 0 ? (100 * (price - total)) / price : 0,
    };
  };

  const onSale = all.filter((p) => p.slug.startsWith("heclus_"));
  // Everything retired, minus the $1 production-test product, which is a QA
  // fixture rather than something a customer is on.
  const retired = all.filter((p) => p.legacy && p.slug !== "production-test");
  const plans = await Promise.all(onSale.map(build));
  const legacy = await Promise.all(retired.map(build));

  return NextResponse.json({
    plans,
    legacy,
    rates: {
      creditUsd: USD_PER_CREDIT, clipUsd, storageUsdPerGb: R2_USD_PER_GB,
      imageUsd, ttsUsdPerMillion: AI33_TTS_USD_PER_MILLION_CHARS,
    },
  } satisfies PricingReport);
}
