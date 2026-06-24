"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Inbox, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

interface ThreadEmail {
  id: string;
  direction: "inbound" | "outbound";
  from_address: string | null;
  to_addresses: string[] | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  sent_at: string | null;
  message_id: string | null;
  in_reply_to: string | null;
}

interface ThreadResponse {
  ticket: {
    id: string;
    ticket_number: number;
    ref: string;
    email: string;
    subject: string;
    message: string;
    created_at: string;
    plan: string | null;
  };
  emails: ThreadEmail[];
}

type TicketStatus = "open" | "in_progress" | "resolved" | "closed";

interface Ticket {
  id: string;
  ticket_number: number;
  user_id: string | null;
  email: string;
  subject: string;
  message: string;
  status: TicketStatus;
  is_open: boolean;
  admin_notes: string | null;
  responded_at: string | null;
  created_at: string;
  updated_at: string;
  plan: string | null;
}

// Render the integer ticket_number as a human-facing reference:
// HS01, HS02, …, HS99, HS100, …. Pad to at least 2 digits so the
// early tickets read consistently; numbers above 99 grow naturally.
function formatTicketRef(n: number): string {
  return `HS${String(n).padStart(2, "0")}`;
}

function isPriorityPlan(plan: string | null): boolean {
  return plan ? PRIORITY_PLANS.has(plan.toLowerCase()) : false;
}

// Plans whose tickets render with a red "Priority" tag so admins can
// pick them out of the queue at a glance. Currently only Starter —
// higher tiers (Pro / Founder / Admin) are expected to self-serve or
// reach out via other channels.
const PRIORITY_PLANS = new Set(["starter"]);

const STATUS_LABELS: Record<TicketStatus, string> = {
  open:        "Open",
  in_progress: "In progress",
  resolved:    "Resolved",
  closed:      "Closed",
};

const STATUS_COLORS: Record<TicketStatus, { bg: string; fg: string }> = {
  open:        { bg: "oklch(0.62 0.15 220 / 0.12)", fg: "oklch(0.45 0.15 220)" },
  in_progress: { bg: "oklch(0.72 0.18 65 / 0.12)",  fg: "oklch(0.55 0.18 65)"  },
  resolved:    { bg: "oklch(0.55 0.15 145 / 0.12)", fg: "oklch(0.45 0.15 145)" },
  closed:      { bg: "oklch(0 0 0 / 0.06)",         fg: "var(--c-55)"          },
};

const fetcher = (url: string) => fetch(url).then((r) => r.ok ? r.json() : Promise.reject(r.status));

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}

