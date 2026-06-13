export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/admin";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const meta = user.app_metadata ?? {};
  // Admins (legacy hardcoded OR app_metadata.is_admin) display as
  // the "admin" plan regardless of any stored plan string. This
  // covers users who were promoted before make-admin started
  // writing plan="admin" into app_metadata — their stored plan may
  // still read "starter" but the effective display reflects their
  // current role. Also makes the founder admin render as "admin"
  // without needing any backfill.
  const admin = isAdminUser(user);
  const effectivePlan = admin ? "admin" : (meta.plan ?? null);
  const effectivePaid = admin || meta.paid === true;
  return NextResponse.json({
    email: user.email,
    paid: effectivePaid,
    paid_at: meta.paid_at ?? null,
    plan: effectivePlan,
    plan_expires_at: meta.plan_expires_at ?? null,
    is_admin: admin,
  });
}
