"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Send, UserRound } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

// Live support chat, inside the help bubble. Signed-in users only: the whole
// point is answers grounded in their account, and there is no account to read
// for an anonymous visitor — they still get the contact form below.
//
// Sits on a white modal, so zinc utilities rather than the app's dark tokens.

interface Msg {
  role: "user" | "agent" | "system";
  content: string;
}

interface ChatState {
  chatId: string | null;
  escalatedTicket: number | null;
}

interface Proposal {
  subject: string;
  message: string;
}

export function SupportChat({ signedIn }: { signedIn: boolean }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [state, setState] = useState<ChatState>({ chatId: null, escalatedTicket: null });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  // A ticket the agent has written and the user has not approved. Nothing is
  // filed while this is on screen.
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Reopen the last conversation so closing the bubble mid-thread doesn't lose
  // what was already said.
  useEffect(() => {
    if (!signedIn) { setLoading(false); return; }
    let cancelled = false;
    fetch("/api/support/chat")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.chat) return;
        setState({ chatId: data.chat.id, escalatedTicket: null });
        setMessages((data.messages ?? []) as Msg[]);
        // A draft the user left unanswered survives a page reload, so the card
        // comes back with it rather than the agent's message referring to a
        // ticket that is nowhere on screen.
        const pending = data.chat.pending_ticket;
        if (pending?.subject && pending?.message) setProposal(pending as Proposal);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [signedIn]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  async function send(text: string, wantsHuman = false) {
    if (busy) return;
    const trimmed = text.trim();
    if (!trimmed && !wantsHuman) return;

    // Optimistic, so the chat feels live while the agent reads the account.
    if (trimmed) setMessages((m) => [...m, { role: "user", content: trimmed }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/support/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: state.chatId ?? undefined,
          message: trimmed || "I'd like to speak to a person.",
          wantsHuman,
        }),
      });
      const data = await res.json();
      if (res.status === 503) { setUnavailable(true); return; }
      if (!res.ok) throw new Error(data.error ?? "Could not send that.");
      setState({ chatId: data.chatId, escalatedTicket: data.ticket?.number ?? null });
      setMessages((m) => [...m, { role: data.escalated ? "system" : "agent", content: data.reply }]);
      setProposal(data.proposal ?? null);
    } catch (e) {
      setMessages((m) => [...m, {
        role: "system",
        content: e instanceof Error ? e.message : "Something went wrong. Try the contact form below.",
      }]);
    } finally {
      setBusy(false);
    }
  }

  async function decide(confirm: boolean) {
    if (busy || !state.chatId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/support/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: state.chatId,
          [confirm ? "confirmTicket" : "cancelTicket"]: true,
          ...(confirm && proposal ? { ticket: proposal } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "That didn't work.");
      setProposal(null);
      setState((st) => ({ ...st, escalatedTicket: data.ticket?.number ?? st.escalatedTicket }));
      setMessages((m) => [...m, { role: "system", content: data.reply }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "system", content: e instanceof Error ? e.message : "That didn't work." }]);
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) return null;
  if (unavailable) {
    return (
      <div className="rounded-lg px-3 py-2.5 mb-3" style={{ background: "#fafafa", border: "1px solid oklch(0 0 0 / 0.08)" }}>
        <p className="text-xs text-zinc-600">Live chat is off right now. Use the form below and a person will reply by email.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl mb-4 overflow-hidden" style={{ border: "1px solid oklch(0 0 0 / 0.1)" }}>
      {/* Same shape as the contact block below — avatar, title, one line of
          what to expect — so the two ways of reaching us read as siblings
          rather than two unrelated widgets. */}
      <div className="px-3 py-2.5 flex items-center justify-between gap-3" style={{ background: "#fafafa", borderBottom: "1px solid oklch(0 0 0 / 0.07)" }}>
        <div className="flex items-center gap-3 min-w-0">
          <Image
            src="/avartar.png"
            alt="Heclus Support"
            width={36}
            height={36}
            className="rounded-full shrink-0"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-900">Chat with us</p>
            <p className="text-xs text-zinc-500">Answers right now, checked against your account.</p>
          </div>
        </div>
      </div>

      <div className="px-3 py-3 space-y-2.5 h-[340px] overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-zinc-500"><Spinner size={12} /> Loading…</div>
        ) : messages.length === 0 ? (
          <p className="text-xs text-zinc-500 leading-relaxed">
            Ask anything about your account and I&apos;ll check it as we talk — keys, credits, a video that
            failed, your plan. If I can&apos;t sort it, I&apos;ll pass it to a person with this conversation attached.
          </p>
        ) : messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div className="max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap"
              style={m.role === "user"
                ? { background: "oklch(0.72 0.25 285)", color: "white" }
                : m.role === "system"
                  ? { background: "oklch(0.6 0.18 75 / 0.1)", color: "#713f12", border: "1px solid oklch(0.6 0.18 75 / 0.25)" }
                  : { background: "#f4f4f5", color: "#18181b" }}>
              {m.content}
            </div>
          </div>
        ))}
        {/* The draft, shown before anything is filed. What is on screen here is
            exactly what gets submitted — the server holds it, so editing the
            page cannot change what is sent. */}
        {proposal && !busy && (
          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid oklch(0.55 0.22 285 / 0.3)", background: "oklch(0.55 0.22 285 / 0.04)" }}>
            <div className="px-3 py-2" style={{ borderBottom: "1px solid oklch(0.55 0.22 285 / 0.18)" }}>
              <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "oklch(0.45 0.2 285)" }}>
                Ticket to send — edit anything
              </p>
            </div>
            <div className="px-3 py-2.5 space-y-2">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500">Subject</label>
                <input
                  type="text"
                  value={proposal.subject}
                  onChange={(e) => setProposal((prev) => (prev ? { ...prev, subject: e.target.value } : prev))}
                  disabled={busy}
                  maxLength={200}
                  className="mt-0.5 w-full px-2.5 py-1.5 rounded-lg text-xs font-semibold outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 disabled:opacity-60"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500">Message</label>
                <textarea
                  value={proposal.message}
                  onChange={(e) => setProposal((prev) => (prev ? { ...prev, message: e.target.value } : prev))}
                  disabled={busy}
                  rows={5}
                  maxLength={8000}
                  className="mt-0.5 w-full px-2.5 py-1.5 rounded-lg text-xs leading-relaxed outline-none resize-y bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 disabled:opacity-60"
                />
              </div>
            </div>
            <div className="px-3 pb-2.5 flex items-center gap-2 flex-wrap">
              <button type="button" onClick={() => void decide(true)}
                disabled={busy || !proposal.subject.trim() || !proposal.message.trim()}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
                style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
                Send to support
              </button>
              {/* Local only: the draft stays on the server, so it comes back on
                  the next load. Someone who wants to keep talking first should
                  not lose the write-up to do it. */}
              <button type="button" onClick={() => setProposal(null)} disabled={busy}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-50 cursor-pointer"
                style={{ background: "white", color: "#3f3f46", border: "1px solid oklch(0 0 0 / 0.12)" }}>
                Not yet
              </button>
              {/* Throws the draft away for good. Separate from Not yet because
                  "I'll decide later" and "drop it" are different answers. */}
              <button type="button" onClick={() => void decide(false)} disabled={busy}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-50 cursor-pointer"
                style={{ background: "white", color: "oklch(0.5 0.18 25)", border: "1px solid oklch(0.6 0.19 25 / 0.35)" }}>
                Abort
              </button>
            </div>
          </div>
        )}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-xl px-3 py-2 text-xs inline-flex items-center gap-2" style={{ background: "#f4f4f5", color: "#52525b" }}>
              <Spinner size={11} /> Checking your account…
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {state.escalatedTicket !== null ? (
        <div className="px-3 pt-2.5 pb-[15px] flex items-start gap-2" style={{ background: "#fafafa", borderTop: "1px solid oklch(0 0 0 / 0.07)" }}>
          <UserRound size={13} className="mt-0.5 shrink-0 text-zinc-500" />
          <p className="text-[11px] text-zinc-600 leading-relaxed">
            Passed to a person as ticket <span className="font-semibold text-zinc-900">HS{String(state.escalatedTicket).padStart(2, "0")}</span>.
            They&apos;ll reply to your account email.
          </p>
        </div>
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); void send(input); }}
          className="px-2 pt-[31px] pb-[15px] flex items-center gap-2"
          style={{ background: "#fafafa", borderTop: "1px solid oklch(0 0 0 / 0.07)" }}
        >
          {/* Single-line field. Enter submits through the form, so no key
              handler is needed. */}
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            autoComplete="off"
            placeholder="Describe what's happening…"
            className="flex-1 min-w-0 h-12 px-3.5 rounded-lg text-sm outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 disabled:opacity-60"
          />
          <button type="submit" disabled={busy || !input.trim()}
            className="inline-flex items-center justify-center h-12 w-12 rounded-lg shrink-0 transition-all hover:opacity-90 disabled:opacity-40 cursor-pointer"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            aria-label="Send message">
            {busy ? <Spinner size={15} className="text-white" /> : <Send size={15} />}
          </button>
        </form>
      )}

    </div>
  );
}
