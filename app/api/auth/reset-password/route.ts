import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { Resend } from "resend";
import { getAppUrl } from "@/lib/utils";

export async function POST(request: Request) {
  const body = await request.json();
  const email = (body.email ?? "").trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const appUrl = getAppUrl(request);
  const redirectTo = `${appUrl}/auth/callback?next=/set-password&reset=true`;

  const { data, error } = await supabase.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo },
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const resetLink = data.properties.action_link;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error: emailError } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev",
    to: email,
    subject: "Reset your Heclus password",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
        <h2 style="margin:0 0 16px;font-size:20px;font-weight:700">Reset your password</h2>
        <p style="margin:0 0 24px;font-size:15px;color:#444">
          You requested a password reset for your <strong>Heclus</strong> account.
          Click the button below to choose a new password.
        </p>
        <a href="${resetLink}"
          style="display:inline-block;padding:12px 28px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
          Reset password
        </a>
        <p style="margin:24px 0 4px;font-size:13px;color:#888">
          Or copy and paste this URL into your browser:
        </p>
        <p style="margin:0;font-size:12px;word-break:break-all;color:#666">${resetLink}</p>
        <p style="margin:24px 0 0;font-size:12px;color:#aaa">
          This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email.
        </p>
      </div>
    `,
  });

  if (emailError) {
    console.error("[reset-password] Resend failed:", emailError);
    return NextResponse.json({ error: emailError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
