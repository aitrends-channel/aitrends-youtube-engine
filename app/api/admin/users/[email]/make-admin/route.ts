import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { isAdminEmail, isAdminUser } from "@/lib/admin";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

/**
 * Promote a registered user to admin by setting
 * app_metadata.is_admin = true. The lib/admin.ts requireAdmin
 * guard reads that flag on every admin route, so the promoted
 * user gets dashboard access on their next request — no code
 * change, no redeploy.
 *
 * Idempotent: re-running on an already-admin user just returns
 * the current state. Self-promotion is allowed (you must already
 * be admin to hit this endpoint anyway).
 */
export async function POST(
  _req: Request,
  { params }: { params: { email: string } }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const decoded = decodeURIComponent(params.email).toLowerCase().trim();
  if (!decoded) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  // Find the target's auth row. Email lookups via listUsers cap at
  // 1000 — mirrors what the DELETE handler and niche-limit route
  // use, so behavior is consistent across user-targeting endpoints.
  const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
  const targetUser = listData?.users.find((u) => u.email?.toLowerCase() === decoded);
  if (!targetUser) {
    return NextResponse.json({ error: "User not found — they must sign in at least once before being promoted to admin" }, { status: 404 });
  }

  // Fast-path: nothing to do if they already count as admin via the
  // hardcoded list or an existing app_metadata flag.
  if (isAdminEmail(decoded) || isAdminUser(targetUser)) {
    return NextResponse.json({ ok: true, alreadyAdmin: true });
  }

  // Merge into existing app_metadata so other flags (paid, plan,
  // etc.) aren't clobbered. The updateUserById API replaces the
  // metadata object wholesale otherwise.
  const nextMeta = { ...(targetUser.app_metadata ?? {}), is_admin: true };
  const { error: updErr } = await supabase.auth.admin.updateUserById(targetUser.id, {
    app_metadata: nextMeta,
  });
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, alreadyAdmin: false });
}
