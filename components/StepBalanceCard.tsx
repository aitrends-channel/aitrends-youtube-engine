"use client";

import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import { useViewerPlan } from "@/lib/admin-view";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { TopUpOptions } from "@/components/TopUpOptions";
import type { ApiStatusResult } from "@/app/api/api-status/route";
import { useKieActivityStore } from "@/store/kieActivityStore";
import { useBalanceStore } from "@/store/balanceStore";

const fetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<ApiStatusResult>);

/** Companion to StepCostCard. Shows remaining balances on the two
 *  providers with queryable quotas — KIE credits and ElevenLabs
 *  characters — as a single one-liner chip: `Available: kie-X, el-X`.
 *
 *  Anthropic and Supadata are intentionally omitted: their consumption
 *  is billed through KIE (or per-request without a user-visible
 *  remaining number), so there's no meaningful "available" figure to
 *  surface. Kie already reflects the pool they draw from.
 *
 *  Same refresh cadence as the profile-dropdown balance rows so mounting
 *  another consumer costs zero extra requests — SWR dedupes the fetch. */
export function StepBalanceCard() {
  // Same gating as KieBalanceRow — pause the poll when no step is
  // doing KIE work so idle-project viewing costs zero /chat/credit
  // and ElevenLabs /user hits.
  const hasActivity = useKieActivityStore((s) => s.hasActivity);
  const [picking, setPicking] = useState(false);
  const { data, mutate } = useSWR<ApiStatusResult>(
    "/api/api-status",
    fetcher,
    // revalidateOnFocus: coming back to the tab is the moment the number is
    // read, and a stale one there is worse than one extra request.
    { refreshInterval: hasActivity ? 10_000 : 0, revalidateOnFocus: true },
  );

  // The exact signal: a step finished something that may have been charged.
  // Read once for the charge itself, then again shortly after, because an
  // image is settled in the request that returns it but a clip is settled by
  // the worker a moment later.
  const balanceVersion = useBalanceStore((s) => s.version);
  useEffect(() => {
    if (balanceVersion === 0) return;
    void mutate();
    const t = setTimeout(() => { void mutate(); }, 3000);
    return () => clearTimeout(t);
  }, [balanceVersion, mutate]);

  // The blunt signal, kept as a backstop for anything that completes without
  // announcing itself.
  //
  // Polling stops when the last step releases its key, so whatever the balance
  // was at the previous tick is what stayed on screen — up to a poll interval
  // stale, and then frozen until the tab was switched or the page refreshed.
  // The transition is the signal: read it once as the work stops, then again a
  // few seconds later, because the charge is settled by a webhook or a worker
  // that may land just after the run reports itself finished.
  const wasActive = useRef(hasActivity);
  useEffect(() => {
    if (wasActive.current && !hasActivity) {
      void mutate();
      const t = setTimeout(() => { void mutate(); }, 4000);
      wasActive.current = hasActivity;
      return () => clearTimeout(t);
    }
    wasActive.current = hasActivity;
  }, [hasActivity, mutate]);

  // Sweep on the quiet, rather than asking the customer to.
  //
  // The reserve is no longer on the chip, so nobody can see a stuck hold to
  // press a button about. The same sweep runs here on mount, obeying the same
  // windows the cron does: a hold from a generation still in flight is not
  // touched. A refund it produces surfaces through the flash below like any
  // other, so the credits coming back are still visible even though what was
  // holding them never was.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/credits/sweep", { method: "POST" });
        const out = await res.json() as { released?: number };
        if (out.released) await mutate();
      } catch { /* the cron will get it */ }
    })();
  }, [mutate]);

  // A refund, held on screen for four seconds.
  //
  // Keyed on the ledger timestamp rather than a balance increase: a top-up
  // raises the balance too, and calling that a refund would be a lie about
  // money. The ref remembers which batch has already been shown so a poll
  // landing inside the same window does not restart the flash.
  const refunded = data?.refunded ?? null;
  const shownRefund = useRef<string | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  useEffect(() => {
    if (!refunded || shownRefund.current === refunded.at) return;
    shownRefund.current = refunded.at;
    setFlash(refunded.credits);
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [refunded]);

  // A wallet-funded account has no KIE or ElevenLabs key, so those two numbers
  // are zero for the wrong reason. What it can spend is credits, and the chip
  // becomes a link to top them up: this card is on every step, which is exactly
  // where somebody notices they are running low.
  /* A refund, for four seconds. The balance moving on its own is the one
     change a customer cannot account for, and this is what accounts for it now
     that the reserve is not on screen. */
  const refundFlash = flash === null ? null : (
    <span
      // Keyed on the amount so a second refund restarts the animation instead
      // of inheriting a node already faded to nothing.
      key={`refund-${flash}`}
      className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium tabular-nums shrink-0"
      style={{
        background: "oklch(0.6 0.2 25 / 0.12)",
        color: "oklch(0.68 0.21 25)",
        border: "1px solid oklch(0.6 0.2 25 / 0.35)",
        // Matches the four seconds the state is held for, so the node is
        // removed on the frame it finishes fading rather than blinking out.
        animation: "credit-refund-flash 4s ease-out forwards",
      }}
    >
      +{flash.toLocaleString(undefined, { maximumFractionDigits: 2 })} refunded
    </span>
  );

  // In Old mode the wallet chip gives way to the provider balances below,
  // which is the pair an account on an old plan actually spends against.
  const { onCredits } = useViewerPlan();
  const wallet = onCredits && data?.fundingMode === "wallet" ? data?.wallet : undefined;
  if (!data) {
    return (
      <span className="inline-block h-[26px] w-40 rounded-md animate-pulse align-middle"
        style={{ background: "oklch(1 0 0 / 0.06)", border: "1px solid oklch(1 0 0 / 0.08)" }} />
    );
  }

  const kie = data?.kie?.credits;
  const el  = data?.elevenlabs?.remaining;

  // Both providers are always rendered, even before data lands / when
  // the user hasn't configured a key — an em dash stands in for the
  // number. Users asked for a stable shape on every step so the badge
  // width doesn't jump around and they can always see at a glance
  // which provider a `—` refers to.
  const parts: Array<{ key: string; value: string }> = [
    { key: "kie", value: typeof kie === "number" ? kie.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—" },
    { key: "el",  value: typeof el  === "number" ? el.toLocaleString() : "—" },
  ];

  // Empty balance → orange tint so it reads as a warning, matching the
  // KieBalanceRow low-balance treatment. Otherwise use the muted blue
  // tint so it's visually distinct from the green Used chip alongside.
  const isEmpty = (typeof kie === "number" && kie <= 0) || (typeof el === "number" && el <= 0);
  const labelBg   = isEmpty ? "oklch(0.70 0.18 45)"        : "oklch(0.55 0.15 240)";
  const bodyBg    = isEmpty ? "oklch(0.70 0.18 45 / 0.12)" : "oklch(0.55 0.15 240 / 0.12)";
  const bodyColor = isEmpty ? "oklch(0.60 0.18 45)"        : "oklch(0.55 0.15 240)";
  const borderCol = isEmpty ? "oklch(0.70 0.18 45 / 0.3)"  : "oklch(0.55 0.15 240 / 0.3)";

  if (wallet) {
    const credits = wallet.credits;
    const low = credits <= 0;
    const checkoutUrl = data.walletCheckoutUrl ?? null;
    // The same quantities the /billing picker offers, derived from the same
    // configured pack, so the two surfaces cannot show different prices.
    const pack = data.walletPack ?? null;
    const options = pack
      ? [1, 2, 3, 4].map((units) => ({
          units,
          credits: pack.credits * units,
          priceUsd: pack.priceUsd * units,
        }))
      : null;
    const wLabelBg   = low ? "oklch(0.70 0.18 45)"        : "oklch(0.55 0.15 240)";
    const wBodyBg    = low ? "oklch(0.70 0.18 45 / 0.12)" : "oklch(0.55 0.15 240 / 0.12)";
    const wBodyColor = low ? "oklch(0.60 0.18 45)"        : "oklch(0.55 0.15 240)";
    const wBorder    = low ? "oklch(0.70 0.18 45 / 0.3)"  : "oklch(0.55 0.15 240 / 0.3)";
    return (
      <div className="inline-flex items-center gap-1.5 max-w-full">
      <a
        href="/billing"
        title={low ? "Out of Heclus Credits — top up to keep generating" : "Heclus Credits available. Click to top up."}
        className="inline-flex items-center rounded-md overflow-hidden text-xs font-medium break-words max-w-full transition-opacity hover:opacity-90"
        style={{ border: `1px solid ${wBorder}` }}
      >
        <span className="uppercase tracking-wider px-2 py-1"
          style={{ fontSize: "10px", background: wLabelBg, color: "oklch(1 0 0)" }}>
          Balance
        </span>
        <span className="tabular-nums px-2.5 py-1" style={{ background: wBodyBg, color: wBodyColor }}>
          {credits.toLocaleString(undefined, { maximumFractionDigits: 2 })} cr
        </span>
      </a>
      {refundFlash}
      {/* The chip itself has always linked to /billing and nothing said so.
          Findable by someone who has run out and hunting for the fix, invisible
          to everyone else. */}
      {/* Starts the purchase here rather than sending them to /billing to find
          the same button. New tab, so an abandoned checkout comes back to the
          step they were working on rather than to a Dodo receipt with no way
          back. Disabled, not hidden, when no pack is configured: its absence
          reads as a missing feature. */}
      <div className="relative inline-flex shrink-0">
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          disabled={!checkoutUrl || !options}
          title={checkoutUrl ? "Add Heclus Credits" : "No top-up pack is configured yet."}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold shrink-0 transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          style={{
            background: low ? "oklch(0.70 0.18 45 / 0.12)" : "oklch(0.72 0.25 285 / 0.12)",
            color: low ? "oklch(0.60 0.18 45)" : "oklch(0.72 0.25 285)",
            border: `1px solid ${low ? "oklch(0.70 0.18 45 / 0.3)" : "oklch(0.72 0.25 285 / 0.3)"}`,
          }}
        >
          <Plus size={11} />
          Top up
        </button>
        {/* The amounts, before the money. Buying one pack blind was the wrong
            default: the /billing card asks first, and a step chip that skipped
            the question would charge a different amount from the same label.
            TopUpOptions is the same component that card uses, so the prices
            cannot drift between the two. */}
        {picking && checkoutUrl && options && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPicking(false)} />
            <div className="absolute right-0 top-full mt-2 z-50 w-[26rem] max-w-[92vw] rounded-2xl p-7"
              style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.55)", boxShadow: "0 12px 32px oklch(0 0 0 / 0.4)" }}>
              <TopUpOptions
                checkoutUrl={checkoutUrl}
                onCancel={() => setPicking(false)}
                options={options}
                wallet="heclus"
                newTab
                unitNoun=""
              />
            </div>
          </>
        )}
      </div>
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
    {refundFlash}
    <span
      className="inline-flex items-center rounded-md overflow-hidden text-xs font-medium break-words max-w-full"
      style={{ border: `1px solid ${borderCol}` }}
    >
      <span
        className="uppercase tracking-wider px-2 py-1"
        style={{ fontSize: "10px", background: labelBg, color: "oklch(1 0 0)" }}
      >
        Available
      </span>
      <span
        className="tabular-nums px-2.5 py-1"
        style={{ background: bodyBg, color: bodyColor }}
      >
        {parts.map((p, i) => (
          <span key={p.key}>
            {i > 0 && ", "}
            {p.key}<span style={{ marginRight: "3px" }}>:</span>{p.value}
          </span>
        ))}
      </span>
    </span>
    </span>
  );
}
