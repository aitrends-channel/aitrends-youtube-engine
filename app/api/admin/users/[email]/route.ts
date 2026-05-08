import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ email: string }> }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  if (user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { email } = await params;
  const decoded = decodeURIComponent(email).toLowerCase().trim();

  if (decoded === ADMIN_EMAIL) {
    return NextResponse.json({ error: "Cannot remove admin account" }, { status: 400 });
  }

  const { error } = await supabase.from("allowed_emails").delete().eq("email", decoded);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Delete the auth user entirely (cascades projects and app_settings)
  const { data: listData } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const authUser = listData?.users.find((u) => u.email?.toLowerCase() === decoded);
  if (authUser) {
    await supabase.auth.admin.deleteUser(authUser.id);
  }

  return NextResponse.json({ success: true });
}
