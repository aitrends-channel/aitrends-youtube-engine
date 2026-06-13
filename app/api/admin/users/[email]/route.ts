import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { isAdminEmail, isAdminUser } from "@/lib/admin";
import { requireAdmin } from "@/lib/admin-server";

export async function DELETE(
  _req: Request,
  { params }: { params: { email: string } }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { email } = params;
  const decoded = decodeURIComponent(email).toLowerCase().trim();

  // Block removal of admin accounts — both the legacy hardcoded
  // admin and any user with app_metadata.is_admin = true. Looking up
  // the target's auth row catches data-driven admins; the email
  // check is a fast-path for the founder admin so a deleteUser race
  // can't slip through.
  if (isAdminEmail(decoded)) {
    return NextResponse.json({ error: "Cannot remove admin account" }, { status: 400 });
  }
  const { data: lookupData } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const targetUser = lookupData?.users.find((u) => u.email?.toLowerCase() === decoded);
  if (targetUser && isAdminUser(targetUser)) {
    return NextResponse.json({ error: "Cannot remove admin account" }, { status: 400 });
  }

  const { error } = await supabase.from("allowed_emails").delete().eq("email", decoded);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Delete the auth user entirely (cascades projects and account_settings).
  // Reuse the listUsers result from the admin-status check above —
  // no need to re-fetch.
  if (targetUser) {
    await supabase.auth.admin.deleteUser(targetUser.id);
  }

  return NextResponse.json({ success: true });
}
