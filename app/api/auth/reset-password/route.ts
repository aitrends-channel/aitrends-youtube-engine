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
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your Heclus password</title>
</head>
<body style="margin:0;padding:0;background-color:#080808;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#080808;min-height:100vh;">
    <tr>
      <td align="center" valign="top" style="padding:48px 16px 64px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
          <tr>
            <td align="center" style="padding-bottom:36px;">
              <img src="https://app.heclus.io/heclus-icon.png" alt="Heclus" width="52" height="52"
                style="display:block;border-radius:12px;" />
              <p style="margin:14px 0 0;font-size:15px;font-weight:700;color:#c8c8c8;letter-spacing:0.3px;text-transform:uppercase;">
                Heclus
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#111111;border-radius:20px;border:1px solid rgba(255,255,255,0.07);overflow:hidden;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="height:3px;background:linear-gradient(90deg,#7c5cbf,#9b7ff5,#7c5cbf);font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:40px 40px 36px;">
                    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#ebebeb;letter-spacing:-0.4px;line-height:1.3;">
                      Reset your password
                    </p>
                    <p style="margin:0 0 32px;font-size:14px;color:#777;line-height:1.7;">
                      You requested a password reset for your Heclus account. Click the button below to choose a new password.
                    </p>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
                      <tr><td style="height:1px;background-color:rgba(255,255,255,0.06);font-size:0;line-height:0;">&nbsp;</td></tr>
                    </table>
                    <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
                      <tr>
                        <td align="center" style="border-radius:12px;background-color:#8b6cf7;box-shadow:0 4px 24px rgba(139,108,247,0.35);">
                          <a href="${resetLink}"
                            style="display:inline-block;padding:14px 36px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.1px;border-radius:12px;">
                            Reset password &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
                      <tr><td style="height:1px;background-color:rgba(255,255,255,0.06);font-size:0;line-height:0;">&nbsp;</td></tr>
                    </table>
                    <p style="margin:0 0 6px;font-size:12px;font-weight:500;color:#555;text-transform:uppercase;letter-spacing:0.5px;">
                      Or paste this link in your browser
                    </p>
                    <p style="margin:0;font-size:11px;color:#444;word-break:break-all;line-height:1.6;font-family:'Courier New',Courier,monospace;">
                      ${resetLink}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:32px;">
              <p style="margin:0 0 6px;font-size:12px;color:#3a3a3a;line-height:1.7;">
                This link expires in <strong style="color:#444;">1 hour</strong>. If you didn&rsquo;t request this, you can safely ignore this email.
              </p>
              <p style="margin:0;font-size:11px;color:#2e2e2e;">
                &copy; 2025 Heclus &nbsp;&middot;&nbsp; <a href="https://heclus.io" style="color:#444;text-decoration:none;">heclus.io</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  });

  if (emailError) {
    console.error("[reset-password] Resend failed:", emailError);
    return NextResponse.json({ error: emailError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
