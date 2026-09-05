"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Wallet } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { ApiKeysStatus } from "@/app/api/me/api-keys-status/route";

// Told once, to the people it is about.
//
// New accounts run on Heclus Credits and never see a provider key. Accounts
// that predate that still run on their own, and nothing had told them either
// that the product moved or that the move is optional for them. A customer
// finding out from a changed setup page is a support ticket.
//
// Shown to bring-your-own accounts only, once, and dismissable. The flag is in
// localStorage rather than on the account: it is a notice, not a preference,
// and one that reappears on a second browser is a smaller failure than a
// migration to store it.

const SEEN_KEY = "heclus.announce.credits-v1";

export function CreditsAnnouncement() {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  // ?announce=1 shows it whatever the flag says, for checking the thing itself.
  // Read from the hook and from the URL, because a page that has not finished
  // hydrating hands the hook an empty set and the override then does nothing.
  const forced =
    params.get("announce") === "1" ||
    (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("announce") === "1");

  useEffect(() => {
    // Forced opens straight away. It used to wait on the status call and open
    // only if that resolved, so a failed or slow request made the override look
    // broken: the one thing an override must not do.
    if (forced) { setOpen(true); return; }

    let live = true;
    try {
      if (window.localStorage.getItem(SEEN_KEY)) return;
    } catch { /* private mode: show it, once per session at worst */ }
    void fetch("/api/me/api-keys-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: ApiKeysStatus | null) => {
        if (!live || !s) return;
        // The people this is about: still on their own keys, not on a credits
        // plan. Anyone already moved has nothing to be told.
        if (s.fundingMode === "byo" && !s.onHeclusCreditsPlan) setOpen(true);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [forced]);

  function close() {
    setOpen(false);
    try { window.localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* nothing to do */ }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      {/* Dark on purpose. DialogContent ships white with zinc text, which is
          right for the forms it was built for and wrong for a notice that
          appears over a dark dashboard: a white sheet reads as an error before
          it reads as news. */}
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[26rem] p-0 gap-0 border-0"
        style={{ background: "oklch(0.14 0.005 285)", border: "1px solid oklch(1 0 0 / 0.10)", boxShadow: "0 24px 60px oklch(0 0 0 / 0.55)" }}
      >
        <div className="p-7">
          <div className="w-11 h-11 rounded-2xl flex items-center justify-center mb-5"
            style={{ background: "oklch(0.72 0.25 285 / 0.14)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}>
            <Wallet size={20} style={{ color: "oklch(0.76 0.20 285)" }} />
          </div>
          <DialogHeader className="space-y-3 text-left">
            <DialogTitle className="text-xl font-bold tracking-tight" style={{ color: "oklch(0.96 0 0)" }}>
              Heclus has moved from BYO
            </DialogTitle>
            <DialogDescription className="text-[13.5px] leading-[1.7]" style={{ color: "oklch(0.72 0 0)" }}>
              New accounts run on Heclus Credits, with no API keys to bring. Yours still runs on your own
              keys, and you can switch either way in Billing. Your free resources stay the same on either.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2.5 mt-7">
            <button
              type="button"
              onClick={() => { close(); router.push("/billing#funding"); }}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-opacity hover:opacity-90 cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.99 0 0)" }}
            >
              See the options
            </button>
            <button
              type="button"
              onClick={close}
              className="px-4 py-2.5 rounded-xl text-sm font-medium transition-opacity hover:opacity-80 cursor-pointer"
              style={{ background: "transparent", border: "1px solid oklch(1 0 0 / 0.14)", color: "oklch(0.74 0 0)" }}
            >
              Keep my keys
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
