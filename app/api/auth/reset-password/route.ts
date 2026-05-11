import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { Resend } from "resend";

export async function POST(request: Request) {
  const body = await request.json();
  const email = (body.email ?? "").trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const { origin } = new URL(request.url);
  const appUrl = process.env.APP_URL ?? origin;
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
    subject: "Reset your aiTrends password",
    html: `
      <p>You requested a password reset for your <strong>aiTrends YT Workflow</strong> account.</p>
      <p>
        <a href="${resetLink}" style="display:inline-block;padding:10px 20px;background:#7c3aed;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">
          Reset password
        </a>
      </p>
      <p style="color:#666;font-size:0.9em;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
    `,
  });

  if (emailError) {
    console.error("[reset-password] email send failed:", emailError);
    return NextResponse.json({ error: emailError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
