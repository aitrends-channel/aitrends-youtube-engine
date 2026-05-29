import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";

export async function POST(request: Request) {
  let user;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await request.json().catch(() => ({}));
  const { payment_id, plan } = body as { payment_id?: string; plan?: string };

  if (!payment_id) {
    return NextResponse.json({ error: "Missing payment_id" }, { status: 400 });
  }

  const secretKey = process.env.DODO_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json({ error: "Payment not configured" }, { status: 500 });
  }

  let dodoRes: Response;
  try {
    const dodoBase = process.env.DODO_BASE_URL ?? "https://live.dodopayments.com";
    dodoRes = await fetch(`${dodoBase}/payments/${payment_id}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
  } catch (e) {
    return NextResponse.json({ error: `Dodo fetch failed: ${(e as Error).message}` }, { status: 502 });
  }

  if (!dodoRes.ok) {
    const body = await dodoRes.text().catch(() => "");
    return NextResponse.json({ error: `Dodo API error ${dodoRes.status}: ${body}` }, { status: 502 });
  }

  const result = await dodoRes.json();

  if (result.status !== "succeeded") {
    return NextResponse.json({ error: `Payment not successful (status: ${result.status})` }, { status: 400 });
  }

  // Cross-check the paid amount against the claimed plan's price.
  // Dodo reports amounts in the smallest currency unit (cents).
  // Configurable via env so prices can change without redeploy.
  const paidCents = Number(result.total_amount ?? result.amount ?? 0);
  const PLAN_PRICES_CENTS: Record<string, number> = {
    starter: Number(process.env.DODO_STARTER_PRICE_CENTS ?? 1900),  // $19
    founder: Number(process.env.DODO_FOUNDER_PRICE_CENTS ?? 4000),  // $40
    pro:     Number(process.env.DODO_PRO_PRICE_CENTS ?? 4900),      // $49
  };
  const claimedPlanPrice = PLAN_PRICES_CENTS[plan ?? ""];

  if (paidCents > 0 && claimedPlanPrice > 0 && paidCents < claimedPlanPrice) {
    // Try to identify which plan the amount actually matches — helps support
    // figure out the right correction without spelunking through Dodo logs.
    const actualPlan = Object.entries(PLAN_PRICES_CENTS).find(([, cents]) => paidCents === cents)?.[0];
    return NextResponse.json({
      error: actualPlan
        ? `Plan mismatch: paid amount ($${paidCents / 100}) matches '${actualPlan}', not '${plan}'. Contact support to correct.`
        : `Paid amount ($${paidCents / 100}) is below the '${plan}' price ($${claimedPlanPrice / 100}). Contact support.`,
      paidCents,
      claimedPlan: plan,
      actualPlan: actualPlan ?? null,
    }, { status: 400 });
  }

  const isFounder = plan === "founder";

  if (isFounder) {

    // Atomically claim a Founder spot. Returns NULL if the 100-spot
    // promo is already inactive.
    const { data: claimed, error: claimError } = await supabase
      .rpc("claim_founder_spot")
      .single();

    if (claimError) {
      return NextResponse.json({ error: `Founder claim failed: ${claimError.message}` }, { status: 500 });
    }
    if (claimed === null || typeof claimed !== "number") {
      return NextResponse.json(
        { error: "Founder promo has ended — all spots have been claimed.", promoEnded: true },
        { status: 409 },
      );
    }
  }

  const planExpiry = isFounder
    ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  try {
    await supabase.auth.admin.updateUserById(user.id, {
      app_metadata: {
        ...user.app_metadata,
        paid: true,
        paid_at: new Date().toISOString(),
        plan: plan ?? "pro",
        ...(isFounder && { plan_expires_at: planExpiry }),
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `Failed to update user: ${(e as Error).message}` }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
