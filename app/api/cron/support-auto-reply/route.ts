import { NextResponse } from "next/server";
import { withCronRun } from "@/lib/cron/runs";
import { supabase } from "@/lib/supabase/client";
import { sendEmail } from "@/lib/email/smtp";
import { answerSupportQuestion, getSupportAgentConfig } from "@/lib/support-agent/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Backstop for anything nobody answered. Every few minutes it looks for open
// tickets and inbound support email older than the configured grace period with
// no reply of any kind, works out an answer, and — only if switched on — sends
// it.
//
// This is the one place in the app where a model's words reach a customer with
// nobody in between, so the defaults are deliberately timid:
//
//   auto_reply_enabled  false  — does nothing at all until switched on
//   auto_reply_dry_run  true   — once on, it records the draft and still sends
//                                nothing, so you can read a week of what it
//                                WOULD have said before trusting it
//   auto_replied_at            — set on send, and checked first, so a ticket
//                                can never receive two automated replies
//
// It also refuses several classes of ticket outright, before the model is
// consulted: anything the agent says needs a person, anything that looks like
// machine mail, and anything an admin has already touched. A wrong auto-reply
// is worse than a slow human one, and a mail loop is worse than both.

const CRON_SECRET = process.env.CRON_SECRET;

/** Addresses that must never receive an automated reply: replying to a mailer
 *  or an out-of-office is how a two-machine loop starts. */
const NO_REPLY_PATTERN = /(^|[.@_-])(no-?reply|do-?not-?reply|postmaster|mailer-daemon|bounce|notifications?|automated|system)([.@_-]|$)/i;

/** Our own addresses. Replying to ourselves is the other way a loop starts. */
const OWN_ADDRESSES = ["support@heclus.com", "info@heclus.com"];

const SUPPORT_FROM = "support@heclus.com";

/** An inbox accumulates; a ticket queue gets worked. Anything left unanswered
 *  this long was left on purpose, and answering it now reads as a machine
 *  working through a backlog rather than as support. Bounded so switching the
 *  sweep live cannot reply to months of old threads. */
const INBOX_MAX_AGE_HOURS = 72;

interface TicketRow {
  id: string;
  ticket_number: number;
  email: string;
  subject: string;
  message: string;
  status: string;
  created_at: string;
  responded_at: string | null;
  admin_notes: string | null;
  chat_id: string | null;
}

