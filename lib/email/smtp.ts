import nodemailer from "nodemailer";
import { supabase } from "@/lib/supabase/client";

/**
 * SMTP sender backed by Hostinger.
 *
 * Reads HOSTINGER_SMTP_HOST/PORT/USER/PASS from env. The user is the
 * primary mailbox (support@heclus.com); aliases on the same mailbox
 * (info@heclus.com etc.) can still be used as the "from" address —
 * Hostinger allows that on the same authenticated session.
 *
 * Every successful send writes a copy of the message to the emails
 * table so the dashboard renders it next to inbox mail without
 * having to re-fetch sent items from IMAP later.
 */

interface SendArgs {
  from: string;           // e.g. "support@heclus.com" or "info@heclus.com"
  to: string | string[];
  cc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  // For threaded replies. We set both In-Reply-To and References so
  // most clients build the thread correctly. inReplyTo is the
  // Message-ID of the parent (with angle brackets).
  inReplyTo?: string;
}

let cachedTransport: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter {
  if (cachedTransport) return cachedTransport;

  const host = process.env.HOSTINGER_SMTP_HOST;
  const portRaw = process.env.HOSTINGER_SMTP_PORT;
  const user = process.env.HOSTINGER_SMTP_USER;
  const pass = process.env.HOSTINGER_SMTP_PASS;

  if (!host || !portRaw || !user || !pass) {
    throw new Error("Hostinger SMTP env not configured (HOSTINGER_SMTP_HOST/PORT/USER/PASS).");
  }
  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    throw new Error(`HOSTINGER_SMTP_PORT must be a number, got ${portRaw}`);
  }

  // Port 465 = implicit SSL (secure: true). Port 587 = STARTTLS
  // (secure: false, server upgrades after EHLO). Hostinger documents
  // 465 by default; we honor whatever the env says.
  cachedTransport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return cachedTransport;
}

/**
 * Send an email and log a copy to the emails table.
 *
 * Throws on SMTP failure so the API route can return a proper 500
 * with the error message. The DB insert is fail-soft — if it errors
 * (migration not applied, etc.) we still consider the send a
 * success because the email actually went out; we just log a warning.
 */
export async function sendEmail(args: SendArgs): Promise<{ messageId: string }> {
  const transport = getTransport();

  const result = await transport.sendMail({
    from: args.from,
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    text: args.text,
    html: args.html,
    inReplyTo: args.inReplyTo,
    // If we have an In-Reply-To, mirror it into References too. Some
    // clients only thread off References; doing both maximizes the
    // chance a reply lands in the original conversation.
    references: args.inReplyTo,
  });

  const messageId = result.messageId;
  if (!messageId) {
    throw new Error("SMTP send returned no Message-ID");
  }

  // Persist a copy for the dashboard's Sent view. Fail-soft.
  try {
    const toList = Array.isArray(args.to) ? args.to : [args.to];
    const ccList = args.cc ? (Array.isArray(args.cc) ? args.cc : [args.cc]) : [];
    const { error } = await supabase.from("emails").insert({
      direction: "outbound",
      message_id: messageId,
      in_reply_to: args.inReplyTo ?? null,
      thread_root_id: args.inReplyTo ?? messageId,
      from_address: args.from,
      to_addresses: toList,
      cc_addresses: ccList,
      subject: args.subject,
      body_text: args.text ?? null,
      body_html: args.html ?? null,
      sent_at: new Date().toISOString(),
      is_read: false,
    });
    if (error) {
      console.warn(`[email/smtp] sent ok but DB insert failed:`, error.message);
    }
  } catch (e) {
    console.warn("[email/smtp] sent ok but DB insert threw:", e instanceof Error ? e.message : e);
  }

  return { messageId };
}
