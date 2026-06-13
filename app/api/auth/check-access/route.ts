import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/admin";
import type { User } from "@supabase/supabase-js";

export async function POST() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  // Use isAdminUser so promoted admins (app_metadata.is_admin =
  // true via the dashboard's Make admin action) pass this gate
  // along with the legacy hardcoded founder. Without this, a
  // promoted but unpaid admin not in allowed_emails would get
  // signed out by the fallthrough below the moment they tried to
  // open the app.
  if (isAdminUser(user)) {
    return NextResponse.json({ allowed: true });
  }

  if (user.app_metadata?.paid === true) {
    return NextResponse.json({ allowed: true });
  }

  // Fallback: allowed_emails covers the admin account and manually comped users
  const { data } = await supabase
    .from("allowed_emails")
    .select("email")
    .eq("email", user.email!.toLowerCase())
    .maybeSingle();

  if (!data) {
    const serverClient = await createSupabaseServerClient();
    await serverClient.auth.signOut();
    return NextResponse.json({ allowed: false }, { status: 403 });
  }

  return NextResponse.json({ allowed: true });
}