export async function GET(req: Request) {
  if (CRON_SECRET) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return withCronRun("support-auto-reply", async () => {

    const config = await getSupportAgentConfig();
    if (!config.auto_reply_enabled) {
      return NextResponse.json({ ok: true, skipped: "auto_reply_enabled is off" });
    }

    const cutoff = new Date(Date.now() - config.auto_reply_delay_minutes * 60_000).toISOString();

    // Only tickets that have had no response of any kind, are still open, and
    // have never been auto-replied. responded_at covers the admin having replied;
    // status covers an admin having picked it up without replying yet.
    const { data, error } = await supabase
      .from("support_tickets")
      .select("id, ticket_number, email, subject, message, status, created_at, responded_at, admin_notes, chat_id")
      .eq("is_open", true)
      .is("auto_replied_at", null)
      .is("responded_at", null)
      // Nothing is stamped in dry run, so without this the same tickets would be
      // re-diagnosed every few minutes for as long as they stay open. A row that
      // already carries a draft has been looked at; clear it to look again.
      .is("auto_reply_draft", null)
      .eq("status", "open")
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(config.auto_reply_max_per_run);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const tickets = (data ?? []) as TicketRow[];
    const outcomes: { ticket: number; outcome: string }[] = [];

    for (const t of tickets) {
      const address = (t.email ?? "").trim().toLowerCase();

      // Loop guards, before any model call.
      if (!address || !address.includes("@")) {
        await note(t.id, "No usable email address on the ticket.");
        outcomes.push({ ticket: t.ticket_number, outcome: "no address" });
        continue;
      }
      if (NO_REPLY_PATTERN.test(address) || OWN_ADDRESSES.includes(address)) {
        await note(t.id, `Held: ${address} looks like an unattended mailbox, so replying risks a mail loop.`);
        outcomes.push({ ticket: t.ticket_number, outcome: "machine address" });
        continue;
      }
      // An admin who left a note is working the ticket, whatever the status says.
      if (t.admin_notes && t.admin_notes.trim()) {
        await note(t.id, "Held: an admin has already made notes on this ticket.");
        outcomes.push({ ticket: t.ticket_number, outcome: "admin working it" });
        continue;
      }

      let answer;
      try {
        ({ answer } = await answerSupportQuestion({
          email: address,
          question: t.message,
          subject: t.subject,
          channel: "ticket",
        }));
      } catch (e) {
        await note(t.id, `Held: the agent errored — ${e instanceof Error ? e.message : String(e)}`);
        outcomes.push({ ticket: t.ticket_number, outcome: "agent error" });
        continue;
      }

      // The agent's own judgement is a hard gate. Billing, missing causes, angry
      // users and data loss all land here, and none of them should be answered by
      // a machine at all.
      if (answer.needsHuman || !answer.resolved) {
        await supabase.from("support_tickets").update({
          auto_reply_draft: answer.reply,
          auto_reply_note: `Left for a person: ${answer.handoffReason || "the agent was not confident it could resolve this"}.`,
        }).eq("id", t.id);
        outcomes.push({ ticket: t.ticket_number, outcome: "left for a person" });
        continue;
      }

      if (config.auto_reply_dry_run) {
        await supabase.from("support_tickets").update({
          auto_reply_draft: answer.reply,
          auto_reply_note: "Dry run: this is what would have been sent.",
        }).eq("id", t.id);
        outcomes.push({ ticket: t.ticket_number, outcome: "dry run, draft saved" });
        continue;
      }

      // Claim the ticket BEFORE sending. If the send throws after the mail is
      // accepted, a stamped ticket means we never send twice; an unstamped one
      // could be re-sent on the next tick, which is the worse failure.
      const { error: claimErr } = await supabase
        .from("support_tickets")
        .update({ auto_replied_at: new Date().toISOString(), auto_reply_draft: answer.reply })
        .eq("id", t.id)
        .is("auto_replied_at", null);
      if (claimErr) {
        outcomes.push({ ticket: t.ticket_number, outcome: `claim failed: ${claimErr.message}` });
        continue;
      }

      const ref = `HS${String(t.ticket_number).padStart(2, "0")}`;
      const signed = [
        answer.reply,
        "",
        "If that doesn't sort it, reply to this email and a person will pick it up.",
        "",
        "Heclus Support",
      ].join("\n");

      try {
        await sendEmail({
          from: SUPPORT_FROM,
          to: address,
          subject: `Re: [${ref}] ${t.subject}`,
          text: signed,
        });
        await supabase.from("support_tickets").update({
          status: "in_progress",
          responded_at: new Date().toISOString(),
          auto_reply_note: "Answered automatically. Reply from the customer will land in the same thread.",
        }).eq("id", t.id);
        outcomes.push({ ticket: t.ticket_number, outcome: "sent" });
      } catch (e) {
        // Stays stamped: better one lost automated reply than two sent.
        await note(t.id, `Send failed after claiming — needs a person: ${e instanceof Error ? e.message : String(e)}`);
        outcomes.push({ ticket: t.ticket_number, outcome: "send failed" });
      }
    }

    // Whatever the ticket sweep did not use is available to the inbox, so a
    // backlog of one never starves the other but the run still has one ceiling.
    const emailBudget = Math.max(0, config.auto_reply_max_per_run - tickets.length);
    const emails = config.auto_reply_emails_enabled && emailBudget > 0
      ? await sweepInbox(config, cutoff, emailBudget)
      : [];

    return NextResponse.json({
      ok: true,
      mode: config.auto_reply_dry_run ? "dry-run" : "live",
      graceMinutes: config.auto_reply_delay_minutes,
      considered: tickets.length + emails.length,
      outcomes,
      emails: config.auto_reply_emails_enabled ? emails : "disabled",
    });
  });
}

async function note(ticketId: string, text: string) {
  await supabase.from("support_tickets").update({ auto_reply_note: text }).eq("id", ticketId);
}

interface EmailRow {
  id: string;
  message_id: string;
  thread_root_id: string | null;
  from_address: string;
  subject: string | null;
  body_text: string | null;
  received_at: string | null;
}

/**
 * The same sweep, over the shared inbox.
 *
 * A ticket arrived through our own form, so whoever sent it meant to contact
 * support. An inbox holds everything: password resets from Vercel, a cold
 * partnership pitch, a receipt, a mailing list. The extra caution here is all
 * about that difference — most of what lands is not a support request, and the
 * cost of answering a stranger's marketing email with a support reply is a good
 * deal higher than the cost of leaving it for a person.
 *
 * So the sender must already hold a Heclus account. That is a stricter rule than
 * needed for correctness and the right one for a machine: it bounds automated
 * replies to people we already have a relationship with, and it is also exactly
 * the population the agent has evidence about.
 */
