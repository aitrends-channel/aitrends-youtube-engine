import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";

export async function POST(request: Request) {
  let user;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await request.json().catch(() => ({}));
  const { transaction_id, plan } = body as { transaction_id?: number; plan?: string };

  if (!transaction_id) {
    return NextResponse.json({ error: "Missing transaction_id" }, { status: 400 });
  }

  const secretKey = process.env.FLW_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json({ error: "Payment not configured" }, { status: 500 });
  }

  const res = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });

  if (!res.ok) {
    return NextResponse.json({ error: "Verification request failed" }, { status: 502 });
  }

  const result = await res.json();

  if (result.data?.status !== "successful") {
    return NextResponse.json({ error: "Payment not successful" }, { status: 400 });
  }

  const isFounder = plan === "founder";
  const planExpiry = isFounder
    ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...user.app_metadata,
      paid: true,
      paid_at: new Date().toISOString(),
      plan: plan ?? "pro",
      ...(isFounder && { plan_expires_at: planExpiry }),
    },
  });

  return NextResponse.json({ success: true });
}
