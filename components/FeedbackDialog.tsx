"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Star, Send, X, CheckCircle2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

// Feedback side dialog — same bottom-right anchoring as the support
// dialog. Opened from HelpButton's Support/Feedback chooser menu, so
// this component is fully controlled and renders no trigger of its own.
//
// Prefills from GET /api/feedback so returning users edit their
// existing rating instead of starting blank; POST upserts either way.

export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [feedbackText, setFeedbackText] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill lazily on first open so page loads don't pay for the fetch.
  useEffect(() => {
    if (!open || prefilled) return;
    let cancelled = false;
    fetch("/api/feedback", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { rating?: number | null; feedbackText?: string | null; firstName?: string | null; lastName?: string | null } | null) => {
        if (cancelled) return;
        if (typeof d?.rating === "number") setRating(d.rating);
        if (typeof d?.feedbackText === "string") setFeedbackText(d.feedbackText);
        if (typeof d?.firstName === "string") setFirstName(d.firstName);
        if (typeof d?.lastName === "string") setLastName(d.lastName);
        setPrefilled(true);
      })
      .catch(() => { if (!cancelled) setPrefilled(true); });
    return () => { cancelled = true; };
  }, [open, prefilled]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating < 1) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating,
          feedbackText: feedbackText.trim() || undefined,
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? "Failed to send feedback");
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send feedback");
    } finally {
      setSubmitting(false);
    }
  }

  function closeAndReset() {
    onClose();
    // Delay past the Dialog fade so the form doesn't flash mid-close.
    setTimeout(() => {
      setSent(false);
      setError(null);
    }, 250);
  }

  const activeRating = hoverRating || rating;

  return (
      <Dialog open={open} onOpenChange={(v) => { if (!v) closeAndReset(); }}>
        <DialogContent
          showCloseButton={false}
          className={
            // Same anchoring as HelpButton's dialog: centered sheet on
            // mobile, bottom-right column on desktop, flush with the
            // floating buttons' baseline.
            "z-[350] max-w-lg " +
            "sm:top-auto sm:left-auto sm:bottom-5 sm:right-5 " +
            "sm:translate-x-0 sm:translate-y-0 " +
            "max-h-[calc(100vh-2.5rem)] " +
            "flex flex-col overflow-hidden"
          }
        >
          <DialogHeader
            className="shrink-0 -mx-4 -mt-4 px-4 pt-4 pb-3 rounded-t-xl"
            style={{ background: "oklch(0.72 0.25 285)" }}
          >
            <div className="flex items-center justify-between gap-3">
              <DialogTitle className="!text-white inline-flex items-center gap-2">
                <Image
                  src="/heclus-icon-white-transparent.svg"
                  alt="Heclus"
                  width={40}
                  height={40}
                  className="shrink-0"
                />
                Feedback
              </DialogTitle>
              <button
                type="button"
                onClick={closeAndReset}
                aria-label="Close feedback"
                className="w-7 h-7 rounded-md inline-flex items-center justify-center transition-colors cursor-pointer hover:bg-white/15"
              >
                <X size={16} className="text-white" />
              </button>
            </div>
            <DialogDescription className="!text-white/90">
              Tell us how Heclus is working for you.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
            {sent ? (
              <div className="flex flex-col items-center text-center py-8 gap-2">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center"
                  style={{ background: "oklch(0.55 0.15 145 / 0.12)", color: "oklch(0.55 0.15 145)" }}
                >
                  <CheckCircle2 size={20} />
                </div>
                <p className="text-sm font-semibold text-zinc-900">Thank you for your feedback!</p>
                <p className="text-xs text-zinc-600">It helps us make Heclus better for everyone.</p>
                <button
                  type="button"
                  onClick={closeAndReset}
                  className="mt-2 text-xs font-medium text-zinc-700 hover:text-zinc-900 underline underline-offset-2 cursor-pointer"
                >
                  Close
                </button>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4 mt-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-zinc-900">How would you rate your experience?</label>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((n) => {
                      const filled = n <= activeRating;
                      return (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setRating(n)}
                          onMouseEnter={() => setHoverRating(n)}
                          onMouseLeave={() => setHoverRating(0)}
                          disabled={submitting}
                          aria-label={`Rate ${n} of 5`}
                          className="p-1 transition-transform hover:scale-110 disabled:cursor-not-allowed"
                        >
                          <Star
                            size={28}
                            strokeWidth={1.5}
                            className={filled ? "fill-amber-400 stroke-amber-400" : "fill-transparent stroke-zinc-300"}
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label htmlFor="feedback-first-name" className="text-sm font-bold text-zinc-900">First name</label>
                    <input
                      id="feedback-first-name"
                      type="text"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      disabled={submitting}
                      maxLength={100}
                      placeholder="First name"
                      className="w-full px-3 py-2.5 rounded-lg text-sm outline-none bg-white text-zinc-900 transition-all"
                      style={{
                        border: "2px solid oklch(0.72 0.25 285 / 0.45)",
                        boxShadow: "0 1px 3px oklch(0 0 0 / 0.08)",
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="feedback-last-name" className="text-sm font-bold text-zinc-900">Last name</label>
                    <input
                      id="feedback-last-name"
                      type="text"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      disabled={submitting}
                      maxLength={100}
                      placeholder="Last name"
                      className="w-full px-3 py-2.5 rounded-lg text-sm outline-none bg-white text-zinc-900 transition-all"
                      style={{
                        border: "2px solid oklch(0.72 0.25 285 / 0.45)",
                        boxShadow: "0 1px 3px oklch(0 0 0 / 0.08)",
                      }}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="feedback-modal-text" className="text-sm font-bold text-zinc-900">
                    Anything you&apos;d like to add? <span className="font-normal text-zinc-400">(optional)</span>
                  </label>
                  <textarea
                    id="feedback-modal-text"
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value)}
                    disabled={submitting}
                    rows={4}
                    maxLength={1000}
                    placeholder="What went well, what would you improve…"
                    className="w-full px-3 py-2.5 rounded-lg text-sm outline-none bg-white text-zinc-900 resize-y transition-all"
                    style={{
                      border: "2px solid oklch(0.72 0.25 285 / 0.45)",
                      boxShadow: "0 1px 3px oklch(0 0 0 / 0.08)",
                    }}
                  />
                </div>

                {error && (
                  <p
                    className="text-xs px-3 py-2 rounded-lg"
                    style={{ background: "oklch(0.6 0.22 25 / 0.08)", color: "oklch(0.55 0.22 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}
                  >
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submitting || rating < 1}
                  className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
                >
                  {submitting ? (
                    <>
                      <Spinner size={14} className="text-white" />
                      Sending…
                    </>
                  ) : (
                    <>
                      <Send size={14} />
                      Send feedback
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        </DialogContent>
      </Dialog>
  );
}
