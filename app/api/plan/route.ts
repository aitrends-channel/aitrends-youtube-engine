export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const meta = user.app_metadata ?? {};
  return NextResponse.json({
    email: user.email,
    paid: meta.paid === true,
    paid_at: meta.paid_at ?? null,
    plan: meta.plan ?? null,
    plan_expires_at: meta.plan_expires_at ?? null,
  });
}
