"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Wallet } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
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
  const forced = params.get("announce") === "1";

  useEffect(() => {
    let live = true;
    if (!forced) {
      try {
        if (window.localStorage.getItem(SEEN_KEY)) return;
      } catch { /* private mode: show it, once per session at worst */ }
    }
    void fetch("/api/me/api-keys-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: ApiKeysStatus | null) => {
        if (!live || !s) return;
        // The people this is about: still on their own keys, not on a credits
        // plan. Anyone already moved has nothing to be told.
        if (forced || (s.fundingMode === "byo" && !s.onHeclusCreditsPlan)) setOpen(true);
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-2"
            style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
            <Wallet size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
          </div>
          <DialogTitle>New accounts run on Heclus Credits</DialogTitle>
          <DialogDescription>
            No API keys to bring. Yours still runs on your own keys, and you can switch either way in Billing.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={close}
            className="px-4 py-2 rounded-xl text-sm font-medium transition-opacity hover:opacity-80 cursor-pointer"
            style={{ background: "transparent", border: "1px solid var(--bd-8)", color: "var(--c-60)" }}
          >
            Keep my keys
          </button>
          <button
            type="button"
            onClick={() => { close(); router.push("/billing"); }}
            className="px-4 py-2 rounded-xl text-sm font-semibold transition-opacity hover:opacity-90 cursor-pointer"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
          >
            See the options
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
