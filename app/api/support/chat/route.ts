import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { sendEmail } from "@/lib/email/smtp";
import { answerSupportQuestion, getSupportAgentConfig, type AgentTurn } from "@/lib/support-agent/agent";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// In-app support chat. The user asks, the agent answers from their account's
// real state, and when a person is needed it DRAFTS a ticket and shows it to
// them for approval.
//
// Nothing is ever filed on the agent's say-so. A ticket is created in exactly
// one place — the confirm branch below, reached only by an explicit click — and
// the text filed is the text that was previewed, because the draft is held here
// rather than round-tripped through the browser.
//
// The account whose evidence is read comes from the session, never from the
// request body. A chat message cannot name an account.

const MAX_MESSAGE_LEN = 4000;
/** Enough to stay coherent, short enough to bound spend on a runaway chat. */
const MAX_TURNS_PER_CHAT = 40;

interface ChatRow {
  id: string;
  user_id: string | null;
  email: string;
  status: string;
  escalated_ticket_id: string | null;
  pending_ticket: { subject?: string; message?: string } | null;
  ticket_declined_at: string | null;
}

export interface ProposedTicket {
  subject: string;
  message: string;
}

export interface SupportChatResponse {
  chatId: string;
  reply: string;
  /** A ticket awaiting the user's approval. The UI renders it with buttons. */
  proposal?: ProposedTicket;
  /** Set only once a ticket has actually been filed. */
  ticket?: { id: string; number: number | null };
  escalated: boolean;
}

