"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { isOutOfCreditsMessage } from "@/lib/out-of-credits";
import { useOutOfCreditsStore } from "@/store/outOfCreditsStore";
import { startTopUp } from "@/lib/credits-checkout";

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

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
  const { open, kind, credits, needed, alternative, modelName, count, affordable, show, hide, choose } = useOutOfCreditsStore();
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
          (body: { error?: string; outOfCredits?: boolean; credits?: number; needed?: number }) => {
            if (body?.outOfCredits) show({ message: body.error, credits: body.credits, needed: body.needed });
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
   * Falls back to /billing when no pack is configured. A dead button on the
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
    router.push("/billing");
  }

  // Whether the balance covers some but not all of it. Needs a count to divide
  // by, and at least one whole generation to offer.
  const partial =
    kind === "short" &&
    needed !== null && typeof count === "number" && count > 1 &&
    typeof affordable === "number" && affordable >= 1 && affordable < count;
  // After a switch the balance covers the whole run, so the modal is a
  // confirmation rather than a refusal.
  const ready = kind === "ready" && typeof count === "number";

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !navigating) hide(); }}>
      <DialogContent
        showCloseButton={false}
        // p-6 needs the footer's negative margins to match, below.
        className="bg-zinc-950 text-zinc-100 ring-white/10 shadow-2xl p-6 gap-5 sm:max-w-md"
      >
        <DialogHeader className="gap-2">
          {/* Two different situations, and telling them apart matters: a wallet
              at zero is not the same as a wallet that cannot cover this
              particular run, and the second one still has credits to spend on
              something smaller. */}
          {/* Three situations, not two. A wallet at zero, a wallet that cannot
              cover this run at all, and a wallet that covers part of it. The
              third is the common one on a long project and it is the only one
              where the useful sentence is a number of beats rather than a
              number of credits. */}
          <DialogTitle className="text-zinc-50">
            {ready
              ? `Switched to ${modelName}`
              : needed === null
                ? "Out of credits"
                : partial
                  ? `Enough for ${affordable} of ${count}`
                  : "Not enough for this run"}
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            {ready
              ? `${modelName} runs all ${count} for about ${fmt(needed ?? 0)} credits, which your balance covers.`
              : needed === null
                ? "Top up to keep generating."
                : partial
                  ? `${modelName ?? "This run"} costs about ${fmt(needed / (count as number))} credits each, so your balance covers ${affordable} of the ${count}. Generate those now, or top up for the rest.`
                  : `${modelName ?? "This run"} needs about ${fmt(needed)} credits${count ? ` for ${count}` : ""}.`}
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
          {held > 0 && `, ${fmt(held)} held`}
        </p>
        {alternative && (
          <p className="-mt-3 text-sm text-zinc-500">
            <span className="text-zinc-300">{alternative.name}</span> would run all {count ?? "of them"} for {fmt(alternative.total)} credits.
          </p>
        )}
        <DialogFooter className="-mx-6 -mb-6 mt-1 flex-wrap gap-2.5 border-zinc-800 bg-zinc-900/60 px-6 py-4">
          <button
            onClick={hide}
            disabled={navigating}
            className="h-10 px-5 rounded-lg text-sm font-medium text-zinc-300 ring-1 ring-white/10 transition-colors hover:bg-white/5 disabled:opacity-40"
          >
            Not now
          </button>
          {/* Switching is the option that costs nothing and finishes the run, so
              it sits with the other actions rather than being described in a
              sentence the user has to go and act on somewhere else. Re-prices
              rather than starting anything: the modal comes back with the new
              model's figures and the user decides again. */}
          {!ready && alternative && (
            <button
              onClick={() => choose("switch")}
              disabled={navigating}
              className="h-10 px-5 rounded-lg text-sm font-semibold text-zinc-100 ring-1 ring-white/15 transition-colors hover:bg-white/5 disabled:opacity-40"
            >
              Switch to {alternative.name}
            </button>
          )}
          {/* The action the user came for, when there is one. Placed before Top
              up because getting 14 of 19 done now is usually what they want,
              and paying is the fallback rather than the ask. */}
          {(partial || ready) && (
            <button
              onClick={() => choose(affordable)}
              disabled={navigating}
              className={ready
                ? "h-10 px-5 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                : "h-10 px-5 rounded-lg text-sm font-semibold text-zinc-100 ring-1 ring-white/15 transition-colors hover:bg-white/5 disabled:opacity-40"}
              style={ready ? { background: "oklch(0.72 0.25 285)" } : undefined}
            >
              Generate {affordable}
            </button>
          )}
          <button
            onClick={topUp}
            disabled={navigating}
            className={`h-10 px-5 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60 ${ready ? "hidden" : ""}`}
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
