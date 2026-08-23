"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { isOutOfCreditsMessage } from "@/lib/out-of-credits";
import { useOutOfCreditsStore } from "@/store/outOfCreditsStore";
import { startTopUp } from "@/lib/credits-checkout";

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
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  // The refusal reports the balance when it comes back as a 402, but the ones
  // that arrive per beat carry only a message, so the number is read on open.
  // Cheap enough to do every time, and a stale figure in this particular modal
  // is worse than a round trip.
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/heclus-credits", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { credits?: number; reserved?: number; checkoutUrl?: string | null }) => {
        if (!live) return;
        if (typeof d?.credits === "number") {
          setBalance({ credits: d.credits, reserved: Number(d.reserved ?? 0) });
        }
        setCheckoutUrl(d?.checkoutUrl ?? null);
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

  // The refusal must not also arrive as a toast or an inline error. Suppressing
  // it at each of the ~20 call sites would miss the next one, so the one string
  // is filtered where every one of them ends up.
  useEffect(() => {
    const original = toast.error;
    toast.error = ((message, data) => {
      if (typeof message === "string" && isOutOfCreditsMessage(message)) {
        show({ message });
        return "" as ReturnType<typeof original>;
      }
      return original(message, data);
    }) as typeof toast.error;
    return () => { toast.error = original; };
  }, [show]);

  /**
   * Buys, rather than showing the user where to buy.
   *
   * One pack in a new tab, the same call the Balance page's button makes, so
   * the payment lands back on /payment/callback and credits the wallet. The
   * app stays open behind the checkout: someone who abandons the payment
   * returns to the run they were in the middle of.
   *
   * Falls back to /balance when no pack is configured. A dead button on the
   * one screen that exists to unblock the user is worse than a detour to the
   * page that can explain why.
   */
  function topUp() {
    setNavigating(true);
    if (checkoutUrl) {
      startTopUp(checkoutUrl, 1, "heclus", true);
      // The checkout is a new tab, so this one is still here. Close, because
      // the balance behind it is about to be stale either way.
      setNavigating(false);
      hide();
      return;
    }
    router.push("/balance");
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !navigating) hide(); }}>
      <DialogContent
        showCloseButton={false}
        // p-6 needs the footer's negative margins to match, below.
        className="bg-zinc-950 text-zinc-100 ring-white/10 shadow-2xl p-6 gap-5 sm:max-w-md"
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="text-zinc-50">Out of credits</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Top up to keep generating.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-relaxed text-zinc-500">
          Balance{" "}
          {/* Fixed red rather than --accent-red-text: that token flips with the
              app theme, and its light-theme value is a dark red that would be
              unreadable on this always-dark surface. */}
          <span className="tabular-nums font-medium" style={{ color: "oklch(0.72 0.19 25)" }}>
            {shown === null || shown === undefined
              ? "—"
              : shown.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
          {" "}credits
          {held > 0 && `, ${held.toLocaleString(undefined, { maximumFractionDigits: 2 })} held`}
        </p>
        <DialogFooter className="-mx-6 -mb-6 mt-1 gap-2.5 border-zinc-800 bg-zinc-900/60 px-6 py-4">
          <button
            onClick={hide}
            disabled={navigating}
            className="h-10 px-5 rounded-lg text-sm font-medium text-zinc-300 ring-1 ring-white/10 transition-colors hover:bg-white/5 disabled:opacity-40"
          >
            Not now
          </button>
          <button
            onClick={topUp}
            disabled={navigating}
            className="h-10 px-5 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            style={{ background: "oklch(0.72 0.25 285)" }}
          >
            {navigating ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner size={14} className="text-white" />
                Opening checkout…
              </span>
            ) : "Top up"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
