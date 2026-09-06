"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Sparkles, Plus } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { TopUpOptions } from "@/components/TopUpOptions";

// The free image allowance, shown where images are generated.
//
// The sibling of VideoCreditsPanel, and deliberately simpler: there is no
// wallet behind this and nothing to buy. An account either has allowance left
// or it does not, and when it does not the model reverts to its ordinary paid
// self in the All tab, so there is no dead end to explain.
//
// Renders nothing when the plan has no allowance. That is the Founder
// exclusion, and it is a server answer rather than a plan string read here.

interface FreeUsageResponse {
  freeImagesUsed?: number;
  freeImagesCap?: number;
  freeImagesMonthly?: number;
  freeImagesBonus?: number;
  freeImagePack?: { images: number; priceUsd: number } | null;
  freeImageCheckoutUrl?: string | null;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function FreeImagesPanel() {
  const { data, mutate, isLoading } = useSWR<FreeUsageResponse>("/api/free-usage", fetcher);
  const [claiming, setClaiming] = useState(false);
  const [picking, setPicking] = useState(false);
  // One attempt per payment id per mount: effects run twice in development and
  // the server is idempotent anyway, but there is no reason to ask twice.
  const claimed = useRef<string | null>(null);

  // Completes the purchase. Dodo returns the customer here with ?payment_id=,
  // and the server confirms it before granting: crediting on the verified
  // return rather than a webhook, because production's Dodo webhook has never
  // worked.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paymentId = params.get("payment_id");
    if (!paymentId || claimed.current === paymentId) return;
    if (params.get("type") !== "free_images") return;
    claimed.current = paymentId;
    setClaiming(true);
    fetch("/api/free-images/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment_id: paymentId }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d?.error) toast.error(d.error);
        else if (d?.images) toast.success(`${d.images.toLocaleString()} images added`);
        return mutate();
      })
      .catch(() => { /* the balance still reads correctly on the next load */ })
      .finally(() => setClaiming(false));
  }, [mutate]);

  const cap = data?.freeImagesCap ?? 0;
  if (isLoading || !data || cap <= 0) return null;

  const used = Math.min(data.freeImagesUsed ?? 0, cap);
  const left = Math.max(0, cap - used);
  const pct = Math.min(100, Math.round((used / cap) * 100));
  const empty = left === 0;
  const bonus = data.freeImagesBonus ?? 0;
  const checkoutUrl = data.freeImageCheckoutUrl ?? null;
  // Quantities of the one configured product, derived from the pack rather than
  // typed out, so a repriced pack cannot leave a stale number on screen.
  const options = data.freeImagePack
    ? [1, 2, 3, 4].map((units) => ({
        units,
        credits: data.freeImagePack!.images * units,
        priceUsd: data.freeImagePack!.priceUsd * units,
      }))
    : null;
  // Both halves, or the picker opens on an empty list: a link with no pack size
  // could take the money and grant nothing, which is what keeps this disabled
  // rather than merely linkless.
  const buyable = !!checkoutUrl && !!options;

  return (
    <div className="rounded-xl px-4 py-3 space-y-2"
      style={{
        background: empty ? "oklch(0.6 0.22 25 / 0.08)" : "var(--bg-progress)",
        border: `1px solid ${empty ? "oklch(0.6 0.22 25 / 0.25)" : "var(--bd-8)"}`,
      }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-xs font-semibold inline-flex items-center gap-1.5" style={{ color: "var(--c-85)" }}>
            <Sparkles size={13} style={{ color: "var(--brand-text)" }} />
            Free images
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--c-50)" }}>
            {empty
              // Not a dead end: the model is still there, it just bills now.
              ? "All used for this month. Top up, or pick any model in All."
              : `${left.toLocaleString()} image${left === 1 ? "" : "s"} left · included with your plan`}
          </p>
        </div>

        {/* Always rendered, disabled until the pack is configured.
            Hiding it made the panel look finished when it is not: there is no
            way to buy more images yet, and a customer who has run out should
            see where that will be rather than nothing at all. It enables
            itself the moment the checkout link and pack size are set. */}
        {!picking && (
          <button
            type="button"
            onClick={() => setPicking(true)}
            disabled={!buyable}
            title={buyable ? undefined : "Top-ups are not available yet"}
            className="inline-flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all enabled:hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
          >
            {claiming ? <Spinner size={12} /> : <Plus size={12} />}
            {claiming ? "Confirming…" : "Top up"}
          </button>
        )}
      </div>

      {checkoutUrl && picking && options && (
        <TopUpOptions
          checkoutUrl={checkoutUrl}
          onCancel={() => setPicking(false)}
          options={options}
          wallet="free_images"
          newTab
          unitNoun="images"
          compact
        />
      )}

      {!picking && (
      <div className="space-y-1">
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "oklch(0 0 0 / 0.12)" }}>
          <div className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: pct >= 100 ? "oklch(0.6 0.22 25)" : "oklch(0.72 0.25 285)" }} />
        </div>
        <p className="text-[10px]" style={{ color: "var(--c-45)" }}>
          {used.toLocaleString()} used this month · {left.toLocaleString()} of {cap.toLocaleString()} images left
          {bonus > 0 && ` · ${bonus.toLocaleString()} bought, which do not expire`}
        </p>
      </div>
      )}
    </div>
  );
}
