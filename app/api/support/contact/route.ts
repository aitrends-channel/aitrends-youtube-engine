import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/smtp";

export const dynamic = "force-dynamic";

// Public support-ticket endpoint. Accepts {email, subject, message}
// from the HelpButton form anywhere in the app (signed in or out)
// and inserts it into the support_tickets table. The admin panel
// reads from the same table to triage the queue.
//
// After the insert succeeds we also fan out an email to the support
// inbox so admins get a real-time nudge (no need to poll the
// dashboard). The email send is fail-soft — if SMTP errors, the
// ticket is still saved and the user gets a successful response;
// admins will see it in the queue regardless.

const MAX_SUBJECT_LEN = 200;
const MAX_MESSAGE_LEN = 8000;
const SUPPORT_INBOX = "support@heclus.com";
const RELAY_FROM    = "info@heclus.com";

export async function POST(req: Request) {
  let body: { email?: unknown; subject?: unknown; message?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const rawSubject = typeof body.subject === "string" ? body.subject.trim() : "";
  const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
  let rawEmail = typeof body.email === "string" ? body.email.trim() : "";

  // Trust the auth email over the client-supplied one when the
  // requester is signed in. Catches typos and prevents impersonation
  // via this endpoint. Anonymous senders keep whatever they typed
  // (validated below).
  let userId: string | null = null;
  try {
    const client = await createSupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    if (user) {
      userId = user.id;
      if (user.email) rawEmail = user.email;
    }
  } catch { /* unauthenticated — keep the typed value */ }

  if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });
  }
  if (!rawSubject) {
    return NextResponse.json({ error: "Please include a subject." }, { status: 400 });
  }
  if (rawSubject.length > MAX_SUBJECT_LEN) {
    return NextResponse.json({ error: `Subject too long — keep it under ${MAX_SUBJECT_LEN} characters.` }, { status: 400 });
  }
  if (!rawMessage) {
    return NextResponse.json({ error: "Please include a message." }, { status: 400 });
  }
  if (rawMessage.length > MAX_MESSAGE_LEN) {
    return NextResponse.json({ error: `Message too long — keep it under ${MAX_MESSAGE_LEN} characters.` }, { status: 400 });
  }

  const { data: inserted, error } = await supabase
    .from("support_tickets")
    .insert({
      user_id: userId,
      email: rawEmail,
      subject: rawSubject,
      message: rawMessage,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[support/contact] insert failed:", error.message);
    return NextResponse.json({ error: "Could not save your ticket right now. Please try again shortly." }, { status: 500 });
  }

  // Notify the support inbox. Fail-soft — the ticket is already in
  // the DB so the user doesn't need to know if SMTP hiccups.
  const ticketId = inserted?.id ?? "(unknown)";
  const emailSubject = `[Ticket ${String(ticketId).slice(0, 8)}] ${rawSubject}`;
  const emailText =
    `New support ticket received via the in-app HelpButton.\n\n` +
    `Ticket ID: ${ticketId}\n` +
    `From:      ${rawEmail}\n` +
    `User ID:   ${userId ?? "(anonymous)"}\n` +
    `Subject:   ${rawSubject}\n\n` +
    `--- Message ---\n` +
    `${rawMessage}\n\n` +
    `--- \n` +
    `Triage and reply from the admin Emails dashboard. The full ticket lives in support_tickets.`;
  try {
    await sendEmail({
      from: RELAY_FROM,
      to: SUPPORT_INBOX,
      subject: emailSubject,
      text: emailText,
    });
  } catch (e) {
    console.warn(
      `[support/contact] ticket=${ticketId} saved but support email failed:`,
      e instanceof Error ? e.message : e,
    );
  }

  return NextResponse.json({ ok: true });
}
