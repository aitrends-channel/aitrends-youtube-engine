"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Plus, Trash2, Send, ChevronDown, ChevronRight } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { SupportAgentPanel } from "@/components/admin/SupportAgentPanel";
import { KnowledgeUpload } from "@/components/admin/KnowledgeUpload";
import type { KnowledgeEntry } from "@/lib/support-agent/knowledge";
import type { AgentAnswer } from "@/lib/support-agent/agent";

// Everything about the Heclus agent in one place: its switches, what it has been
// told, and a box to ask it something and see the answer.
//
// The three belong together because they are one loop. Reading a bad answer is
// what prompts a note; a note is only worth writing if you can check it landed;
// and if it lands badly you want the off switch in the same view.

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const cardStyle = { background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)" } as const;

function KnowledgeRow({ entry, onChanged }: { entry: KnowledgeEntry; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [content, setContent] = useState(entry.content);
  const [busy, setBusy] = useState(false);
  const dirty = title !== entry.title || content !== entry.content;

  async function patch(change: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/support-knowledge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, ...change }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Save failed");
      onChanged();
      toast.success("Saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/support-knowledge?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Delete failed");
      onChanged();
      toast.success("Deleted.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl" style={{ background: "var(--bg-elevated)", border: "1px solid oklch(0 0 0 / 0.07)", opacity: entry.enabled ? 1 : 0.6 }}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button type="button" onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left cursor-pointer">
          {open ? <ChevronDown size={13} className="shrink-0" style={{ color: "var(--c-45)" }} />
                : <ChevronRight size={13} className="shrink-0" style={{ color: "var(--c-45)" }} />}
          <span className="text-sm font-medium truncate" style={{ color: "var(--c-85)" }}>{entry.title}</span>
        </button>
        {/* Off keeps the wording but stops the agent using it — the retraction
            that does not lose what was written. */}
        <button type="button" onClick={() => void patch({ enabled: !entry.enabled })} disabled={busy}
          className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 cursor-pointer disabled:opacity-40"
          style={entry.enabled
            ? { background: "oklch(0.55 0.15 145 / 0.12)", color: "oklch(0.42 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.3)" }
            : { background: "oklch(0 0 0 / 0.05)", color: "var(--c-45)", border: "1px solid oklch(0 0 0 / 0.1)" }}>
          {entry.enabled ? "In use" : "Off"}
        </button>
        <button type="button" onClick={remove} disabled={busy} aria-label="Delete note"
          className="p-1 rounded-lg shrink-0 transition-opacity hover:opacity-70 disabled:opacity-40 cursor-pointer"
          style={{ color: "oklch(0.5 0.18 25)" }}>
          <Trash2 size={13} />
        </button>
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-2" style={{ borderTop: "1px solid oklch(0 0 0 / 0.06)" }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} maxLength={120}
            className="mt-3 w-full px-2.5 py-1.5 rounded-lg text-sm font-medium bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 outline-none" />
          <textarea value={content} onChange={(e) => setContent(e.target.value)} disabled={busy} rows={4} maxLength={4000}
            className="w-full px-2.5 py-1.5 rounded-lg text-xs leading-relaxed resize-y bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 outline-none" />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void patch({ title, content })} disabled={busy || !dirty}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40 cursor-pointer"
              style={{ background: "oklch(0.62 0.15 220)", color: "white" }}>
              {busy ? "Saving…" : "Save"}
            </button>
            <span className="text-[10px]" style={{ color: "var(--c-35)" }}>
              {entry.updated_by ? `Last edited by ${entry.updated_by}` : "Never edited"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function AddNote({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/support-knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not add that");
      setTitle(""); setContent(""); setOpen(false);
      onAdded();
      toast.success("The agent knows this now.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add that");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 cursor-pointer"
        style={{ background: "oklch(0.62 0.15 220)", color: "white" }}>
        <Plus size={13} /> Teach it something
      </button>
    );
  }

  return (
    <div className="rounded-xl p-3 space-y-2" style={{ background: "var(--bg-elevated)", border: "1px solid oklch(0.62 0.15 220 / 0.3)" }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} maxLength={120}
        placeholder="Topic — e.g. Refund policy, KIE outage"
        className="w-full px-2.5 py-1.5 rounded-lg text-sm font-medium bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 outline-none" />
      <textarea value={content} onChange={(e) => setContent(e.target.value)} disabled={busy} rows={4} maxLength={4000}
        placeholder="What it should say. Plain fact — this goes into the prompt as-is."
        className="w-full px-2.5 py-1.5 rounded-lg text-xs leading-relaxed resize-y bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 outline-none" />
      <div className="flex items-center gap-2">
        <button type="button" onClick={submit} disabled={busy || !title.trim() || !content.trim()}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40 cursor-pointer"
          style={{ background: "oklch(0.62 0.15 220)", color: "white" }}>
          {busy ? "Adding…" : "Add"}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 cursor-pointer"
          style={{ background: "oklch(0 0 0 / 0.04)", color: "var(--c-55)", border: "1px solid oklch(0 0 0 / 0.1)" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function TryIt() {
  const [question, setQuestion] = useState("");
  const [asEmail, setAsEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AgentAnswer | null>(null);
  const [ranAs, setRanAs] = useState<string | null>(null);

  async function ask() {
    setBusy(true); setAnswer(null);
    try {
      const res = await fetch("/api/admin/support-agent/try", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, asEmail: asEmail.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The agent failed");
      setAnswer(body.answer as AgentAnswer);
      setRanAs(body.ranAs as string);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The agent failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl p-5 space-y-3" style={cardStyle}>
      <div>
        <p className="text-sm font-semibold" style={{ color: "var(--c-85)" }}>Ask it something</p>
        <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
          Nothing is sent. Add an email to answer as that customer.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <input value={question} onChange={(e) => setQuestion(e.target.value)} disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter" && question.trim() && !busy) void ask(); }}
          placeholder="Why is my voiceover failing?"
          className="flex-1 min-w-0 px-3 py-2 rounded-lg text-sm bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 outline-none" />
        <input value={asEmail} onChange={(e) => setAsEmail(e.target.value)} disabled={busy}
          placeholder="as (optional email)"
          className="w-full sm:w-56 px-3 py-2 rounded-lg text-sm bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 outline-none" />
        <button type="button" onClick={ask} disabled={busy || !question.trim()}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold shrink-0 transition-all hover:opacity-90 disabled:opacity-40 cursor-pointer"
          style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
          {busy ? <Spinner size={13} className="text-white" /> : <Send size={13} />}
          {busy ? "Asking…" : "Ask"}
        </button>
      </div>

      {answer && (
        <div className="rounded-xl p-3 space-y-2" style={{ background: "var(--bg-elevated)", border: "1px solid oklch(0 0 0 / 0.07)" }}>
          <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: "var(--c-85)" }}>{answer.reply}</p>
          <div className="flex items-center gap-2 flex-wrap pt-1" style={{ borderTop: "1px solid oklch(0 0 0 / 0.06)" }}>
            <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full mt-2"
              style={answer.needsHuman
                ? { background: "oklch(0.6 0.19 25 / 0.1)", color: "oklch(0.45 0.15 25)", border: "1px solid oklch(0.6 0.19 25 / 0.3)" }
                : { background: "oklch(0.55 0.15 145 / 0.12)", color: "oklch(0.42 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.3)" }}>
              {answer.needsHuman ? "Would hand off" : "Would answer"}
            </span>
            {ranAs && <span className="text-[10px] mt-2" style={{ color: "var(--c-35)" }}>as {ranAs}</span>}
          </div>
          {/* Shown because a handoff is the outcome most worth checking: if it
              hands off on something a note should have covered, that is the note
              to write. */}
          {answer.needsHuman && answer.ticketSubject && (
            <div className="pt-1">
              <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--c-45)" }}>Ticket it would offer</p>
              <p className="text-xs font-semibold" style={{ color: "var(--c-75)" }}>{answer.ticketSubject}</p>
              <p className="text-xs mt-0.5 leading-relaxed whitespace-pre-wrap" style={{ color: "var(--c-60)" }}>{answer.ticketMessage}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function HeclusAgentPanel() {
  const { data, mutate, isLoading } = useSWR<{ entries: KnowledgeEntry[] }>("/api/admin/support-knowledge", fetcher);
  const entries = data?.entries ?? [];

  return (
    <div className="space-y-4">
      <SupportAgentPanel />

      <div className="rounded-2xl p-5 space-y-3" style={cardStyle}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--c-85)" }}>Knowledge base</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Added to every answer. Prices and plans are already live — no note needed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <KnowledgeUpload onUploaded={() => void mutate()} />
            <AddNote onAdded={() => void mutate()} />
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm py-2" style={{ color: "var(--c-45)" }}>
            <Spinner size={14} /> Loading…
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm italic py-2" style={{ color: "var(--c-35)" }}>
            Empty. It already knows the product and every account&apos;s live state.
          </p>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <KnowledgeRow key={e.id} entry={e} onChanged={() => void mutate()} />
            ))}
          </div>
        )}
      </div>

      <TryIt />
    </div>
  );
}
