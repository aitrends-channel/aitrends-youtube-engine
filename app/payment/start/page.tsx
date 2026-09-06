"use client";

import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";

// The hop between clicking Top up and arriving at Dodo.
//
// It exists so the window.open stays synchronous with the click. Creating the
// checkout session takes a round trip to our own server, and a tab opened after
// an await is a pop-up as far as the browser is concerned. Opening this page
// first and redirecting from inside it keeps the gesture and the open together.
//
// Params are read from location rather than useSearchParams, which would drag a
// Suspense boundary into a page whose whole job is to leave.

export default function PaymentStartPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wallet = params.get("wallet");
    const plan = params.get("plan");
    const qty = Number(params.get("qty") ?? 1) || 1;
    // The plain /buy/ link, already carrying its return URL and quantity. Used
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dodo/checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet, plan, quantity: qty }),
        });
        const body = (await res.json().catch(() => ({}))) as { url?: string | null; error?: string };
        if (cancelled) return;
        const target = body.url;
        if (target) {
          // replace, not assign: the back button should return to the app, not
          // to this page, which would immediately push them out again.
          window.location.replace(target);
          return;
        }
        setError(body.error ?? "Could not start the checkout.");
      } catch {
        if (cancelled) return;
        setError("Could not reach the checkout. Check your connection and try again.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: "var(--bg-page)" }}>
      {error ? (
        <div className="text-center space-y-3 max-w-sm">
          <p className="text-sm" style={{ color: "oklch(0.7 0.18 25)" }}>{error}</p>
          <a href="/billing" className="inline-block text-sm font-semibold" style={{ color: "var(--brand-text)" }}>
            Back to billing
          </a>
        </div>
      ) : (
        <div className="flex items-center gap-3" style={{ color: "var(--c-55)" }}>
          <Spinner size={18} />
          <span className="text-sm">Opening secure checkout…</span>
        </div>
      )}
    </div>
  );
}
