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
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>You're invited to Heclus</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">

        <!-- Logo -->
        <tr><td align="center" style="padding-bottom:32px;">
          <img src="https://www.heclus.io/logo.jpeg" alt="Heclus" width="56" height="56"
            style="border-radius:50%;display:block;"/>
          <p style="margin:12px 0 0;font-size:18px;font-weight:700;color:#e8e8e8;letter-spacing:-0.3px;">Heclus</p>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#141414;border-radius:16px;border:1px solid rgba(255,255,255,0.08);padding:36px 32px;">

          <h1 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#e8e8e8;letter-spacing:-0.3px;">
            Welcome to Heclus
          </h1>
          <p style="margin:0 0 28px;font-size:14px;color:#888;line-height:1.6;">
            Your account is ready. Set your password to get started.
          </p>

          <!-- CTA Button -->
          <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
            <tr><td align="center" style="border-radius:10px;background:#8b6cf7;">
              <a href="${inviteLink}"
                style="display:inline-block;padding:13px 32px;font-size:14px;font-weight:600;color:#0a0a0a;text-decoration:none;letter-spacing:-0.1px;">
                Set up your account
              </a>
            </td></tr>
          </table>

          <!-- Fallback link -->
          <p style="margin:0 0 4px;font-size:12px;color:#555;">Or copy this link into your browser:</p>
          <p style="margin:0;font-size:11px;color:#666;word-break:break-all;line-height:1.5;">${inviteLink}</p>

        </td></tr>

        <!-- Footer -->
        <tr><td align="center" style="padding-top:24px;">
          <p style="margin:0;font-size:12px;color:#444;line-height:1.6;">
            This link expires in 24 hours. If you didn't request this, you can safely ignore this email.
          </p>
          <p style="margin:8px 0 0;font-size:12px;color:#333;">© 2025 Heclus</p>
        </td></tr>

      </table>
    </td></tr>
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
