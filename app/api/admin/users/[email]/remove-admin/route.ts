import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { isAdminEmail } from "@/lib/admin";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

/**
 * Demote an admin user by clearing app_metadata.is_admin. Inverse of
 * the make-admin route — same auth gate, same email-resolution path.
 *
 * Notes:
 *   • Hardcoded ADMIN_EMAILS (lib/admin.ts) can't be demoted through
 *     this endpoint — the email list short-circuits isAdminUser
 *     regardless of metadata. We surface that with a 409 so the UI
 *     can show a clear explanation instead of silently failing.
 *   • Self-demotion is allowed for parity with make-admin. The caller
 *     is admin; if they want to demote themselves, that's their call.
 *   • Other app_metadata fields (paid, plan, paid_at, plan_expires_at)
 *     are intentionally left untouched. We don't know whether this
 *     user originally had a real paid plan that the promotion
 *     overwrote, so leaving paid=true / plan="admin" is safer than
 *     guessing. An admin can clean those up via other tools if
 *     needed; for the typical case (demoted user no longer needs
 *     admin powers but should keep app access), leaving them be is
 *     the right call.
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

  // Hardcoded admins can't be demoted through metadata changes — the
  // legacy email-list path in lib/admin.ts wins. Tell the caller
  // exactly why so they don't think the action silently failed.
  if (isAdminEmail(decoded)) {
    return NextResponse.json(
      { error: "This user is a hardcoded admin in lib/admin.ts and can't be demoted from the dashboard. Remove their entry from ADMIN_EMAILS in code first." },
      { status: 409 },
    );
  }

  const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
  const targetUser = listData?.users.find((u) => u.email?.toLowerCase() === decoded);
  if (!targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const currentMeta = targetUser.app_metadata ?? {};
  const wasAdmin = (currentMeta as { is_admin?: unknown }).is_admin === true;
  if (!wasAdmin) {
    // Already not admin — no-op for idempotency.
    return NextResponse.json({ ok: true, alreadyNotAdmin: true });
  }

  const nextMeta = { ...currentMeta, is_admin: false };
  const { error: updErr } = await supabase.auth.admin.updateUserById(targetUser.id, {
    app_metadata: nextMeta,
  });
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, alreadyNotAdmin: false });
}