// Admin queue for in-app support tickets. Filter pill across the top
// (All / Open / In progress / Resolved / Closed); list rendered as
// expandable rows. Clicking a row reveals the full message + an
// admin notes textarea + status dropdown. Saving flips the status
// and notes in one PATCH; the responded_at column is stamped
// server-side on first move off "open".
export function SupportPanel() {
  const [filter, setFilter] = useState<"all" | TicketStatus>("all");
  // Sub-filter only meaningful when the main filter is "open". Lets
  // the admin focus the queue on tickets from priority-tier plans
  // without losing the standard list when they tab back.
  const [openSubTab, setOpenSubTab] = useState<"all" | "priority">("all");
  const qs = filter === "all" ? "" : `?status=${filter}`;
  const { data, mutate, isLoading } = useSWR<{ tickets: Ticket[] }>(`/api/admin/support-tickets${qs}`, fetcher);
  const rawTickets = data?.tickets ?? [];
  const tickets = useMemo(() => {
    if (filter === "open" && openSubTab === "priority") {
      return rawTickets.filter((t) => isPriorityPlan(t.plan));
    }
    return rawTickets;
  }, [rawTickets, filter, openSubTab]);

  // Summary counts above the list — fetch the full set once so the
  // pills always reflect reality, regardless of the active filter.
  const { data: allData } = useSWR<{ tickets: Ticket[] }>("/api/admin/support-tickets", fetcher);
  const counts = useMemo(() => {
    const all = allData?.tickets ?? [];
    return {
      all:         all.length,
      open:        all.filter((t) => t.status === "open").length,
      in_progress: all.filter((t) => t.status === "in_progress").length,
      resolved:    all.filter((t) => t.status === "resolved").length,
      closed:      all.filter((t) => t.status === "closed").length,
    };
  }, [allData]);

  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-base font-semibold" style={{ color: "var(--c-90)" }}>Support tickets</p>
          <p className="text-sm mt-1" style={{ color: "var(--c-50)" }}>
            Filed via the in-app HelpButton. Newest first. Filter by status to triage.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {(["all", "open", "in_progress", "resolved", "closed"] as const).map((f) => {
          const active = filter === f;
          const label = f === "all" ? "All" : STATUS_LABELS[f];
          const count = counts[f] ?? 0;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-3 py-1.5 rounded-lg text-sm font-semibold transition-all cursor-pointer"
              style={active ? {
                background: "oklch(0.62 0.15 220)",
                color: "white",
              } : {
                background: "oklch(0 0 0 / 0.04)",
                color: "var(--c-60)",
                border: "1px solid var(--bd-7)",
              }}
            >
              {label} <span className="opacity-70">({count})</span>
            </button>
          );
        })}
      </div>

      {/* Sub-tabs only render under the Open filter — splits the
          inbox into all-open vs priority-only. Priority count comes
          off the same rawTickets payload, no extra fetch. */}
      {filter === "open" && (
        <div className="flex items-center gap-1.5 flex-wrap pl-3" style={{ borderLeft: "2px solid var(--bd-7)" }}>
          {(["all", "priority"] as const).map((sub) => {
            const active = openSubTab === sub;
            const subLabel = sub === "all" ? "All open" : "Priority";
            const subCount = sub === "all"
              ? rawTickets.length
              : rawTickets.filter((t) => isPriorityPlan(t.plan)).length;
            return (
              <button
                key={sub}
                onClick={() => setOpenSubTab(sub)}
                className="px-3 py-1.5 rounded-md text-sm font-semibold transition-all cursor-pointer"
                style={active ? {
                  background: sub === "priority" ? "oklch(0.6 0.22 25)" : "var(--c-78)",
                  color: "white",
                } : {
                  background: "transparent",
                  color: "var(--c-55)",
                  border: "1px solid var(--bd-7)",
                }}
              >
                {subLabel} <span className="opacity-70">({subCount})</span>
              </button>
            );
          })}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-10 text-sm" style={{ color: "var(--c-50)" }}>
          <Spinner size={14} className="mr-2" />
          Loading tickets…
        </div>
      ) : tickets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-2" style={{ color: "var(--c-40)" }}>
          <Inbox size={28} />
          <p className="text-base font-medium">No tickets in this view</p>
          <p className="text-sm">When users hit the help bubble, their tickets land here.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {tickets.map((t) => (
            <TicketRow
              key={t.id}
              ticket={t}
              expanded={openId === t.id}
              onToggle={() => setOpenId(openId === t.id ? null : t.id)}
              onUpdated={() => mutate()}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TicketRow({
  ticket,
  expanded,
  onToggle,
  onUpdated,
}: {
  ticket: Ticket;
  expanded: boolean;
  onToggle: () => void;
  onUpdated: () => void;
}) {
  // Local edit buffers for status + notes. Both seeded from the
  // ticket on every render so a parent revalidation picks up
  // server-side changes (e.g. another admin replied in another
  // tab). Dirty check below gates the Save button.
  const [statusDraft, setStatusDraft] = useState<TicketStatus>(ticket.status);
  const [notesDraft, setNotesDraft] = useState<string>(ticket.admin_notes ?? "");
  const [saving, setSaving] = useState(false);
  // Reply composer — independent state from the status/notes form
  // so an in-progress draft survives switching tabs to triage
  // something else. Cleared after a successful send.
  const [replyDraft, setReplyDraft] = useState<string>("");
  const [sendingReply, setSendingReply] = useState(false);

  const dirty = statusDraft !== ticket.status || notesDraft !== (ticket.admin_notes ?? "");
  const statusStyle = STATUS_COLORS[ticket.status];
  const isPriority = isPriorityPlan(ticket.plan);
  const ticketRef = formatTicketRef(ticket.ticket_number);

  // Thread fetched lazily — only after the row is expanded, so the
  // initial queue load stays cheap. Re-fetches automatically after
  // an admin reply succeeds (sendReply calls mutateThread below).
  const { data: thread, mutate: mutateThread, isLoading: threadLoading } = useSWR<ThreadResponse>(
    expanded ? `/api/admin/support-tickets/${ticket.id}/thread` : null,
    fetcher,
  );

  async function sendReply() {
    setSendingReply(true);
    try {
      const res = await fetch(`/api/admin/support-tickets/${ticket.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: replyDraft.trim() }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Send failed (${res.status})`);
      toast.success(`Reply sent to ${ticket.email}`);
      setReplyDraft("");
      onUpdated();
      mutateThread();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSendingReply(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/support-tickets/${ticket.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: statusDraft,
          admin_notes: notesDraft.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`);
      toast.success("Ticket updated");
      onUpdated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="rounded-xl" style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid var(--bd-7)" }}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-2.5 flex items-center gap-3 text-left cursor-pointer hover:bg-[oklch(0_0_0_/_0.02)] transition-colors"
      >
        <span className="shrink-0 inline-flex items-center justify-center w-5 h-5" style={{ color: "var(--c-50)" }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="shrink-0 text-sm font-mono font-semibold" style={{ color: "var(--c-60)" }}>
          {formatTicketRef(ticket.ticket_number)}
        </span>
        <span
          className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-semibold"
          style={{ background: statusStyle.bg, color: statusStyle.fg }}
        >
          {STATUS_LABELS[ticket.status]}
        </span>
        {ticket.plan && (
          <span
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-semibold capitalize"
            style={{ background: "oklch(0 0 0 / 0.05)", color: "var(--c-55)" }}
            title={`Plan: ${ticket.plan}`}
          >
            {ticket.plan}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-base font-medium" style={{ color: "var(--c-90)" }}>{ticket.subject}</span>
          <span className="text-sm ml-2" style={{ color: "var(--c-50)" }}>{ticket.email}</span>
        </span>
        {isPriority && (
          <span
            className="shrink-0 inline-flex items-center justify-center text-[10px] leading-none px-2 py-1 rounded font-semibold uppercase"
            style={{ background: "oklch(0.6 0.22 25)", color: "white" }}
            title="Priority support — starter tier"
          >
            Priority
          </span>
        )}
        <span className="shrink-0 text-sm" style={{ color: "var(--c-45)" }}>
          {timeAgo(ticket.created_at)}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3" style={{ borderTop: "1px solid var(--bd-7)" }}>
          <div className="pt-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
                Conversation
              </p>
              {threadLoading && <Spinner size={12} />}
            </div>

            <ThreadView ticket={ticket} thread={thread} />
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider block mb-1.5" style={{ color: "var(--c-40)" }}>Status</label>
              <select
                value={statusDraft}
                onChange={(e) => setStatusDraft(e.target.value as TicketStatus)}
                disabled={saving}
                className="w-full px-3 py-2 rounded-lg text-base outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 capitalize"
              >
                {(["open", "in_progress", "resolved", "closed"] as const).map((s) => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider block mb-1.5" style={{ color: "var(--c-40)" }}>Created</label>
              <p className="text-sm px-3 py-2 rounded-lg" style={{ background: "oklch(0 0 0 / 0.03)", color: "var(--c-60)" }}>
                {new Date(ticket.created_at).toLocaleString()}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" style={{ color: "var(--c-50)" }}>
            <span className="inline-flex items-center gap-1.5">
              Plan at file time: <span className="font-semibold capitalize" style={{ color: "var(--c-78)" }}>{ticket.plan ?? "(none)"}</span>
              {isPriority && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide"
                  style={{ background: "oklch(0.6 0.22 25)", color: "white" }}
                >
                  Priority
                </span>
              )}
            </span>
            {ticket.responded_at && (
              <span>
                First response stamped <span className="font-mono">{new Date(ticket.responded_at).toLocaleString()}</span>.
              </span>
            )}
          </div>

          <div>
            <label className="text-xs uppercase tracking-wider block mb-1.5" style={{ color: "var(--c-40)" }}>Admin notes (internal)</label>
            <textarea
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              disabled={saving}
              rows={3}
              placeholder="Anything teammates should know — never shown to the user."
              className="w-full px-3 py-2 rounded-lg text-base outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 resize-y"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving || !dirty}
              className="px-4 py-2 rounded-xl text-base font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
            >
              {saving ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size={14} className="text-white" />
                  Saving…
                </span>
              ) : "Save changes"}
            </button>
          </div>

          {/* Reply composer — sends an SMTP message from
              support@heclus.com straight to the customer's inbox.
              The endpoint stamps responded_at and (if the ticket
              was still open) bumps status to in_progress so the
              queue counts stay accurate. */}
          <div className="space-y-2 pt-3" style={{ borderTop: "1px solid var(--bd-7)" }}>
            <label className="text-xs uppercase tracking-wider block mb-1.5" style={{ color: "var(--c-40)" }}>
              Reply to customer ({ticket.email})
            </label>
            <textarea
              value={replyDraft}
              onChange={(e) => setReplyDraft(e.target.value)}
              disabled={sendingReply}
              rows={4}
              placeholder={`Write your reply. Subject will be "Re: [${ticketRef}] ${ticket.subject}"; sent from support@heclus.com.`}
              className="w-full px-3 py-2 rounded-lg text-base outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 resize-y"
            />
            <div className="flex items-center gap-3">
              <button
                onClick={sendReply}
                disabled={sendingReply || !replyDraft.trim()}
                className="px-4 py-2 rounded-xl text-base font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: "oklch(0.55 0.15 145)", color: "white" }}
              >
                {sendingReply ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner size={14} className="text-white" />
                    Sending…
                  </span>
                ) : "Send reply"}
              </button>
              <p className="text-xs" style={{ color: "var(--c-50)" }}>
                Customer will reply to the same thread — your inbox catches it via IMAP.
              </p>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function ThreadView({
  ticket,
  thread,
}: {
  ticket: Ticket;
  thread: ThreadResponse | undefined;
}) {
  // Render the original in-app submission first, then every related
  // email (admin replies + customer replies) in chronological order.
  // Each entry is color-coded by direction so the admin can scan
  // who said what without reading sender lines.
  const messages = useMemo(() => {
    type Msg = {
      key: string;
      direction: "inbound" | "outbound" | "original";
      from: string;
      at: string;
      body: string;
    };
    const list: Msg[] = [
      {
        key: `original-${ticket.id}`,
        direction: "original",
        from: ticket.email,
        at: ticket.created_at,
        body: ticket.message,
      },
    ];
    for (const e of thread?.emails ?? []) {
      list.push({
        key: e.id,
        direction: e.direction,
        from: e.from_address ?? (e.direction === "outbound" ? "support@heclus.com" : ticket.email),
        at: e.sent_at ?? ticket.created_at,
        body: e.body_text ?? "(no body)",
      });
    }
    return list;
  }, [ticket, thread]);

  return (
    <ol className="space-y-2">
      {messages.map((m, idx) => {
        const isAdmin = m.direction === "outbound";
        const isOriginal = m.direction === "original";
        const accent = isAdmin
          ? { bg: "oklch(0.62 0.15 220 / 0.06)", border: "oklch(0.62 0.15 220 / 0.25)", chip: "oklch(0.62 0.15 220)", label: "Admin reply" }
          : isOriginal
            ? { bg: "oklch(0 0 0 / 0.03)", border: "var(--bd-7)", chip: "var(--c-55)", label: "Original ticket" }
            : { bg: "oklch(0.55 0.15 145 / 0.06)", border: "oklch(0.55 0.15 145 / 0.25)", chip: "oklch(0.55 0.15 145)", label: "Customer reply" };
        return (
          <li
            key={m.key}
            className="rounded-lg p-3 space-y-1.5"
            style={{ background: accent.bg, border: `1px solid ${accent.border}` }}
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="shrink-0 inline-flex items-center justify-center text-[10px] leading-none px-2 py-1 rounded font-semibold"
                  style={{ background: accent.chip, color: "white" }}
                >
                  {idx + 1}. {accent.label}
                </span>
                <span className="text-xs truncate" style={{ color: "var(--c-55)" }} title={m.from}>
                  {isAdmin ? <ArrowUpRight size={12} className="inline -mt-0.5 mr-1" /> : <ArrowDownLeft size={12} className="inline -mt-0.5 mr-1" />}
                  {m.from}
                </span>
              </div>
              <span className="shrink-0 text-xs" style={{ color: "var(--c-45)" }}>
                {new Date(m.at).toLocaleString()}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: "var(--c-78)" }}>
              {m.body}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

