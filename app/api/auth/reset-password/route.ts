import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getAppUrl } from "@/lib/utils";

export async function POST(request: Request) {
  const body = await request.json();
  const email = (body.email ?? "").trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const appUrl = getAppUrl(request);
  const redirectTo = `${appUrl}/auth/callback?next=/set-password&reset=true`;

  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