async function sweepInbox(
  config: Awaited<ReturnType<typeof getSupportAgentConfig>>,
  cutoff: string,
  budget: number,
): Promise<{ email: string; subject: string; outcome: string }[]> {
  const { data, error } = await supabase
    .from("emails")
    .select("id, message_id, thread_root_id, from_address, subject, body_text, received_at")
    .eq("direction", "inbound")
    .eq("is_replied", false)
    .is("auto_replied_at", null)
    // Same reason as tickets: a message that has been looked at once, whatever
    // the outcome, is not looked at again until someone clears the draft.
    .is("auto_reply_draft", null)
    .is("auto_reply_note", null)
    .lte("received_at", cutoff)
    // Filtered rather than stamped: a message that ages out is simply never a
    // candidate again, and it never costs a run's budget.
    .gte("received_at", new Date(Date.now() - INBOX_MAX_AGE_HOURS * 3_600_000).toISOString())
    .order("received_at", { ascending: true })
    .limit(budget);
  if (error) return [{ email: "-", subject: "-", outcome: `query failed: ${error.message}` }];

  const rows = (data ?? []) as EmailRow[];
  if (!rows.length) return [];

  // One lookup for the whole run rather than one per message, and before any
  // model call: an unknown sender is the commonest outcome by far, and it costs
  // nothing to establish.
  const { data: userList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const known = new Set((userList?.users ?? []).map((u) => (u.email ?? "").toLowerCase()).filter(Boolean));

  const outcomes: { email: string; subject: string; outcome: string }[] = [];

  for (const m of rows) {
    const address = (m.from_address ?? "").trim().toLowerCase();
    const subject = (m.subject ?? "").trim() || "(no subject)";
    const record = (outcome: string) => outcomes.push({ email: address || "-", subject, outcome });

    if (!address || !address.includes("@")) {
      await noteEmail(m.id, "No usable sender address.");
      record("no address");
      continue;
    }
    if (NO_REPLY_PATTERN.test(address) || OWN_ADDRESSES.includes(address)) {
      await noteEmail(m.id, `Held: ${address} looks like an unattended mailbox, so replying risks a mail loop.`);
      record("machine address");
      continue;
    }
    if (!known.has(address)) {
      await noteEmail(m.id, `Held: ${address} has no Heclus account. Automated replies only go to customers.`);
      record("not a customer");
      continue;
    }
    const body = (m.body_text ?? "").trim();
    if (body.length < 10) {
      await noteEmail(m.id, "Held: no readable text in the message body.");
      record("empty body");
      continue;
    }

    // If they wrote again while this one sat unanswered, the later message is
    // the one to answer. Replying to the stale one reads as not having listened.
    const { data: newer } = await supabase
      .from("emails")
      .select("id")
      .eq("direction", "inbound")
      .eq("from_address", m.from_address)
      .gt("received_at", m.received_at ?? cutoff)
      .limit(1);
    if (newer && newer.length) {
      await noteEmail(m.id, "Held: this sender wrote again afterwards, so the later message is the one to answer.");
      record("superseded");
      continue;
    }

    let answer;
    try {
      ({ answer } = await answerSupportQuestion({
        email: address,
        question: body.slice(0, 8000),
        subject,
        channel: "email",
      }));
    } catch (e) {
      await noteEmail(m.id, `Held: the agent errored — ${e instanceof Error ? e.message : String(e)}`);
      record("agent error");
      continue;
    }

    if (answer.needsHuman || !answer.resolved) {
      await supabase.from("emails").update({
        auto_reply_draft: answer.reply,
        auto_reply_note: `Left for a person: ${answer.handoffReason || "the agent was not confident it could resolve this"}.`,
      }).eq("id", m.id);
      record("left for a person");
      continue;
    }

    if (config.auto_reply_dry_run) {
      await supabase.from("emails").update({
        auto_reply_draft: answer.reply,
        auto_reply_note: "Dry run: this is what would have been sent.",
      }).eq("id", m.id);
      record("dry run, draft saved");
      continue;
    }

    // Claimed before sending, for the same reason as tickets: a stamped row that
    // failed to send loses one reply, an unstamped one that did send repeats it.
    const { error: claimErr } = await supabase
      .from("emails")
      .update({ auto_replied_at: new Date().toISOString(), auto_reply_draft: answer.reply })
      .eq("id", m.id)
      .is("auto_replied_at", null);
    if (claimErr) {
      record(`claim failed: ${claimErr.message}`);
      continue;
    }

    const signed = [
      answer.reply,
      "",
      "If that doesn't sort it, reply to this email and a person will pick it up.",
      "",
      "Heclus Support",
    ].join("\n");

    try {
      // sendEmail stamps is_replied on this row through In-Reply-To, so the
      // sweep will not see it again.
      await sendEmail({
        from: SUPPORT_FROM,
        to: address,
        subject: subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`,
        text: signed,
        inReplyTo: m.message_id,
      });
      await supabase.from("emails").update({
        auto_reply_note: "Answered automatically. A reply from the customer lands in the same thread.",
      }).eq("id", m.id);
      record("sent");
    } catch (e) {
      await noteEmail(m.id, `Send failed after claiming — needs a person: ${e instanceof Error ? e.message : String(e)}`);
      record("send failed");
    }
  }

  return outcomes;
}

async function noteEmail(id: string, text: string) {
  await supabase.from("emails").update({ auto_reply_note: text }).eq("id", id);
}
