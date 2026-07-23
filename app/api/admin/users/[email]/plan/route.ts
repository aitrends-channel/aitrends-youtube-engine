import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { isAdminEmail, isAdminUser } from "@/lib/admin";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

// Admin action: switch a NON-admin user's paid plan tier. Body:
// { plan: "starter" | "pro" | "founder" }. Setting a tier makes the
// user an active subscriber on that plan (mirrors the "paid" branch of
// ./subscription): paid=true + a future plan_expires_at, with plan set
// to the chosen slug. Use ./subscription to expire or clear a user.
const ALLOWED_PLANS = new Set(["starter", "pro", "founder"]);

export async function POST(
  req: Request,
  { params }: { params: { email: string } }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const decoded = decodeURIComponent(params.email).toLowerCase().trim();
  if (!decoded) return NextResponse.json({ error: "Email is required" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { plan?: string };
  const plan = typeof body.plan === "string" ? body.plan.toLowerCase().trim() : "";
  if (!ALLOWED_PLANS.has(plan)) {
    return NextResponse.json(
      { error: "plan must be 'starter', 'pro', or 'founder'" },
      { status: 400 }
    );
  }

  const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
  const targetUser = listData?.users.find((u) => u.email?.toLowerCase() === decoded);
  if (!targetUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Only non-admins — admins bypass the paywall, so a plan tier is
  // meaningless (and would fight the is_admin gate).
  if (isAdminEmail(decoded) || isAdminUser(targetUser)) {
    return NextResponse.json({ error: "Can't set a plan on an admin account" }, { status: 400 });
  }

  const meta = (targetUser.app_metadata ?? {}) as Record<string, unknown>;
  const nowIso = new Date().toISOString();
  const in30dIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const existingPaidAt = typeof meta.paid_at === "string" ? meta.paid_at : nowIso;

  // Switching to a paid tier => active subscriber on that plan.
  const patch = { paid: true, paid_at: existingPaidAt, plan_expires_at: in30dIso, plan };

  const { error: updErr } = await supabase.auth.admin.updateUserById(targetUser.id, {
    app_metadata: { ...meta, ...patch },
  });
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, plan });
}
