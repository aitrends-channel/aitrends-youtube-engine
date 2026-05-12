import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getAppUrl } from "@/lib/utils";

export async function POST(request: Request) {
  const body = await request.json();

  const email = (body.email ?? "").trim().toLowerCase();
  const firstName = body.first_name?.trim();
  const lastName = body.last_name?.trim();

  // if email is missing or not a string, return an error
  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const appUrl = getAppUrl(request);

  const { error } = await supabase.auth.admin.inviteUserByEmail(email, {
    data: {
      first_name: firstName,
      last_name: lastName,
      full_name: `${firstName ?? ""} ${lastName ?? ""}`.trim(),
    },
    redirectTo: `${appUrl}/auth/callback?next=/set-password`,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ success: true, message: "Signup email sent" });
}
