import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-server";
import { supabase } from "@/lib/supabase/client";
import { USD_PER_CREDIT } from "@/lib/pricing";
import {
  reconcileDrawdown, drawdownIsMeaningful, latestCreditPrices, detectLastTopUp,
  readProviderBalances, DRAWDOWN_THRESHOLD,
  type DrawdownFinding, type CreditPrice, type TrackedProvider,
} from "@/lib/providers/drawdown";

// The two things about KIE and PoYo that nothing else can answer.
//
// GET reports whether each account fell by what we recorded spending, and what
// a credit was last confirmed to cost. POST records a confirmation.
//
// Both halves read the same balance series. A drop is spend we can check our
// ledger against; a rise is a top-up, which is the credits half of a price and
// the only way USD_PER_CREDIT can be verified at all.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROVIDERS: TrackedProvider[] = ["kie", "poyo"];

export interface DrawdownReport {
  /** What the wallet converts a provider credit at today, for comparison. */
  billedUsdPerCredit: number;
  threshold: number;
  findings: DrawdownFinding[];
  /** Which findings the window is actually strong enough to act on. */
  meaningful: string[];
  prices: CreditPrice[];
  /** The largest unexplained balance rise per provider, offered as the credits
   *  half of a confirmation so the number does not have to be remembered. */
  detectedTopUps: Array<{ provider: string; credits: number; at: string }>;
  /** Live balances, so a report with no series yet still says something. */
  balances: Array<{ provider: string; credits: number | null; problem?: string }>;
  problems: string[];
  /** False when migration 141 has not been applied. */
  schema: boolean;
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  // Migration 141 may not be applied yet, and the honest answer then is "the
  // table is missing", not an empty report that reads as "no gaps found".
  const probe = await supabase.from("provider_balances").select("id").limit(1);
  if (probe.error) {
    return NextResponse.json({
      billedUsdPerCredit: USD_PER_CREDIT,
      threshold: DRAWDOWN_THRESHOLD,
      findings: [], meaningful: [], prices: [], detectedTopUps: [],
      balances: await readProviderBalances(),
      problems: [`Migration 141 is not applied: ${probe.error.message}`],
      schema: false,
    } satisfies DrawdownReport);
  }

  const [{ findings, problems }, prices, balances, ...topUps] = await Promise.all([
    reconcileDrawdown(30),
    latestCreditPrices(),
    readProviderBalances(),
    ...PROVIDERS.map((p) => detectLastTopUp(p, 60).then((t) => ({ provider: p, top: t }))),
  ]);

  return NextResponse.json({
    billedUsdPerCredit: USD_PER_CREDIT,
    threshold: DRAWDOWN_THRESHOLD,
    findings,
    meaningful: findings.filter(drawdownIsMeaningful).map((f) => f.provider),
    prices,
    detectedTopUps: topUps
      .filter((t) => t.top !== null)
      .map((t) => ({ provider: t.provider, credits: t.top!.credits, at: t.top!.at })),
    balances,
    problems,
    schema: true,
  } satisfies DrawdownReport);
}

export interface CreditPricePatch {
  provider: string;
  credits: number | string;
  usdPaid: number | string;
  note?: string | null;
}

/** Record what a top-up actually cost, which is the only way the dollar value of
 *  a provider credit can be confirmed. */
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: CreditPricePatch;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const provider = String(body.provider ?? "").trim().toLowerCase();
  if (!PROVIDERS.includes(provider as TrackedProvider)) {
    return NextResponse.json({ error: `provider must be one of ${PROVIDERS.join(", ")}` }, { status: 400 });
  }
  const credits = Number(body.credits);
  const usdPaid = Number(body.usdPaid);
  if (!Number.isFinite(credits) || credits <= 0) {
    return NextResponse.json({ error: "credits must be a positive number" }, { status: 400 });
  }
  if (!Number.isFinite(usdPaid) || usdPaid <= 0) {
    return NextResponse.json({ error: "usdPaid must be a positive number" }, { status: 400 });
  }

  const usdPerCredit = usdPaid / credits;
  const { error } = await supabase.from("provider_credit_prices").insert({
    provider,
    credits,
    usd_paid: usdPaid,
    usd_per_credit: usdPerCredit,
    note: (body.note ?? "").trim() || null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Stated rather than silently stored: this is the number every dollar figure
  // in the wallet rests on, and a reader should see immediately whether it
  // agrees with what the code bills at.
  const drift = usdPerCredit / USD_PER_CREDIT - 1;
  return NextResponse.json({
    ok: true,
    provider,
    usdPerCredit,
    billedUsdPerCredit: USD_PER_CREDIT,
    drift,
    // Not applied automatically. USD_PER_CREDIT is a code constant shared by
    // both providers, so changing it from one receipt would reprice the other
    // as a side effect.
    action: Math.abs(drift) >= 0.02
      ? `USD_PER_CREDIT is $${USD_PER_CREDIT} and this receipt says $${usdPerCredit.toFixed(5)}, `
        + `${(drift * 100).toFixed(0)}% out. Every dollar figure in the wallet reads off that constant.`
      : "Matches what the wallet bills at.",
  });
}
