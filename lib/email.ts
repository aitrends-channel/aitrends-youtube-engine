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
  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev",
    to,
    subject: "Complete your Heclus account setup",
    html: `
      <p>You've been invited to <strong>Heclus</strong>.</p>
      <p>Click the link below to set your password and activate your account:</p>
      <p><a href="${inviteLink}" style="font-size:1.05em">Set up your account</a></p>
      <p style="color:#888;font-size:0.9em">This link expires in 24 hours.</p>
    `,
  });
}

export async function sendTempPasswordEmail(to: string, tempPassword: string) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
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
}
