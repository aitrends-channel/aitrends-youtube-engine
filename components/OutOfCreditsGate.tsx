"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useOutOfCreditsStore } from "@/store/outOfCreditsStore";

// The empty-wallet refusal, as a modal.
//
// It used to be a red line inside whichever step happened to fail, which put
// the one message a user must act on in the same place as the ones they can
// ignore, and only on the step they were looking at. Mounted once in Providers,
// so any surface can raise it through the store.
//
// Dark, unlike every other modal here: this one interrupts a generation run
// rather than opening a document, so it belongs to the dashboard chrome.

export function OutOfCreditsGate() {
  const router = useRouter();
  const { open, credits, show, hide } = useOutOfCreditsStore();
  const [navigating, setNavigating] = useState(false);
  const [balance, setBalance] = useState<{ credits: number; reserved: number } | null>(null);

  // The refusal reports the balance when it comes back as a 402, but the ones
  // that arrive per beat carry only a message, so the number is read on open.
  // Cheap enough to do every time, and a stale figure in this particular modal
  // is worse than a round trip.
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/heclus-credits", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { credits?: number; reserved?: number }) => {
        if (live && typeof d?.credits === "number") {
          setBalance({ credits: d.credits, reserved: Number(d.reserved ?? 0) });
        }
      })
      .catch(() => { /* the modal still says what to do without a number */ });
    return () => { live = false; };
  }, [open]);

  // Every wallet-gated route refuses the same way: HTTP 402 carrying
  // `outOfCredits`. Catching it here rather than at each call site means a
  // route added later is covered without remembering to wire anything, and the
  // handful of refusals that arrive inside a 200 (a per-beat failure in a
  // batch, a stream event) call reportOutOfCredits directly instead.
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const res = await original(input, init);
      if (res.status === 402) {
        // Clone first: reading the body here must not consume it for the
        // caller that is about to read the same response.
        void res.clone().json().then(
          (body: { error?: string; outOfCredits?: boolean; credits?: number }) => {
            if (body?.outOfCredits) show({ message: body.error, credits: body.credits });
          },
          () => { /* not JSON, so not our refusal */ },
        );
      }
      return res;
    };
    return () => { window.fetch = original; };
  }, [show]);

  const shown = balance?.credits ?? credits;
  const held = balance?.reserved ?? 0;

  function goToBalance() {
    setNavigating(true);
    router.push("/balance");
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !navigating) hide(); }}>
      <DialogContent
        showCloseButton={false}
        className="bg-zinc-950 text-zinc-100 ring-white/10 shadow-2xl"
      >
        <DialogHeader className="gap-1.5">
          <DialogTitle className="text-zinc-50">Out of credits</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Top up to keep generating.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-baseline justify-between rounded-lg px-3 py-2.5 bg-white/[0.04] ring-1 ring-white/10">
          <span className="text-xs uppercase tracking-wider text-zinc-500">Balance</span>
          <span className="text-sm tabular-nums text-zinc-100">
            {shown === null || shown === undefined
              ? "—"
              : shown.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            {held > 0 && (
              <span className="text-zinc-500">
                {" "}· {held.toLocaleString(undefined, { maximumFractionDigits: 2 })} held
              </span>
            )}
          </span>
        </div>
        <DialogFooter className="border-zinc-800 bg-zinc-900/60">
          <button
            onClick={hide}
            disabled={navigating}
            className="py-2 px-4 rounded-lg text-sm font-medium text-zinc-300 ring-1 ring-white/10 transition-colors hover:bg-white/5 disabled:opacity-40"
          >
            Not now
          </button>
          <button
            onClick={goToBalance}
            disabled={navigating}
            className="py-2 px-4 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            style={{ background: "oklch(0.72 0.25 285)" }}
          >
            {navigating ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner size={14} className="text-white" />
                Opening…
              </span>
            ) : "Top up"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
