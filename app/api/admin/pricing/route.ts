export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-server";
import { getAllPlans } from "@/lib/plans";
import { packCreditsForTier } from "@/lib/heclus-credits";
import { tierForPlan } from "@/lib/plans-gating";
import { QUOTA_DEFAULTS, GENAIPRO_USD_PER_MILLION_CLIPS, AI33_TTS_USD_PER_MILLION_CHARS, FREE_IMAGE_USD_PER_MILLION } from "@/lib/quota-config";
import { USD_PER_CREDIT } from "@/lib/credit-unit";
import { DODO_FEE_PERCENT, DODO_FEE_FIXED_CENTS } from "@/lib/dodo/fees";
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

/** The Government of Ghana levy on bank withdrawals of funds received by wire.
 *  It lands when money is taken out rather than when a customer pays, so it is
 *  charged here against what Dodo actually sends us: we cannot withdraw their
 *  fee. Assuming everything received is eventually withdrawn is the
 *  conservative reading and the only one that can be modelled per plan. */
const GOG_RATE = 0.05;

/**
 * What the payment processor and the bank take, as a slice of the price rather
 * than of usage.
 *
 * Dodo charges per transaction, not per month, and the fixed part is the half
 * that matters: 4% + $0.40 on a $21 plan is 5.9%, on a $39 plan 5.0%, and on
 * Founder's one $40 charge a year it is 4.1% — the same 40c spread over twelve
 * months of allowances rather than charged twelve times. A flat percentage
 * (this list said 10%) cannot say any of that, and said it wrong in both
 * directions: too high on every monthly plan, and it hid that the small ones
 * are the expensive ones to collect.
 *
 * Tax is not here on purpose. Dodo is the merchant of record, so VAT and sales
 * tax are collected on top of the price and remitted by them; they are never
 * ours and never in the settlement amount.
 */
/**
 * Tax, as a share of the price.
 *
 * Dodo is the merchant of record, so sales tax and VAT are theirs to collect
 * and remit. Where it lands differs by jurisdiction: usually it is added on top
 * of the price and the settlement arrives whole, which costs us nothing, and
 * sometimes the settlement arrives tax-inclusive and that part of it was never
 * ours.
 *
 * Held at 10% as the planning assumption. The payments to date measure lower —
 * 27 of 133 arrived tax-inclusive, 16.5% of those, 3.4% of everything settled —
 * but that mix is one quarter of one product's customers, and a margin table
 * that assumes the cheap end of a range is a table that flatters itself.
 */
const TAX_RATE = 0.10;

function feesFor(price: number, annualised: boolean): PricingLine[] {
  // One charge per billing period, and the period is a year for Founder.
  const perPeriodPrice = price * (annualised ? 12 : 1);
  const dodoPerCharge = perPeriodPrice * DODO_FEE_PERCENT + DODO_FEE_FIXED_CENTS / 100;
  const dodo = dodoPerCharge / (annualised ? 12 : 1);
  const tax = price * TAX_RATE;
  const received = Math.max(0, price - dodo - tax);
  return [
    // Everything Dodo takes, in one line: the tax they remit and the fee they
    // keep. Two columns for one counterparty made the table wider without
    // making it clearer, and the split is in the label.
    {
      label: "Dodo",
      qty: `${(TAX_RATE * 100).toFixed(0)}% tax + ${(DODO_FEE_PERCENT * 100).toFixed(0)}% + $${(DODO_FEE_FIXED_CENTS / 100).toFixed(2)}`
        + (annualised ? " a year" : ""),
      usd: tax + dodo,
    },
    { label: "GOG", qty: `${(GOG_RATE * 100).toFixed(0)}% of what lands`, usd: received * GOG_RATE },
  ];
}

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
  const imageUsd = FREE_IMAGE_USD_PER_MILLION / 1e6;

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
    const images = cap("free_image_credits", tier);

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
    const fees = feesFor(price, annualised);

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
