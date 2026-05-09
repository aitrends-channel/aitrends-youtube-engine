import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";

export async function POST(request: Request) {
  let user;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await request.json().catch(() => ({}));
  const { reference } = body as { reference?: string };
  if (!reference) {
    return NextResponse.json({ error: "Missing reference" }, { status: 400 });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json({ error: "Payment not configured" }, { status: 500 });
  }

  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });

  if (!res.ok) {
    return NextResponse.json({ error: "Verification request failed" }, { status: 502 });
  }

  const result = await res.json();

  if (result.data?.status !== "success") {
    return NextResponse.json({ error: "Payment not successful" }, { status: 400 });
  }

  await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...user.app_metadata,
      paid: true,
      paid_at: new Date().toISOString(),
    },
  });

  return NextResponse.json({ success: true });
}
