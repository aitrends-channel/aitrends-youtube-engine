"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Star, Pencil, X, Trash2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { AdminFeedbackResponse, AdminFeedback } from "@/app/api/admin/feedback/route";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function Stars({ rating, onSelect, disabled }: { rating: number; onSelect?: (n: number) => void; disabled?: boolean }) {
  const interactive = !!onSelect;
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => {
        const star = (
          <Star
            key={interactive ? undefined : n}
            size={interactive ? 20 : 14}
            strokeWidth={1.5}
            className={n <= rating ? "fill-amber-400 stroke-amber-400" : "fill-transparent stroke-zinc-300"}
          />
        );
        if (!interactive) return star;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onSelect(n)}
            disabled={disabled}
            aria-label={`Rate ${n} of 5`}
            className="p-0.5 transition-transform hover:scale-110 disabled:cursor-not-allowed"
          >
            {star}
          </button>
        );
      })}
    </span>
  );
}

function FeedbackRow({ feedback, onSaved }: { feedback: AdminFeedback; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(feedback.rating ?? 0);
  const [feedbackText, setFeedbackText] = useState(feedback.feedback_text ?? "");
  const [saving, setSaving] = useState(false);
  // Two-step delete: first click arms the confirm state (button turns
  // red "Confirm"), second click actually deletes. Any other
  // interaction can leave it armed harmlessly — it disarms on save.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch("/api/admin/feedback", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: feedback.user_id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? "Failed to delete feedback");
      }
      toast.success("Feedback deleted. The user will be prompted again after their next completion signal.");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete feedback");
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  async function handleSave() {
    if (rating < 1) {
      toast.error("Select a rating first");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/feedback", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: feedback.user_id, rating, feedbackText: feedbackText.trim() || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? "Failed to save feedback");
      }
      toast.success("Feedback updated.");
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save feedback");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl p-4"
      style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid oklch(0 0 0 / 0.07)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          {editing
            ? <Stars rating={rating} onSelect={setRating} disabled={saving} />
            : <Stars rating={feedback.rating ?? 0} />}
          <span className="min-w-0 flex flex-col leading-tight">
            <span className="text-xs font-medium truncate text-foreground">
              {[feedback.first_name, feedback.last_name].filter(Boolean).join(" ")
                || feedback.user_email
                || feedback.user_id}
            </span>
            {(feedback.first_name || feedback.last_name) && feedback.user_email && (
              <span className="text-[10px] truncate" style={{ color: "oklch(0.55 0 0)" }}>
                {feedback.user_email}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px]" style={{ color: "oklch(0.55 0 0)" }}>
            {new Date(feedback.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
          </span>
          <button
            onClick={() => {
              if (editing) {
                // Cancel — reset draft state back to the stored values.
                setRating(feedback.rating ?? 0);
                setFeedbackText(feedback.feedback_text ?? "");
              }
              setEditing((v) => !v);
            }}
            disabled={saving || deleting}
            aria-label={editing ? "Cancel edit" : "Edit feedback"}
            title={editing ? "Cancel" : "Edit"}
            className="p-1.5 rounded-lg transition-all cursor-pointer hover:bg-zinc-100 disabled:opacity-50"
            style={{ color: "oklch(0.5 0 0)" }}
          >
            {editing ? <X size={13} /> : <Pencil size={13} />}
          </button>
          <button
            onClick={handleDelete}
            disabled={saving || deleting}
            aria-label={confirmingDelete ? "Confirm delete" : "Delete feedback"}
            title={confirmingDelete ? "Click again to confirm" : "Delete"}
            className={`p-1.5 rounded-lg transition-all cursor-pointer disabled:opacity-50 inline-flex items-center gap-1 ${
              confirmingDelete ? "bg-red-50 hover:bg-red-100" : "hover:bg-zinc-100"
            }`}
            style={{ color: confirmingDelete ? "oklch(0.55 0.2 25)" : "oklch(0.5 0 0)" }}
          >
            {deleting
              ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              : <Trash2 size={13} />}
            {confirmingDelete && !deleting && <span className="text-[10px] font-semibold">Confirm</span>}
          </button>
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-3">
          <textarea
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            disabled={saving}
            rows={3}
            maxLength={1000}
            placeholder="Feedback text (optional)"
            className="w-full px-3 py-2 rounded-lg bg-white border border-zinc-200 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 disabled:opacity-60 resize-none"
          />
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving || rating < 1}
              className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all inline-flex items-center gap-2"
            >
              {saving ? (
                <>
                  <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Saving…
                </>
              ) : "Save"}
            </button>
          </div>
        </div>
      ) : (
        feedback.feedback_text && (
          <p className="text-sm mt-2 whitespace-pre-wrap" style={{ color: "oklch(0.35 0 0)" }}>
            {feedback.feedback_text}
          </p>
        )
      )}
    </div>
  );
}

export function FeedbackPanel() {
  const { data, isLoading, mutate } = useSWR<AdminFeedbackResponse>("/api/admin/feedback", fetcher, {
    revalidateOnFocus: false,
  });

  const reviews = data?.reviews ?? [];
  const withRating = reviews.filter((r) => r.rating !== null);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.75 0.15 85 / 0.12)", border: "1px solid oklch(0.75 0.15 85 / 0.25)" }}>
          <Star size={16} style={{ color: "oklch(0.7 0.15 85)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Feedback</h2>
          <p className="text-xs" style={{ color: "oklch(0.5 0 0)" }}>
            One-time feedback collected after a user&apos;s first completed pipeline
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-3">
            {[
              {
                label: "Average rating",
                value: data?.averageRating !== null && data?.averageRating !== undefined
                  ? `${data.averageRating} / 5`
                  : "—",
              },
              { label: "Ratings", value: String(data?.ratedCount ?? 0) },
              { label: "Skipped", value: String(data?.dismissedCount ?? 0) },
            ].map((c) => (
              <div key={c.label} className="rounded-xl p-4"
                style={{ background: "oklch(0 0 0 / 0.03)", border: "1px solid oklch(0 0 0 / 0.07)" }}>
                <p className="text-[11px] uppercase tracking-wide" style={{ color: "oklch(0.5 0 0)" }}>{c.label}</p>
                <p className="text-xl font-bold mt-1 text-foreground">{c.value}</p>
              </div>
            ))}
          </div>

          {/* Review list */}
          {withRating.length === 0 ? (
            <p className="text-sm text-center py-10" style={{ color: "oklch(0.5 0 0)" }}>
              No ratings yet.
            </p>
          ) : (
            <div className="space-y-2">
              {withRating.map((r) => (
                <FeedbackRow key={r.user_id} feedback={r} onSaved={() => mutate()} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