const CHAT_SELECT = "id, user_id, email, status, escalated_ticket_id, pending_ticket, ticket_declined_at";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const config = await getSupportAgentConfig();
  if (!config.chat_enabled) {
    return NextResponse.json(
      { error: "Chat support is not available right now. Please use the contact form." },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({})) as {
    chatId?: string;
    message?: string;
    confirmTicket?: boolean;
    cancelTicket?: boolean;
    /** The user's edits to the drafted ticket, sent with the confirm click. */
    ticket?: { subject?: unknown; message?: unknown };
  };

  const email = user.email ?? "";
  if (!email) return NextResponse.json({ error: "Your account has no email address on file." }, { status: 400 });

  // ── Approve or discard a drafted ticket ────────────────────────────────────
  // These two branches take no message and never call the model. Confirm is the
  // only path in this file that writes a support_tickets row.
  if (body.confirmTicket || body.cancelTicket) {
    if (!body.chatId) return NextResponse.json({ error: "Missing chat" }, { status: 400 });
    const chat = await loadChat(body.chatId, user.id);
    if (!chat) return NextResponse.json({ error: "Chat not found" }, { status: 404 });

    if (body.cancelTicket) {
      await supabase.from("support_chats")
        .update({
          pending_ticket: null,
          ticket_declined_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", chat.id);
      const reply = "No problem, I haven't sent anything. Tell me more and I'll keep trying.";
      await supabase.from("support_chat_messages").insert({ chat_id: chat.id, role: "system", content: reply });
      return NextResponse.json({ chatId: chat.id, reply, escalated: false } satisfies SupportChatResponse);
    }

    // The draft is editable, so the submitted text wins over the stored one —
    // it is the user's own words about their own problem, and they are the one
    // approving it. The stored draft remains the fallback when the client sends
    // nothing, and a pending draft is still required, so a confirm click can
    // never file a ticket out of thin air.
    const pending = chat.pending_ticket;
    const edited = body.ticket;
    const pick = (v: unknown, fallback: string) =>
      (typeof v === "string" && v.trim() ? v.trim() : fallback);
    const subject = pick(edited?.subject, (pending?.subject ?? "").trim()).slice(0, 200);
    const message = pick(edited?.message, (pending?.message ?? "").trim()).slice(0, 8000);
    const hasDraft = !!((pending?.subject ?? "").trim() && (pending?.message ?? "").trim());

    // Nothing pending. Either this is a second click on a draft already filed —
    // answer with that ticket rather than a second copy — or there was never a
    // draft at all.
    if (!subject || !message || !hasDraft) {
      if (chat.escalated_ticket_id) {
        const existing = await ticketById(chat.escalated_ticket_id);
        if (existing) {
          return NextResponse.json({
            chatId: chat.id, reply: "That's already with a person.", escalated: true, ticket: existing,
          } satisfies SupportChatResponse);
        }
      }
      return NextResponse.json({ error: "There's no draft to send. Ask again and I'll write one." }, { status: 409 });
    }

    const ticket = await fileTicket({
      chat, email, userId: user.id, plan: planOf(user), subject, message,
    });
    if (!ticket) {
      return NextResponse.json({ error: "I couldn't file that. Please try again in a moment." }, { status: 500 });
    }

    const reply = `Sent. Your ticket is HS${String(ticket.number ?? 0).padStart(2, "0")} and a person will reply to ${email}.`;
    await supabase.from("support_chat_messages").insert({ chat_id: chat.id, role: "system", content: reply });
    return NextResponse.json({ chatId: chat.id, reply, escalated: true, ticket } satisfies SupportChatResponse);
  }

  // ── A normal message ──────────────────────────────────────────────────────
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Type a message first." }, { status: 400 });
  if (message.length > MAX_MESSAGE_LEN) {
    return NextResponse.json({ error: `Message too long — keep it under ${MAX_MESSAGE_LEN} characters.` }, { status: 400 });
  }

  let chat: ChatRow;
  if (body.chatId) {
    const found = await loadChat(body.chatId, user.id);
    if (!found) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    chat = found;
  } else {
    const { data, error } = await supabase
      .from("support_chats")
      .insert({ user_id: user.id, email })
      .select(CHAT_SELECT)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    chat = data as ChatRow;
  }

  const { data: priorRows, error: histErr } = await supabase
    .from("support_chat_messages")
    .select("role, content")
    .eq("chat_id", chat.id)
    .order("created_at", { ascending: true })
    .limit(MAX_TURNS_PER_CHAT + 1);
  if (histErr) return NextResponse.json({ error: histErr.message }, { status: 500 });

  const prior = (priorRows ?? []) as { role: string; content: string }[];
  if (prior.length > MAX_TURNS_PER_CHAT) {
    return NextResponse.json(
      { error: "This conversation has gone on a while. Start a new one, or ask for a person." },
      { status: 409 },
    );
  }

  await supabase.from("support_chat_messages").insert({ chat_id: chat.id, role: "user", content: message });

  const history: AgentTurn[] = prior
    .filter((m) => m.role === "user" || m.role === "agent")
    .map((m) => ({ role: m.role as "user" | "agent", content: m.content }));

  let answer;
  try {
    ({ answer } = await answerSupportQuestion({
      email, question: message, history, channel: "chat",
      ticketDeclined: !!chat.ticket_declined_at,
    }));
  } catch (e) {
    console.warn("[support/chat] agent failed:", e instanceof Error ? e.message : e);
    // Still no ticket without a click. Offer one built from their own words,
    // which needs no model and cannot misquote them.
    if (chat.ticket_declined_at) {
      const reply = "Something went wrong on my end. Try again in a moment, or ask for a person and I'll write one up.";
      await supabase.from("support_chat_messages").insert({ chat_id: chat.id, role: "system", content: reply });
      return NextResponse.json({ chatId: chat.id, reply, escalated: false } satisfies SupportChatResponse);
    }
    const proposal: ProposedTicket = {
      subject: message.slice(0, 80),
      message,
    };
    await savePending(chat.id, proposal);
    const reply = "Something went wrong on my end. I can pass this to a person instead — here's what I'd send:";
    await supabase.from("support_chat_messages").insert({ chat_id: chat.id, role: "system", content: reply });
    return NextResponse.json({ chatId: chat.id, reply, proposal, escalated: false } satisfies SupportChatResponse);
  }

  await supabase.from("support_chat_messages").insert({ chat_id: chat.id, role: "agent", content: answer.reply });

  let proposal: ProposedTicket | undefined;
  // A decline silences offers the agent volunteers, but never a request the
  // user makes: "no thanks" should not become "you may no longer ask".
  const mayOffer = !chat.ticket_declined_at || answer.userAskedForHuman;
  if (answer.needsHuman && mayOffer) {
    proposal = {
      subject: (answer.ticketSubject || answer.summary).slice(0, 200),
      // Falling back to the user's own words beats filing an empty body.
      message: answer.ticketMessage || message,
    };
    await savePending(chat.id, proposal);
    if (chat.ticket_declined_at && answer.userAskedForHuman) {
      await supabase.from("support_chats").update({ ticket_declined_at: null }).eq("id", chat.id);
    }
  }

  await supabase.from("support_chats").update({ updated_at: new Date().toISOString() }).eq("id", chat.id);

  return NextResponse.json({
    chatId: chat.id,
    reply: answer.reply,
    escalated: false,
    ...(proposal ? { proposal } : {}),
  } satisfies SupportChatResponse);
}

async function loadChat(id: string, userId: string): Promise<ChatRow | null> {
  const { data } = await supabase.from("support_chats").select(CHAT_SELECT).eq("id", id).maybeSingle();
  const row = data as ChatRow | null;
  // Ownership check, not just existence: a chat may only be continued by the
  // account that opened it.
  return row && row.user_id === userId ? row : null;
}

async function ticketById(id: string) {
  const { data } = await supabase.from("support_tickets").select("id, ticket_number").eq("id", id).maybeSingle();
  const row = data as { id: string; ticket_number: number | null } | null;
  return row ? { id: row.id, number: row.ticket_number } : null;
}

async function savePending(chatId: string, proposal: ProposedTicket) {
  await supabase.from("support_chats")
    .update({ pending_ticket: proposal, updated_at: new Date().toISOString() })
    .eq("id", chatId);
}

function planOf(user: User): string | null {
  const plan = (user.app_metadata as { plan?: unknown } | undefined)?.plan;
  return typeof plan === "string" && plan.trim() ? plan.trim() : null;
}

/**
 * Files the approved ticket. The message is exactly what the user saw — the
 * transcript is linked through chat_id rather than appended, so the preview
 * never differs from what gets filed.
 */
async function fileTicket(args: {
  chat: ChatRow;
  email: string;
  userId: string;
  plan: string | null;
  subject: string;
  message: string;
}): Promise<{ id: string; number: number | null } | null> {
  const { data: inserted, error } = await supabase
    .from("support_tickets")
    .insert({
      user_id: args.userId,
      email: args.email,
      subject: args.subject,
      message: args.message,
      plan: args.plan,
      chat_id: args.chat.id,
    })
    .select("id, ticket_number")
    .single();
  if (error) {
    console.error("[support/chat] ticket insert failed:", error.message);
    return null;
  }
  const row = inserted as { id: string; ticket_number: number | null };

  await supabase.from("support_chats")
    .update({
      status: "escalated",
      escalated_ticket_id: row.id,
      pending_ticket: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.chat.id);

  // Fail-soft: the ticket exists, so a dropped notification must not be
  // reported to the user as a failure to file.
  try {
    await sendEmail({
      from: "support@heclus.com",
      to: "support@heclus.com",
      subject: `[HS${String(row.ticket_number ?? 0).padStart(2, "0")}] From chat: ${args.subject.slice(0, 120)}`,
      text: [
        args.message,
        "",
        `Account: ${args.email}`,
        `Plan: ${args.plan ?? "(none)"}`,
        `Raised from chat: ${args.chat.id}`,
      ].join("\n"),
    });
  } catch (e) {
    console.warn("[support/chat] ticket notification failed:", e instanceof Error ? e.message : e);
  }

  return { id: row.id, number: row.ticket_number };
}

/** The conversation so far, for reopening the widget on a new page load. */
export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { data: chat } = await supabase
    .from("support_chats")
    .select("id, status, escalated_ticket_id, pending_ticket")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!chat) return NextResponse.json({ chat: null, messages: [] });

  const { data: messages } = await supabase
    .from("support_chat_messages")
    .select("role, content, created_at")
    .eq("chat_id", (chat as { id: string }).id)
    .order("created_at", { ascending: true });

  return NextResponse.json({ chat, messages: messages ?? [] });
}
