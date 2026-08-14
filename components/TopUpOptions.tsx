"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { CREDIT_PACK_OPTIONS } from "@/lib/credits";
import { startTopUp } from "@/lib/credits-checkout";

// The top-up options, shown in place of the balance row rather than in a modal.
//
// One component for both surfaces that carry a balance (the account page and the
// Generate step) so the prices cannot drift apart between them. The options
// themselves come from CREDIT_PACK_OPTIONS, which derives them from the pack
// price, so no number here is typed by hand.
//
// Each option is a quantity of the same Dodo product, which is why one
// configured checkout link serves all four.

export function TopUpOptions({
  checkoutUrl,
  onCancel,
  compact = false,
}: {
  checkoutUrl: string;
  onCancel: () => void;
  compact?: boolean;
}) {
  // Which option is leaving for Dodo. Navigation replaces the page, so this
  // state is never cleared — it exists to mark the pressed option and to stop a
  // second click starting a second checkout in the gap before the page changes.
  const [leaving, setLeaving] = useState<number | null>(null);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className={`font-semibold ${compact ? "text-[11px]" : "text-xs"}`} style={{ color: "var(--c-70)" }}>
          Choose a top-up
        </p>
        <button
          type="button"
          onClick={onCancel}
          disabled={leaving !== null}
          className="inline-flex items-center gap-1 text-[11px] font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
          style={{ color: "var(--c-50)" }}
        >
          <ArrowLeft size={11} />
          Back
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {CREDIT_PACK_OPTIONS.map((opt) => {
          const busy = leaving === opt.units;
          return (
            <button
              key={opt.units}
              type="button"
              disabled={leaving !== null}
              onClick={() => {
                setLeaving(opt.units);
                startTopUp(checkoutUrl, opt.units);
              }}
              className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl text-left transition-all hover:opacity-90 disabled:opacity-50"
              style={{
                background: busy ? "oklch(0.72 0.25 285)" : "oklch(1 0 0 / 0.06)",
                border: `1px solid ${busy ? "oklch(0.72 0.25 285)" : "oklch(1 0 0 / 0.1)"}`,
              }}
            >
              <span className="min-w-0">
                <span className="block text-xs font-semibold tabular-nums"
                  style={{ color: busy ? "white" : "var(--c-85)" }}>
                  {opt.credits.toLocaleString()} credits
                </span>
                <span className="block text-[10px]" style={{ color: busy ? "oklch(1 0 0 / 0.8)" : "var(--c-45)" }}>
                  {busy ? "Opening checkout" : `${opt.credits.toLocaleString()} clips`}
                </span>
              </span>
              <span className="shrink-0 text-sm font-bold tabular-nums"
                style={{ color: busy ? "white" : "var(--brand-text)" }}>
                {busy ? <Spinner size={13} /> : `$${opt.priceUsd}`}
              </span>
            </button>
          );
        })}
      </div>

      <p className="text-[10px]" style={{ color: "var(--c-42)" }}>
        Purchased credits never expire.
      </p>
    </div>
  );
}
