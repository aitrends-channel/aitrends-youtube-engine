"use client";

import { useEffect, useState } from "react";
import { X, Star, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  /** Called after a successful submit or dismiss. Parent should then
   *  hide the modal AND flip its local hasResponded flag so we don't
   *  re-open on the next render pass. */
  onDone: () => void;
  /** "just-completed" — user hit 100% this session (thumbnails page).
   *  "returning" — existing user who completed a pipeline in the past
   *  and is being back-filled on a later visit (dashboard). Only the
   *  copy differs. */
  variant?: "just-completed" | "returning";
}

export function ReviewModal({ onDone, variant = "just-completed" }: Props) {
  const [rating, setRating] = useState<number>(0);
  const [hoverRating, setHoverRating] = useState<number>(0);
  const [reviewText, setReviewText] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  // After a successful submit the modal body swaps to an in-place
  // thank-you view (same size, same position — impossible to miss),
  // holds for a beat, then auto-closes via the effect below.
  const [thanked, setThanked] = useState(false);

  useEffect(() => {
    if (!thanked) return;
    const t = setTimeout(onDone, 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thanked]);

  async function post(payload: { rating?: number; reviewText?: string }): Promise<boolean> {
    const res = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err?.error ?? "Something went wrong — please try again");
      return false;
    }
    return true;
  }

  async function handleSubmit() {
    if (rating < 1) {
      toast.error("Please select a rating first");
      return;
    }
    setSubmitting(true);
    const ok = await post({ rating, reviewText: reviewText.trim() || undefined });
    setSubmitting(false);
    if (ok) setThanked(true);
  }

  async function handleDismiss() {
    setDismissing(true);
    // Persist a bare row so we don't prompt again — dismissal is still
    // a "response" for the one-time gate.
    await post({});
    setDismissing(false);
    onDone();
  }

  const activeRating = hoverRating || rating;

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center p-4"
      style={{ background: "oklch(0 0 0 / 0.72)", backdropFilter: "blur(6px)" }}
    >
      <div className="relative w-full max-w-md rounded-2xl overflow-hidden bg-white shadow-2xl">
        {thanked ? (
          /* In-place thank-you — replaces the form in the same card so
             the confirmation lands exactly where the user was looking,
             then the effect above auto-closes after 2s. */
          <div className="p-10 flex flex-col items-center text-center gap-3">
            <CheckCircle2 size={44} strokeWidth={1.75} className="text-emerald-500" />
            <h2 className="text-xl font-bold text-zinc-900">Thank you for your feedback!</h2>
            <p className="text-sm text-zinc-500">It helps us make Heclus better for everyone.</p>
          </div>
        ) : (
        <>
        <button
          onClick={handleDismiss}
          disabled={submitting || dismissing}
          aria-label="Skip"
          title="Skip"
          className="absolute top-4 right-4 z-10 h-8 w-8 rounded-full flex items-center justify-center transition-all cursor-pointer hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-500"
        >
          <X size={16} />
        </button>

        <div className="p-8 space-y-5">
          {/* Header */}
          <div className="text-center space-y-2">
            <h2 className="text-xl font-bold text-zinc-900">
              {variant === "returning" ? "How has Heclus been for you?" : "How was your experience?"}
            </h2>
            <p className="text-sm text-zinc-500">
              {variant === "returning"
                ? "You've built full videos with Heclus — mind sharing a quick rating?"
                : "You just built a full video with Heclus — mind sharing a quick rating?"}
            </p>
          </div>

          {/* Star rating */}
          <div className="flex items-center justify-center gap-2 pt-2">
            {[1, 2, 3, 4, 5].map((n) => {
              const filled = n <= activeRating;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(n)}
                  onMouseEnter={() => setHoverRating(n)}
                  onMouseLeave={() => setHoverRating(0)}
                  disabled={submitting || dismissing}
                  aria-label={`Rate ${n} of 5`}
                  className="p-1 transition-transform hover:scale-110 disabled:cursor-not-allowed"
                >
                  <Star
                    size={32}
                    strokeWidth={1.5}
                    className={filled ? "fill-amber-400 stroke-amber-400" : "fill-transparent stroke-zinc-300"}
                  />
                </button>
              );
            })}
          </div>

          {/* Review text */}
          <div className="space-y-1.5">
            <label htmlFor="review-text" className="block text-xs font-medium text-zinc-600">
              Anything you&apos;d like to add? <span className="text-zinc-400">(optional)</span>
            </label>
            <textarea
              id="review-text"
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
              disabled={submitting || dismissing}
              rows={3}
              placeholder="What went well, what would you improve…"
              className="w-full px-3 py-2 rounded-lg bg-zinc-50 border border-zinc-200 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 disabled:opacity-60 resize-none"
              maxLength={1000}
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleDismiss}
              disabled={submitting || dismissing}
              className="flex-1 py-2.5 rounded-lg text-sm font-medium text-zinc-600 bg-zinc-100 hover:bg-zinc-200 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
            >
              {dismissing ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Skipping…
                </span>
              ) : "Skip"}
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting || dismissing || rating < 1}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
            >
              {submitting ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Submitting…
                </span>
              ) : "Submit"}
            </button>
          </div>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
