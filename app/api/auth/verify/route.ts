export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  const jwt = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!jwt) return NextResponse.json({ error: "Missing token" }, { status: 401 });

  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });

  const paid = user.app_metadata?.paid === true;

  return NextResponse.json({
    paid,
    email: user.email,
    user_id: user.id,
    paid_at: user.app_metadata?.paid_at ?? null,
  });
}
