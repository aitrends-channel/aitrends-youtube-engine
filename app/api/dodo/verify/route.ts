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
    dodoRes = await fetch(`https://api.dodopayments.com/payments/${payment_id}`, {
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
