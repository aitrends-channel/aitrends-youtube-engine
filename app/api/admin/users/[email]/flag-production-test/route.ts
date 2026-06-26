import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { isProductionTestUser } from "@/lib/admin";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

/**
 * Flag a user as a production-test account by setting
 * app_metadata.is_production_test = true. Flagged accounts are the
 * only ones that see the production-test plan card in the
 * SubscriptionModal, which exists so internal QA can run a real live
 * Dodo charge from a production deployment without exposing that
 * card to customers.
 *
 * Idempotent: re-running on an already-flagged user returns
 * alreadyFlagged. Other app_metadata fields are preserved.
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

  const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
  const targetUser = listData?.users.find((u) => u.email?.toLowerCase() === decoded);
  if (!targetUser) {
    return NextResponse.json({ error: "User not found — they must sign in at least once before being flagged" }, { status: 404 });
  }

  if (isProductionTestUser(targetUser)) {
    return NextResponse.json({ ok: true, alreadyFlagged: true });
  }

  const nextMeta = {
    ...(targetUser.app_metadata ?? {}),
    is_production_test: true,
  };
  const { error: updErr } = await supabase.auth.admin.updateUserById(targetUser.id, {
    app_metadata: nextMeta,
  });
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, alreadyFlagged: false });
}
