"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Mail, Send, RefreshCw, Search, X, Reply, Inbox as InboxIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { DiagnoseButton } from "@/components/admin/DiagnoseButton";

/**
 * Admin Emails tab. Two-pane layout: list on the left, detail or
 * compose form on the right. Drives off three endpoints:
 *
 *   GET  /api/admin/emails           — list (filtered + paginated)
 *   GET  /api/admin/emails/[id]      — full body + marks read
 *   POST /api/admin/emails           — send
 *   POST /api/admin/emails/sync      — pull new mail from Hostinger
 *
 * Two senders are supported (the primary mailbox + its alias).
 * Update FROM_ADDRESSES below if Hostinger aliases change.
 */
const FROM_ADDRESSES = ["support@heclus.com", "info@heclus.com"];

type Direction = "inbound" | "outbound";

interface EmailRow {
  id: string;
  direction: Direction;
  message_id: string;
  from_address: string;
  to_addresses: string[];
  subject: string | null;
  snippet: string | null;
  received_at: string | null;
  sent_at: string | null;
  is_read: boolean;
  is_replied?: boolean;
  auto_replied_at?: string | null;
  auto_reply_draft?: string | null;
  in_reply_to: string | null;
  thread_root_id: string | null;
}

interface EmailFull extends Omit<EmailRow, "snippet"> {
  body_text: string | null;
  body_html: string | null;
  cc_addresses: string[];
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// Same four states and the same two colours as the ticket queue: purple is
// always the agent, green is always someone answering. Only inbound mail has
// this state at all, since a sent message is its own answer.
const AGENT_TONE = { bg: "oklch(0.72 0.25 285 / 0.12)", fg: "oklch(0.5 0.2 285)" };
const REPLIED_TONE = { bg: "oklch(0.55 0.15 145 / 0.12)", fg: "oklch(0.45 0.15 145)" };

function replyBadge(e: EmailRow): { label: string; bg: string; fg: string } | null {
  if (e.direction !== "inbound") return null;
  // Checked before is_replied, which a send also sets: who answered matters
  // more here than that someone did.
  if (e.auto_replied_at) return { label: "Agent replied", ...AGENT_TONE };
  if (e.is_replied) return { label: "Replied", ...REPLIED_TONE };
  if (e.auto_reply_draft) return { label: "Agent draft", ...AGENT_TONE };
  return { label: "Awaiting reply", bg: "oklch(0 0 0 / 0.05)", fg: "var(--c-45)" };
}

function timeAgoShort(date: string | null): string {
  if (!date) return "—";
  const ms = Date.now() - new Date(date).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(date).toLocaleDateString();
}

export default function EmailsPanel() {
  const [tab, setTab] = useState<Direction>("inbound");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const listKey = `/api/admin/emails?direction=${tab}${search ? `&q=${encodeURIComponent(search)}` : ""}`;
  const { data: listData, mutate: mutateList } = useSWR<{ emails: EmailRow[] }>(listKey, fetcher);
  const emails = listData?.emails ?? [];

  const detailKey = selectedId ? `/api/admin/emails/${selectedId}` : null;
  const { data: detailData } = useSWR<{ email: EmailFull }>(detailKey, fetcher);
  const selectedEmail = detailData?.email ?? null;

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/admin/emails/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed");
      const summary = data.inserted
        ? `${data.inserted} new message${data.inserted === 1 ? "" : "s"}`
        : "No new mail";
      toast.success(summary);
      void mutateList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function handleReply() {
    if (!selectedEmail) return;
    setComposing(true);
  }

  const unreadCount = useMemo(
    () => emails.filter((e) => e.direction === "inbound" && !e.is_read).length,
    [emails],
  );

  return (
    <section className="rounded-2xl overflow-hidden"
      style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>

      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-4 flex-wrap"
        style={{ borderBottom: "1px solid oklch(0 0 0 / 0.06)" }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
            <Mail size={16} style={{ color: "oklch(0.72 0.25 285)" }} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">Emails</h2>
            <p className="text-xs" style={{ color: "var(--c-45)" }}>
              {tab === "inbound" ? `Inbox · ${unreadCount} unread` : "Sent"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleSync} disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-50"
            style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}>
            {syncing ? <Spinner size={12} /> : <RefreshCw size={12} />}
            {syncing ? "Syncing…" : "Sync"}
          </button>
          <button onClick={() => { setSelectedId(null); setComposing(true); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
            style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.35)" }}>
            <Send size={12} />
            Compose
          </button>
        </div>
      </div>

      {/* Sub-tabs + search */}
      <div className="flex items-center gap-3 px-5 py-3 flex-wrap"
        style={{ borderBottom: "1px solid oklch(0 0 0 / 0.06)", background: "oklch(0 0 0 / 0.02)" }}>
        <div className="flex gap-1 p-1 rounded-lg" style={{ background: "oklch(0 0 0 / 0.04)" }}>
          {(["inbound", "outbound"] as const).map((d) => (
            <button key={d}
              onClick={() => { setTab(d); setSelectedId(null); setComposing(false); }}
              className="px-3 py-1 rounded text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer"
              style={tab === d
                ? { background: "var(--bg-card)", color: "oklch(0.72 0.25 285)", boxShadow: "0 1px 3px oklch(0 0 0 / 0.06)" }
                : { background: "transparent", color: "var(--c-50)" }}>
              {d === "inbound" ? "Inbox" : "Sent"}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--c-45)" }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subject, from…"
            className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs outline-none"
            style={{ background: "var(--bg-card)", border: "1px solid var(--bd-8)", color: "var(--c-90)" }}
          />
        </div>
      </div>

      {/* Two-pane body */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(260px,360px)_1fr] min-h-[400px]">
        {/* List */}
        <div className="overflow-y-auto max-h-[600px]"
          style={{ borderRight: "1px solid oklch(0 0 0 / 0.06)" }}>
          {emails.length === 0 ? (
            <div className="p-10 text-center text-xs" style={{ color: "var(--c-45)" }}>
              <InboxIcon size={28} className="mx-auto mb-2 opacity-40" />
              {search ? "No matches." : tab === "inbound" ? "Inbox empty. Click Sync to fetch." : "Nothing sent yet."}
            </div>
          ) : emails.map((e) => {
            const isSelected = e.id === selectedId;
            const unread = e.direction === "inbound" && !e.is_read;
            const reply = replyBadge(e);
            return (
              <button key={e.id}
                onClick={() => { setSelectedId(e.id); setComposing(false); void mutateList(); }}
                className="w-full text-left px-4 py-3 transition-colors hover:bg-black/[0.02]"
                style={{
                  borderBottom: "1px solid oklch(0 0 0 / 0.04)",
                  background: isSelected ? "oklch(0.72 0.25 285 / 0.08)" : "transparent",
                  borderLeft: isSelected ? "3px solid oklch(0.72 0.25 285)" : "3px solid transparent",
                }}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-xs font-semibold truncate" style={{ color: unread ? "var(--c-90)" : "var(--c-65)" }}>
                    {e.direction === "inbound" ? e.from_address : `To: ${e.to_addresses[0] ?? "—"}`}
                  </p>
                  <span className="text-[10px] shrink-0" style={{ color: "var(--c-40)" }}>
                    {timeAgoShort(e.received_at ?? e.sent_at)}
                  </span>
                </div>
                <p className="text-xs truncate mb-0.5" style={{ color: unread ? "var(--c-85)" : "var(--c-55)", fontWeight: unread ? 600 : 400 }}>
                  {e.subject || "(no subject)"}
                </p>
                {e.snippet && (
                  <p className="text-[11px] truncate" style={{ color: "var(--c-45)" }}>
                    {e.snippet}
                  </p>
                )}
                {reply && (
                  <span className="inline-block mt-1.5 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider"
                    style={{ background: reply.bg, color: reply.fg }}>
                    {reply.label}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Detail / compose */}
        <div className="overflow-y-auto max-h-[600px]">
          {composing ? (
            <ComposeForm
              key={selectedEmail?.id ?? "fresh"}
              replyTo={selectedEmail}
              onClose={() => setComposing(false)}
              onSent={() => { setComposing(false); setTab("outbound"); void mutateList(); }}
            />
          ) : selectedEmail ? (
            <EmailDetailView email={selectedEmail} onReply={handleReply} onSent={() => void mutateList()} />
          ) : (
            <div className="h-full flex items-center justify-center p-10 text-center text-xs" style={{ color: "var(--c-45)" }}>
              <div>
                <Mail size={32} className="mx-auto mb-3 opacity-30" />
                Pick a message on the left, or hit Compose.
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function EmailDetailView({ email, onReply, onSent }: { email: EmailFull; onReply: () => void; onSent: () => void }) {
  return (
    <div className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-45)" }}>Subject</p>
          <p className="text-base font-semibold break-words" style={{ color: "var(--c-90)" }}>
            {email.subject || "(no subject)"}
          </p>
        </div>
        <button onClick={onReply}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 transition-all hover:opacity-90"
          style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
          <Reply size={12} />
          Reply
        </button>
      </div>

      <div className="rounded-xl p-3 space-y-1.5 text-xs"
        style={{ background: "var(--bg-elevated)", border: "1px solid oklch(0 0 0 / 0.06)" }}>
        <div className="flex gap-2">
          <span className="font-semibold w-12 shrink-0" style={{ color: "var(--c-50)" }}>From</span>
          <span className="break-all" style={{ color: "var(--c-85)" }}>{email.from_address}</span>
        </div>
        <div className="flex gap-2">
          <span className="font-semibold w-12 shrink-0" style={{ color: "var(--c-50)" }}>To</span>
          <span className="break-all" style={{ color: "var(--c-85)" }}>{email.to_addresses.join(", ")}</span>
        </div>
        {email.cc_addresses?.length > 0 && (
          <div className="flex gap-2">
            <span className="font-semibold w-12 shrink-0" style={{ color: "var(--c-50)" }}>Cc</span>
            <span className="break-all" style={{ color: "var(--c-85)" }}>{email.cc_addresses.join(", ")}</span>
          </div>
        )}
        <div className="flex gap-2">
          <span className="font-semibold w-12 shrink-0" style={{ color: "var(--c-50)" }}>Date</span>
          <span style={{ color: "var(--c-85)" }}>
            {(email.received_at ?? email.sent_at)
              ? new Date(email.received_at ?? email.sent_at!).toLocaleString()
              : "—"}
          </span>
        </div>
      </div>

      {/* Inbound only: an email we sent has no reporter to identify an account
          by, and diagnosing our own outbound mail is meaningless. */}
      {email.direction === "inbound" && (
        <DiagnoseButton
          emailId={email.id}
          reply={{ to: email.from_address, subject: email.subject, messageId: email.message_id }}
          onSent={onSent}
        />
      )}

      <div className="rounded-xl p-4"
        style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.06)" }}>
        {email.body_html ? (
          // Render HTML in an iframe so the email's own styles can't
          // leak into the dashboard. srcDoc avoids the same-origin
          // wrinkles of a real document load.
          <iframe
            title="Email body"
            srcDoc={email.body_html}
            sandbox=""
            className="w-full min-h-[300px] border-0"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words text-xs font-sans leading-relaxed"
            style={{ color: "var(--c-85)" }}>
            {email.body_text || "(no body)"}
          </pre>
        )}
      </div>
    </div>
  );
}

function ComposeForm({ replyTo, onClose, onSent }: {
  replyTo: EmailFull | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const replySubject = replyTo?.subject
    ? (replyTo.subject.startsWith("Re:") ? replyTo.subject : `Re: ${replyTo.subject}`)
    : "";
  const [from, setFrom] = useState(replyTo?.to_addresses?.[0] && FROM_ADDRESSES.includes(replyTo.to_addresses[0])
    ? replyTo.to_addresses[0]
    : FROM_ADDRESSES[0]);
  const [to, setTo] = useState(replyTo?.from_address ?? "");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(replySubject);
  const [body, setBody] = useState(replyTo?.body_text
    ? `\n\n---\nOn ${replyTo.received_at ? new Date(replyTo.received_at).toLocaleString() : "earlier"}, ${replyTo.from_address} wrote:\n${replyTo.body_text.split("\n").map((l) => `> ${l}`).join("\n")}`
    : "");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      toast.error("To, subject, and body are required.");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/admin/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: to.split(",").map((s) => s.trim()).filter(Boolean),
          cc: cc ? cc.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          subject,
          text: body,
          inReplyTo: replyTo?.message_id ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Send failed");
      toast.success("Sent.");
      onSent();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  const fieldStyle = { background: "var(--bg-card)", border: "1px solid var(--bd-8)", color: "var(--c-90)" };

  return (
    <div className="p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold" style={{ color: "var(--c-90)" }}>
          {replyTo ? "Reply" : "New message"}
        </p>
        <button onClick={onClose}
          className="p-1.5 rounded-lg transition-opacity hover:opacity-80"
          style={{ color: "var(--c-50)" }}>
          <X size={14} />
        </button>
      </div>

      <div className="space-y-2">
        <div className="grid grid-cols-[60px_1fr] items-center gap-2">
          <label className="text-xs font-semibold" style={{ color: "var(--c-50)" }}>From</label>
          <select value={from} onChange={(e) => setFrom(e.target.value)}
            className="px-3 py-2 rounded-lg text-xs outline-none" style={fieldStyle}>
            {FROM_ADDRESSES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-[60px_1fr] items-center gap-2">
          <label className="text-xs font-semibold" style={{ color: "var(--c-50)" }}>To</label>
          <input value={to} onChange={(e) => setTo(e.target.value)}
            placeholder="user@example.com (comma-separate multiple)"
            className="px-3 py-2 rounded-lg text-xs outline-none" style={fieldStyle} />
        </div>
        <div className="grid grid-cols-[60px_1fr] items-center gap-2">
          <label className="text-xs font-semibold" style={{ color: "var(--c-50)" }}>Cc</label>
          <input value={cc} onChange={(e) => setCc(e.target.value)}
            placeholder="(optional)"
            className="px-3 py-2 rounded-lg text-xs outline-none" style={fieldStyle} />
        </div>
        <div className="grid grid-cols-[60px_1fr] items-center gap-2">
          <label className="text-xs font-semibold" style={{ color: "var(--c-50)" }}>Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)}
            className="px-3 py-2 rounded-lg text-xs outline-none" style={fieldStyle} />
        </div>
      </div>

      <textarea value={body} onChange={(e) => setBody(e.target.value)}
        rows={14}
        placeholder="Write your message…"
        className="w-full px-3 py-3 rounded-lg text-xs outline-none resize-y font-sans leading-relaxed"
        style={fieldStyle} />

      <div className="flex justify-end gap-2">
        <button onClick={onClose} disabled={sending}
          className="px-4 py-2 rounded-lg text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
          style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}>
          Cancel
        </button>
        <button onClick={handleSend} disabled={sending}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50"
          style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
          {sending ? <Spinner size={12} /> : <Send size={12} />}
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
