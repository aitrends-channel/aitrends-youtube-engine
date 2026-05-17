import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getAppUrl } from "@/lib/utils";
import { sendInviteEmail } from "@/lib/email";

export async function POST(request: Request) {
  const body = await request.json();

  const email = (body.email ?? "").trim().toLowerCase();
  const firstName = body.first_name?.trim();
  const lastName = body.last_name?.trim();

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const appUrl = getAppUrl(request);

  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: "invite",
    email,
    options: {
      data: {
        first_name: firstName,
        last_name: lastName,
        full_name: `${firstName ?? ""} ${lastName ?? ""}`.trim(),
      },
      redirectTo: `${appUrl}/set-password`,
    },
  });

  if (linkError) {
    return NextResponse.json({ error: linkError.message }, { status: 400 });
  }

  try {
    await sendInviteEmail(email, linkData.properties.action_link);
  } catch (err) {
    console.error("[signup] email send failed:", (err as Error).message);
    return NextResponse.json({ error: "Failed to send invite email" }, { status: 500 });
  }

  return NextResponse.json({ success: true, message: "Signup email sent" });
}
