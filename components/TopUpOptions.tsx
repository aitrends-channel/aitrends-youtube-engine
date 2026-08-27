"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { CREDIT_PACK_OPTIONS } from "@/lib/credits";
import { startTopUp, type TopUpWallet } from "@/lib/credits-checkout";

// The top-up options, shown in place of the balance row rather than in a modal.
//
// One component for both surfaces that carry a balance (the account page and the
// Generate step) so the prices cannot drift apart between them. The options
// themselves come from CREDIT_PACK_OPTIONS, which derives them from the pack
// price, so no number here is typed by hand.
//
// Each option is a quantity of the same Dodo product, which is why one
// configured checkout link serves all four.

export interface TopUpOption {
  units: number;
  credits: number;
  priceUsd: number;
}

export function TopUpOptions({
  checkoutUrl,
  onCancel,
  compact = false,
  options = CREDIT_PACK_OPTIONS,
  wallet = "genai",
  newTab = false,
  unitNoun = "clips",
}: {
  checkoutUrl: string;
  onCancel: () => void;
  compact?: boolean;
  /** Defaults to the video pack's quantities. The Heclus wallet passes its own,
   *  derived from the configured pack, so neither wallet can show the other's
   *  prices. */
  options?: readonly TopUpOption[];
  wallet?: TopUpWallet;
  newTab?: boolean;
  /** What one credit buys, for the line under each amount. Empty hides that
   *  line, for a wallet where the credits ARE the unit and repeating the number
   *  under itself says nothing. */
  unitNoun?: string;
}) {
  // Which option is leaving for Dodo. Same-tab navigation replaces the page, so
  // the state is never cleared there — it exists to mark the pressed option and
  // to stop a second click starting a second checkout in the gap before the page
  // changes. A new-tab checkout clears it on a timer instead, since this page
  // stays where it is.
  const [leaving, setLeaving] = useState<number | null>(null);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className={`font-semibold ${compact ? "text-[11px]" : "text-xs"}`} style={{ color: "var(--c-70)" }}>
          Choose a top-up plan
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

      <div className="grid grid-cols-2">
        {options.map((opt) => {
          const busy = leaving === opt.units;
          return (
            <button
              key={opt.units}
              type="button"
              disabled={leaving !== null}
              onClick={() => {
                setLeaving(opt.units);
                startTopUp(checkoutUrl, opt.units, wallet, newTab);
                // A new tab leaves this page mounted, so the pressed state has
                // to be cleared or the option spins for ever. Same-tab
                // navigation replaces the page and never reaches this.
                if (newTab) setTimeout(() => setLeaving(null), 1200);
              }}
              className="flex items-center justify-between gap-2 px-4 py-4 rounded-xl text-left transition-all disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
              style={{
                margin: "10px",
                background: busy ? "oklch(0.72 0.25 285)" : "oklch(1 0 0 / 0.06)",
                border: `1px solid ${busy ? "oklch(0.72 0.25 285)" : "oklch(1 0 0 / 0.1)"}`,
              }}
              onMouseEnter={(e) => {
                if (leaving !== null) return;
                const el = e.currentTarget;
                el.style.background = "oklch(0.72 0.25 285 / 0.14)";
                el.style.borderColor = "oklch(0.72 0.25 285 / 0.55)";
                el.style.transform = "translateY(-1px)";
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget;
                el.style.background = busy ? "oklch(0.72 0.25 285)" : "oklch(1 0 0 / 0.06)";
                el.style.borderColor = busy ? "oklch(0.72 0.25 285)" : "oklch(1 0 0 / 0.1)";
                el.style.transform = "";
              }}
            >
              <span className="min-w-0">
                <span className="block text-xs font-semibold tabular-nums"
                  style={{ color: busy ? "white" : "var(--c-85)" }}>
                  {opt.credits.toLocaleString()} credits
                </span>
                {(busy || unitNoun) && (
                  <span className="block text-[10px]" style={{ color: busy ? "oklch(1 0 0 / 0.8)" : "var(--c-45)" }}>
                    {busy ? "Opening checkout" : `${opt.credits.toLocaleString()} ${unitNoun}`}
                  </span>
                )}
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
