import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { sendEmail } from "@/lib/email/smtp";

export const dynamic = "force-dynamic";

// Admin reply to a support ticket. Sends an SMTP message from
// support@heclus.com to the customer's email and side-effects the
// ticket: stamp responded_at on first reply, bump status from
// "open" to "in_progress" if it hasn't been touched yet. The
// outbound email is also persisted into the emails table by the
// sendEmail helper, so the admin Emails dashboard already shows
// every reply alongside inbound mail — no extra DB write needed
// here for history.

const SUPPORT_FROM = "support@heclus.com";
const MAX_MESSAGE_LEN = 16_000;

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const ticketId = params.id;
  if (!ticketId) return NextResponse.json({ error: "Missing ticket id" }, { status: 400 });

  let body: { message?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "Please include a reply message." }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return NextResponse.json({ error: `Reply too long — keep it under ${MAX_MESSAGE_LEN} characters.` }, { status: 400 });
  }

  const { data: ticket, error: fetchErr } = await supabase
    .from("support_tickets")
    .select("id, ticket_number, email, subject, status, responded_at")
    .eq("id", ticketId)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  const ref = `HS${String(ticket.ticket_number).padStart(2, "0")}`;
  const subject = `Re: [${ref}] ${ticket.subject}`;

  // Look up the most recent email tied to this ticket (matched by
  // [HS##] in the subject — set on every admin reply and every
  // customer reply that quotes the previous Re: line). Using its
  // message-id as In-Reply-To threads the new reply into the same
  // mail-client conversation, so the customer sees a back-and-forth
  // instead of disconnected one-offs. First reply on a ticket finds
  // nothing here and starts a fresh thread, which is correct — there
  // was no prior message between us and the customer.
  let inReplyTo: string | undefined;
  try {
    const { data: priorEmails } = await supabase
      .from("emails")
      .select("message_id")
      .ilike("subject", `%[${ref}]%`)
      .order("sent_at", { ascending: false, nullsFirst: false })
      .limit(1);
    const lastMessageId = priorEmails?.[0]?.message_id as string | undefined;
    if (lastMessageId) inReplyTo = lastMessageId;
  } catch (e) {
    console.warn(`[support/reply] ticket=${ticketId} threading lookup failed:`, e instanceof Error ? e.message : e);
  }

  // Plain-text reply body. Footer is intentionally minimal so the
  // customer sees mostly what the admin typed; the ticket ref lets
  // them keep email threads correlated with the in-app queue.
  const text =
    `${message}\n\n` +
    `--\n` +
    `Heclus Support · Ticket ${ref}\n` +
    `Reply to this email to keep the conversation in the same thread.`;

  try {
    await sendEmail({
      from: SUPPORT_FROM,
      to: ticket.email,
      subject,
      text,
      inReplyTo,
    });
  } catch (e) {
    // Surface the underlying SMTP error to the admin UI — this
    // endpoint is admin-only so leaking error detail is fine and
    // the alternative ("Could not send … try again") is impossible
    // to debug without server log access.
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[support/reply] SMTP send failed:", detail);
    return NextResponse.json(
      { error: `SMTP send failed: ${detail}` },
      { status: 502 },
    );
  }

  // Side-effects on the ticket. Both fields are conditional so a
  // second / third / fifth reply doesn't churn the timestamps or
  // accidentally re-open a resolved ticket.
  const update: Record<string, unknown> = {};
  if (!ticket.responded_at) update.responded_at = new Date().toISOString();
  if (ticket.status === "open") {
    update.status = "in_progress";
    update.is_open = true;
  }
  if (Object.keys(update).length > 0) {
    const { error: updErr } = await supabase
      .from("support_tickets")
      .update(update)
      .eq("id", ticketId);
    if (updErr) {
      console.warn(`[support/reply] reply sent but ticket update failed:`, updErr.message);
    }
  }

  return NextResponse.json({ ok: true });
}
