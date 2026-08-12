"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { FEATURE_REQUEST_STATUSES, type FeatureRequest, type FeatureRequestStatus } from "@/lib/feature-requests";

// The feature-request board. Ordered most-asked first, because the count is the
// only thing here that cannot be reconstructed from the mailbox later.

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const STATUSES = FEATURE_REQUEST_STATUSES;

const STATUS_STYLE: Record<FeatureRequestStatus, { bg: string; fg: string; label: string }> = {
  new:      { bg: "oklch(0.62 0.15 220 / 0.12)", fg: "oklch(0.45 0.15 220)", label: "New" },
  planned:  { bg: "oklch(0.72 0.25 285 / 0.12)", fg: "oklch(0.5 0.2 285)",   label: "Planned" },
  shipped:  { bg: "oklch(0.55 0.15 145 / 0.12)", fg: "oklch(0.45 0.15 145)", label: "Shipped" },
  declined: { bg: "oklch(0 0 0 / 0.06)",         fg: "var(--c-55)",          label: "Declined" },
};

const inputClass =
  "w-full px-2.5 py-1.5 rounded-lg text-sm bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 outline-none";

export function FeatureRequestsPanel() {
  const { data, mutate, isLoading } = useSWR<{ requests: FeatureRequest[] }>(
    "/api/admin/feature-requests", fetcher);
  const requests = data?.requests ?? [];

  const [filter, setFilter] = useState<FeatureRequestStatus | "all">("all");
  const [adding, setAdding] = useState(false);
  // One row acts at a time, and the label says which verb is running, so a slow
  // save never looks like a click that did nothing.
  const [busy, setBusy] = useState<{ id: string; verb: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: requests.length };
    for (const s of STATUSES) c[s] = requests.filter((r) => r.status === s).length;
    return c;
  }, [requests]);

  const shown = filter === "all" ? requests : requests.filter((r) => r.status === filter);

  async function call(init: RequestInit & { verb: string; id: string }, ok: string) {
    const { verb, id, ...rest } = init;
    setBusy({ id, verb });
    try {
      const res = await fetch("/api/admin/feature-requests", rest);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `${verb} failed`);
      await mutate();
      toast.success(ok);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${verb} failed`);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy({ id, verb: "Deleting" });
    try {
      const res = await fetch(`/api/admin/feature-requests?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Delete failed");
      await mutate();
      setConfirmDeleteId(null);
      toast.success("Request deleted.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm py-6" style={{ color: "var(--c-45)" }}>
        <Spinner size={14} /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--c-85)" }}>
            {requests.length} {requests.length === 1 ? "request" : "requests"}
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
            One person asking is an anecdote. Keep the count and it becomes a roadmap.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold shrink-0 cursor-pointer transition-all hover:opacity-90"
          style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
        >
          {adding ? <X size={13} /> : <Plus size={13} />}
          {adding ? "Cancel" : "Add request"}
        </button>
      </div>

      {adding && <AddForm onDone={async () => { setAdding(false); await mutate(); }} />}

      {/* Status filters, with counts so an empty tab is obvious before it is opened. */}
      <div className="flex gap-1 flex-wrap">
        {(["all", ...STATUSES] as const).map((s) => {
          const on = filter === s;
          const label = s === "all" ? "All" : STATUS_STYLE[s].label;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className="px-3 py-1.5 rounded-full text-[11px] font-semibold cursor-pointer transition-all"
              style={on
                ? { background: "oklch(0.72 0.25 285)", color: "white" }
                : { background: "oklch(0 0 0 / 0.04)", color: "var(--c-55)" }}
            >
              {label} · {counts[s] ?? 0}
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <p className="text-xs py-6 text-center" style={{ color: "var(--c-45)" }}>
          {requests.length === 0
            ? "Nothing logged yet. Add the first thing a customer asked for."
            : "Nothing with that status."}
        </p>
      ) : (
        <div className="space-y-2">
          {shown.map((r) => {
            const style = STATUS_STYLE[r.status];
            const rowBusy = busy?.id === r.id;
            return (
              <div key={r.id} className="rounded-xl p-3"
                style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid oklch(0 0 0 / 0.06)" }}>
                <div className="flex items-start gap-3 flex-wrap">
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-semibold"
                    style={{ background: style.bg, color: style.fg }}>
                    {style.label}
                  </span>
                  <div className="min-w-0 grow">
                    <p className="text-sm font-medium break-words" style={{ color: "var(--c-90)" }}>{r.title}</p>
                    <p className="text-[11px] mt-0.5" style={{ color: "var(--c-45)" }}>
                      {r.asked_count} {r.asked_count === 1 ? "person asked" : "people asked"}
                      {r.requester ? ` · latest ${r.requester}` : ""}
                      {r.source ? ` · from ${r.source}` : ""}
                    </p>
                    {r.notes && (
                      <p className="text-xs mt-1.5 leading-relaxed whitespace-pre-wrap break-words"
                        style={{ color: "var(--c-60)" }}>
                        {r.notes}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* One more person asked. The commonest edit by far, so it is
                        a single click rather than a trip through the form. */}
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => call({
                        id: r.id, verb: "Saving", method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: r.id, asked_count: r.asked_count + 1 }),
                      }, "Count updated.")}
                      title="Someone else asked for this"
                      className="px-2 py-1 rounded-lg text-[11px] font-semibold cursor-pointer transition-all hover:opacity-80 disabled:opacity-40"
                      style={{ background: "oklch(0 0 0 / 0.05)", color: "var(--c-60)" }}
                    >
                      +1
                    </button>

                    <select
                      value={r.status}
                      disabled={rowBusy}
                      onChange={(e) => call({
                        id: r.id, verb: "Saving", method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: r.id, status: e.target.value }),
                      }, "Status updated.")}
                      className="px-2 py-1 rounded-lg text-[11px] bg-white text-zinc-900 ring-1 ring-zinc-200 outline-none cursor-pointer disabled:opacity-40"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>{STATUS_STYLE[s].label}</option>
                      ))}
                    </select>

                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => setEditingId(editingId === r.id ? null : r.id)}
                      className="p-1.5 rounded-lg cursor-pointer transition-all hover:opacity-70 disabled:opacity-40"
                      style={{ color: "var(--c-50)" }}
                      title="Edit"
                    >
                      <Pencil size={13} />
                    </button>

                    {confirmDeleteId === r.id ? (
                      <button
                        type="button"
                        disabled={rowBusy}
                        onClick={() => remove(r.id)}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold cursor-pointer disabled:opacity-40"
                        style={{ background: "oklch(0.6 0.22 25)", color: "white" }}
                      >
                        {rowBusy && busy?.verb === "Deleting" ? <Spinner size={11} /> : null}
                        {rowBusy && busy?.verb === "Deleting" ? "Deleting…" : "Confirm"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={rowBusy}
                        onClick={() => setConfirmDeleteId(r.id)}
                        className="p-1.5 rounded-lg cursor-pointer transition-all hover:opacity-70 disabled:opacity-40"
                        style={{ color: "oklch(0.55 0.2 25)" }}
                        title="Delete"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>

                {editingId === r.id && (
                  <EditForm
                    request={r}
                    busy={rowBusy}
                    onCancel={() => setEditingId(null)}
                    onSave={async (patch) => {
                      const ok = await call({
                        id: r.id, verb: "Saving", method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: r.id, ...patch }),
                      }, "Request saved.");
                      if (ok) setEditingId(null);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddForm({ onDone }: { onDone: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [requester, setRequester] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!title.trim()) {
      toast.error("Give it a title first.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/feature-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, requester, notes }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Save failed");
      setTitle(""); setRequester(""); setNotes("");
      toast.success("Request added.");
      await onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl p-3 space-y-2"
      style={{ background: "oklch(0.72 0.25 285 / 0.04)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}>
      <input className={inputClass} placeholder="What they asked for"
        value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} autoFocus />
      <input className={inputClass} placeholder="Who asked (email, or where it came from)"
        value={requester} onChange={(e) => setRequester(e.target.value)} disabled={saving} />
      <textarea className={inputClass} rows={2} placeholder="Notes, in their words if you have them"
        value={notes} onChange={(e) => setNotes(e.target.value)} disabled={saving} />
      <button type="button" onClick={save} disabled={saving}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer transition-all hover:opacity-90 disabled:opacity-50"
        style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
        {saving && <Spinner size={12} />}
        {saving ? "Saving…" : "Save request"}
      </button>
    </div>
  );
}

function EditForm({ request, busy, onSave, onCancel }: {
  request: FeatureRequest;
  busy: boolean;
  onSave: (patch: { title: string; requester: string; notes: string; asked_count: number }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(request.title);
  const [requester, setRequester] = useState(request.requester ?? "");
  const [notes, setNotes] = useState(request.notes ?? "");
  const [count, setCount] = useState(String(request.asked_count));

  return (
    <div className="mt-3 pt-3 space-y-2" style={{ borderTop: "1px solid oklch(0 0 0 / 0.06)" }}>
      <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
      <div className="flex gap-2">
        <input className={inputClass} placeholder="Who asked"
          value={requester} onChange={(e) => setRequester(e.target.value)} disabled={busy} />
        <input className={`${inputClass} w-24 text-right`} type="number" min={1} title="How many asked"
          value={count} onChange={(e) => setCount(e.target.value)} disabled={busy} />
      </div>
      <textarea className={inputClass} rows={2} placeholder="Notes"
        value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} />
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy}
          onClick={() => onSave({ title, requester, notes, asked_count: Math.max(1, Number(count) || 1) })}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all hover:opacity-90 disabled:opacity-50"
          style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
          {busy && <Spinner size={12} />}
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:opacity-80 disabled:opacity-50"
          style={{ background: "transparent", color: "var(--c-55)", border: "1px solid oklch(0 0 0 / 0.1)" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
