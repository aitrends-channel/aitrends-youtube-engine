import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  const jwt = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!jwt) {
    return NextResponse.json({ error: "Missing token" }, { status: 401 });
  }

  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  const metadata = user.app_metadata ?? {};
  return NextResponse.json({
    user_id: user.id,
    email: user.email,
    paid: metadata.paid === true,
    paid_at: metadata.paid_at ?? null,
    plan: metadata.plan ?? null,
    subscription_code: metadata.paystack?.subscription_code ?? null,
    status: metadata.paystack?.status ?? null,
    paystack: metadata.paystack ?? null,
  });
}
