import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

// Return the full conversation for a ticket, oldest first. Combines:
//
//   • The original in-app submission (from support_tickets) as a
//     synthetic first message — keeps "the customer's first words"
//     in the same scroll, even though it never went over SMTP.
//   • Every email row whose subject contains the ticket's [HS##]
//     reference. Captures both directions: outbound admin replies
//     (sent via /api/admin/support-tickets/:id/reply) and inbound
//     customer replies (pulled in by the IMAP sync into the emails
//     table). The [HS##] convention is the only correlation key —
//     the customer's mail client keeps it in the subject when they
//     hit Reply, so the thread chain is preserved without us
//     having to track conversation IDs separately.

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const ticketId = params.id;
  if (!ticketId) return NextResponse.json({ error: "Missing ticket id" }, { status: 400 });

  const { data: ticket, error: ticketErr } = await supabase
    .from("support_tickets")
    .select("id, ticket_number, email, subject, message, created_at, plan")
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketErr) return NextResponse.json({ error: ticketErr.message }, { status: 500 });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  const ref = `HS${String(ticket.ticket_number).padStart(2, "0")}`;
  const { data: emails, error: emailsErr } = await supabase
    .from("emails")
    .select("id, direction, from_address, to_addresses, subject, body_text, body_html, sent_at, message_id, in_reply_to")
    .ilike("subject", `%[${ref}]%`)
    .order("sent_at", { ascending: true, nullsFirst: false });
  if (emailsErr) return NextResponse.json({ error: emailsErr.message }, { status: 500 });

  return NextResponse.json({
    ticket: {
      id: ticket.id,
      ticket_number: ticket.ticket_number,
      ref,
      email: ticket.email,
      subject: ticket.subject,
      message: ticket.message,
      created_at: ticket.created_at,
      plan: ticket.plan,
    },
    emails: emails ?? [],
  });
}
