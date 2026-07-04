"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Star, Pencil, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { AdminReviewsResponse, AdminReview } from "@/app/api/admin/reviews/route";

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

function ReviewRow({ review, onSaved }: { review: AdminReview; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(review.rating ?? 0);
  const [reviewText, setReviewText] = useState(review.review_text ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (rating < 1) {
      toast.error("Select a rating first");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/reviews", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: review.user_id, rating, reviewText: reviewText.trim() || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? "Failed to save review");
      }
      toast.success("Review updated.");
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save review");
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
            : <Stars rating={review.rating ?? 0} />}
          <span className="text-xs font-medium truncate text-foreground">
            {review.user_email ?? review.user_id}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px]" style={{ color: "oklch(0.55 0 0)" }}>
            {new Date(review.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
          </span>
          <button
            onClick={() => {
              if (editing) {
                // Cancel — reset draft state back to the stored values.
                setRating(review.rating ?? 0);
                setReviewText(review.review_text ?? "");
              }
              setEditing((v) => !v);
            }}
            disabled={saving}
            aria-label={editing ? "Cancel edit" : "Edit review"}
            title={editing ? "Cancel" : "Edit"}
            className="p-1.5 rounded-lg transition-all cursor-pointer hover:bg-zinc-100 disabled:opacity-50"
            style={{ color: "oklch(0.5 0 0)" }}
          >
            {editing ? <X size={13} /> : <Pencil size={13} />}
          </button>
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-3">
          <textarea
            value={reviewText}
            onChange={(e) => setReviewText(e.target.value)}
            disabled={saving}
            rows={3}
            maxLength={1000}
            placeholder="Review text (optional)"
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
        review.review_text && (
          <p className="text-sm mt-2 whitespace-pre-wrap" style={{ color: "oklch(0.35 0 0)" }}>
            {review.review_text}
          </p>
        )
      )}
    </div>
  );
}

export function ReviewsPanel() {
  const { data, isLoading, mutate } = useSWR<AdminReviewsResponse>("/api/admin/reviews", fetcher, {
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
          <h2 className="text-lg font-bold text-foreground">Reviews</h2>
          <p className="text-xs" style={{ color: "oklch(0.5 0 0)" }}>
            One-time ratings collected after a user&apos;s first completed pipeline
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
                <ReviewRow key={r.user_id} review={r} onSaved={() => mutate()} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
