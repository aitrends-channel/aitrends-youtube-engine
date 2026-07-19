import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { isAdminEmail, isAdminUser } from "@/lib/admin";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

// Admin action: flag a NON-admin user's subscription state so the app's
// paywall/expiry gating (subscriptionExpired in lib/subscription) treats
// them accordingly. Body: { status: "paid" | "expired" | "demo" }.
//   paid    → active subscriber: paid=true + a future plan_expires_at.
//   expired → ex-subscriber whose period lapsed: paid=false, everSubscribed
//             (paid_at set) + a past plan_expires_at → subscriptionExpired.
//   demo    → never-subscribed free/demo: clears all subscription markers.
export async function POST(
  req: Request,
  { params }: { params: { email: string } }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const decoded = decodeURIComponent(params.email).toLowerCase().trim();
  if (!decoded) return NextResponse.json({ error: "Email is required" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { status?: string };
  const status = body.status;
  if (status !== "paid" && status !== "expired" && status !== "demo") {
    return NextResponse.json({ error: "status must be 'paid', 'expired', or 'demo'" }, { status: 400 });
  }

  const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
  const targetUser = listData?.users.find((u) => u.email?.toLowerCase() === decoded);
  if (!targetUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Only non-admins — admins bypass the paywall, so a subscription flag
  // is meaningless (and would fight the is_admin gate).
  if (isAdminEmail(decoded) || isAdminUser(targetUser)) {
    return NextResponse.json({ error: "Can't set a subscription state on an admin account" }, { status: 400 });
  }

  const meta = (targetUser.app_metadata ?? {}) as Record<string, unknown>;
  const nowIso = new Date().toISOString();
  const in30dIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const yesterdayIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const existingPlan = typeof meta.plan === "string" && meta.plan !== "demo" ? meta.plan : "starter";
  const existingPaidAt = typeof meta.paid_at === "string" ? meta.paid_at : nowIso;

  let patch: Record<string, unknown>;
  if (status === "paid") {
    patch = { paid: true, paid_at: existingPaidAt, plan_expires_at: in30dIso, plan: existingPlan };
  } else if (status === "expired") {
    patch = { paid: false, paid_at: existingPaidAt, plan_expires_at: yesterdayIso, plan: existingPlan };
  } else {
    // demo/free — clear every "ever subscribed" marker so subscriptionExpired
    // returns false (governed by demo/free caps, not the expiry gate).
    patch = { paid: false, paid_at: null, plan_expires_at: null, plan: "demo", dodo: null };
  }

  const { error: updErr } = await supabase.auth.admin.updateUserById(targetUser.id, {
    app_metadata: { ...meta, ...patch },
  });
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, status });
}
