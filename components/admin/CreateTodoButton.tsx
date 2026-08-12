"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ListPlus, Check } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { FeatureRequest } from "@/lib/feature-requests";

// Files a ticket as a feature request, from the ticket itself.
//
// It opens a prefilled form rather than filing on the first click. A ticket
// subject is written by a customer mid-problem, so it is often "Hi" or
// "Testing", and a board full of those is worth nothing. The title is the one
// field that has to be right, so it gets one look before the row exists.
//
// Filing the same ticket twice is checked first, against source: the board's
// value is its count, and two rows for one ticket quietly break it.

const inputClass =
  "w-full px-2.5 py-1.5 rounded-lg text-sm bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 outline-none";

/** Fallback prefill when the summariser is unreachable: enough of the
 *  customer's own words to recognise the request later. */
function excerpt(message: string, limit = 600): string {
  const t = message.trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return (stop > limit * 0.5 ? cut.slice(0, stop + 1) : cut).trim() + "…";
}

export function CreateTodoButton({ ticketRef, subject, message, email }: {
  ticketRef: string;
  subject: string | null;
  message: string | null;
  email: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filed, setFiled] = useState<FeatureRequest | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  // Set from the summary when the model judges this a problem report rather
  // than a request. Shown, not enforced: the admin decides.
  const [notARequest, setNotARequest] = useState(false);

  async function start() {
    if (open) {
      setOpen(false);
      return;
    }
    setChecking(true);
    try {
      const res = await fetch("/api/admin/feature-requests");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not read the board");
      const existing = ((data.requests ?? []) as FeatureRequest[])
        .find((r) => (r.source ?? "").trim().toLowerCase() === ticketRef.toLowerCase());
      if (existing) {
        setFiled(existing);
        toast.info(`Already filed as "${existing.title}".`);
        return;
      }
      // Read the ticket for a title worth putting on a board. A customer
      // writing mid-problem gives subjects like "Hi" and "Testing", so the
      // subject is the fallback rather than the default.
      const sum = await fetch("/api/admin/feature-requests/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, message }),
      });
      const s = await sum.json().catch(() => ({}));
      if (sum.ok && typeof s.title === "string") {
        setTitle(s.title);
        setNotes(s.notes ?? "");
        setNotARequest(s.looksLikeRequest === false);
      } else {
        // Summarising is a convenience, never a gate: fall back to the raw
        // ticket so the button still works when the model is unavailable.
        setTitle(subject?.trim() ?? "");
        setNotes(excerpt(message ?? ""));
        setNotARequest(false);
      }
      setOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read the board");
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    if (!title.trim()) {
      toast.error("Give the to-do a title first.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/feature-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, notes, requester: email, source: ticketRef }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not file it");
      setFiled(data.request as FeatureRequest);
      setOpen(false);
      toast.success("Filed under Feature requests.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not file it");
    } finally {
      setSaving(false);
    }
  }

  if (filed && !open) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
        style={{ background: "oklch(0.55 0.15 145 / 0.12)", color: "oklch(0.42 0.15 145)" }}
        title={`On the board as "${filed.title}"`}>
        <Check size={13} />
        To-do filed
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={start}
        disabled={checking || saving}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
        style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
      >
        {checking ? <Spinner size={13} /> : <ListPlus size={13} />}
        {checking ? "Reading ticket…" : open ? "Cancel" : "Create to-do"}
      </button>

      {open && (
        // basis-full so the form drops to its own line instead of squeezing the
        // buttons it sits beside.
        <div className="basis-full rounded-xl p-3 space-y-2 mt-1"
          style={{ background: "oklch(0.72 0.25 285 / 0.04)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}>
          {notARequest && (
            <p className="text-[11px] leading-relaxed" style={{ color: "oklch(0.5 0.16 75)" }}>
              This reads more like a problem report than a feature request. File it
              anyway if it belongs on the board.
            </p>
          )}
          <div className="space-y-1">
            <label className="text-[11px] font-medium" style={{ color: "var(--c-50)" }}>
              What they are asking for
            </label>
            <input className={inputClass} value={title} disabled={saving} autoFocus
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Say it as a thing we could build" />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-medium" style={{ color: "var(--c-50)" }}>
              Notes, in their words
            </label>
            <textarea className={inputClass} rows={3} value={notes} disabled={saving}
              onChange={(e) => setNotes(e.target.value)} />
          </div>
          <p className="text-[11px]" style={{ color: "var(--c-45)" }}>
            Filed against {ticketRef}{email ? ` for ${email}` : ""}.
          </p>
          <button type="button" onClick={save} disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
            {saving && <Spinner size={12} />}
            {saving ? "Filing…" : "File to-do"}
          </button>
        </div>
      )}
    </>
  );
}
