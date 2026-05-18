import { Resend } from "resend";
import { randomBytes } from "crypto";

export function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const b = randomBytes(12);
  const pw = Array.from(b).map((byte) => chars[byte % chars.length]).join("");
  return `${pw.slice(0, 4)}-${pw.slice(4, 8)}-${pw.slice(8, 12)}`;
}

export async function sendInviteEmail(to: string, inviteLink: string) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev",
    to,
    subject: "You're invited to Heclus",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You're invited to Heclus</title>
</head>
<body style="margin:0;padding:0;background-color:#080808;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#080808;min-height:100vh;">
    <tr>
      <td align="center" valign="top" style="padding:48px 16px 64px;">

        <!-- Container -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">

          <!-- Logo block -->
          <tr>
            <td align="center" style="padding-bottom:36px;">
              <img src="https://app.heclus.io/logo.png" alt="Heclus" width="52" height="52"
                style="display:block;border-radius:12px;" />
              <p style="margin:14px 0 0;font-size:15px;font-weight:700;color:#c8c8c8;letter-spacing:0.3px;text-transform:uppercase;">
                Heclus
              </p>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#111111;border-radius:20px;border:1px solid rgba(255,255,255,0.07);overflow:hidden;">

              <!-- Card top accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="height:3px;background:linear-gradient(90deg,#7c5cbf,#9b7ff5,#7c5cbf);font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Card body -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:40px 40px 36px;">

                    <!-- Heading -->
                    <p style="margin:0 0 6px;font-size:22px;font-weight:700;color:#ebebeb;letter-spacing:-0.4px;line-height:1.3;">
                      Welcome to Heclus
                    </p>
                    <p style="margin:0 0 32px;font-size:14px;color:#777;line-height:1.7;">
                      You've been invited to join Heclus. Click the button below to set your password and activate your account.
                    </p>

                    <!-- Divider -->
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
                      <tr><td style="height:1px;background-color:rgba(255,255,255,0.06);font-size:0;line-height:0;">&nbsp;</td></tr>
                    </table>

                    <!-- CTA Button -->
                    <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
                      <tr>
                        <td align="center" style="border-radius:12px;background-color:#8b6cf7;box-shadow:0 4px 24px rgba(139,108,247,0.35);">
                          <a href="${inviteLink}"
                            style="display:inline-block;padding:14px 36px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.1px;border-radius:12px;">
                            Activate my account &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>

                    <!-- Divider -->
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
                      <tr><td style="height:1px;background-color:rgba(255,255,255,0.06);font-size:0;line-height:0;">&nbsp;</td></tr>
                    </table>

                    <!-- Fallback URL -->
                    <p style="margin:0 0 6px;font-size:12px;font-weight:500;color:#555;text-transform:uppercase;letter-spacing:0.5px;">
                      Or paste this link in your browser
                    </p>
                    <p style="margin:0;font-size:11px;color:#444;word-break:break-all;line-height:1.6;font-family:'Courier New',Courier,monospace;">
                      ${inviteLink}
                    </p>

                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:32px;">
              <p style="margin:0 0 6px;font-size:12px;color:#3a3a3a;line-height:1.7;">
                This link expires in <strong style="color:#444;">24 hours</strong>. If you didn&rsquo;t request this, you can safely ignore this email.
              </p>
              <p style="margin:0;font-size:11px;color:#2e2e2e;">
                &copy; 2025 Heclus &nbsp;&middot;&nbsp; <a href="https://www.heclus.io" style="color:#444;text-decoration:none;">www.heclus.io</a>
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
  if (error) throw new Error(error.message);
}

export async function sendTempPasswordEmail(to: string, tempPassword: string) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev",
    to,
    subject: "Your Heclus access",
    html: `
      <p>Your account has been created for <strong>Heclus</strong>.</p>
      <p>
        <strong>Email:</strong> ${to}<br/>
        <strong>Temporary password:</strong> <code style="font-size:1.2em;letter-spacing:0.05em">${tempPassword}</code>
      </p>
      <p>Open the desktop app, log in with these credentials, and you will be prompted to set a permanent password.</p>
    `,
  });
  if (error) throw new Error(error.message);
}
