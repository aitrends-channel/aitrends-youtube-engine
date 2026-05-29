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

  const isFounder = plan === "founder";

  // For Founder claims, defend against a user paying for a cheaper plan
  // and then asking us to mark them as Founder. Dodo reports amounts in
  // the smallest currency unit (cents). Founder is $40 → 4000 cents.
  if (isFounder) {
    const paidCents = Number(result.total_amount ?? result.amount ?? 0);
    const FOUNDER_PRICE_CENTS = Number(process.env.DODO_FOUNDER_PRICE_CENTS ?? 4000);
    if (paidCents > 0 && paidCents < FOUNDER_PRICE_CENTS) {
      return NextResponse.json(
        { error: `Paid amount (${paidCents}) is below the Founder price (${FOUNDER_PRICE_CENTS}).` },
        { status: 400 },
      );
    }

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
