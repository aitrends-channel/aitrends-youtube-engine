"use client";

import { useEffect, useState } from "react";
import { X, AlertCircle, RotateCcw, ArrowUp } from "lucide-react";

const PLANS_DATA: Record<string, {
  name: string;
  price: string;
  period: string;
  limit: string;
  description: string;
}> = {
  starter: { name: "Starter", price: "$19", period: "/mo",   limit: "5 niches/month",  description: "Standard processing · Full pipeline" },
  founder: { name: "Founder", price: "$40", period: "/year", limit: "20 niches/year",  description: "HD processing · No renewal" },
  pro:     { name: "Pro",     price: "$49", period: "/mo",   limit: "Unlimited niches", description: "Bulk generation · Priority queue" },
};

const PLAN_RANK: Record<string, number> = { starter: 0, founder: 1, pro: 2 };

const DODO_PAYMENT_LINKS: Record<string, string> = {
  founder: process.env.NEXT_PUBLIC_DODO_LINK_FOUNDER ?? "",
  starter: process.env.NEXT_PUBLIC_DODO_LINK_STARTER ?? "",
  pro:     process.env.NEXT_PUBLIC_DODO_LINK_PRO ?? "",
};

interface Props {
  email: string;
  currentPlan: string;
  nichesUsed: number;
  nicheLimit: number;
  onClose: () => void;
  onSuccess?: () => void;
}

export function NicheLimitModal({ email, currentPlan, nichesUsed, nicheLimit, onClose }: Props) {
  const [error, setError] = useState<string | null>(null);
  // null = still loading or fetch failed; treat as available so we don't
  // hide Founder on a transient error. Only hide when confirmed sold out.
  const [founderSpotsLeft, setFounderSpotsLeft] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/founder-spots")
      .then((r) => r.json())
      .then((d) => setFounderSpotsLeft(typeof d.remaining === "number" ? d.remaining : null))
      .catch(() => {});
  }, []);

  function handlePurchase(planId: string) {
    const base = DODO_PAYMENT_LINKS[planId];
    if (!base) {
      setError("Payment not configured for this plan. Contact support.");
      return;
    }
    try { sessionStorage.setItem("dodo_pending_plan", planId); } catch {}
    const callbackUrl = `${window.location.origin}/payment/callback`;
    const url = new URL(base);
    url.searchParams.set("redirect_url", callbackUrl);
    if (email) url.searchParams.set("customer[email]", email);
    window.location.href = url.toString();
  }

  // Founder is hidden only when confirmed sold out (0 spots). null = loading
  // or fetch error → show optimistically so a transient blip doesn't strip it.
  const founderAvailable = founderSpotsLeft === null || founderSpotsLeft > 0;
  const currentRank = PLAN_RANK[currentPlan] ?? 0;

  const visiblePlans = (["starter", "founder", "pro"] as const)
    .filter((id) => id === currentPlan || PLAN_RANK[id] > currentRank)
    .filter((id) => id !== "founder" || founderAvailable);

  const cols = Math.min(visiblePlans.length, 3);
  const gridClass = cols === 1 ? "grid-cols-1" : cols === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center p-4"
      style={{ background: "oklch(0 0 0 / 0.72)", backdropFilter: "blur(6px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-3xl rounded-2xl overflow-hidden"
        style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)", maxHeight: "90vh" }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-1.5 rounded-lg transition-opacity hover:opacity-60 cursor-pointer"
          style={{ color: "var(--c-40)" }}
        >
          <X size={16} />
        </button>

        <div className="overflow-y-auto p-8" style={{ maxHeight: "90vh" }}>

          {/* Header */}
          <div className="text-center mb-5">
            <div
              className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3"
              style={{ background: "oklch(0.6 0.22 25 / 0.15)", color: "oklch(0.7 0.22 25)" }}
            >
              <AlertCircle size={24} />
            </div>
            <h2 className="text-xl font-bold mb-1" style={{ color: "var(--c-90)" }}>Niche Limit Reached</h2>
            <p className="text-sm" style={{ color: "var(--c-50)" }}>
              Repurchase your current plan to get a fresh set, or upgrade to a higher tier.
            </p>
          </div>

          {/* Usage banner */}
          <div
            className="w-full px-4 py-3 rounded-xl mb-6"
            style={{ background: "oklch(0.6 0.22 25 / 0.06)", border: "1px solid oklch(0.6 0.22 25 / 0.18)" }}
          >
            <p className="text-sm font-semibold" style={{ color: "var(--c-80)" }}>
              {nichesUsed} / {nicheLimit} niches used
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Deleted niches still count toward your plan total.
            </p>
          </div>

          {/* Plans side by side */}
          <div className={`grid ${gridClass} gap-3 mb-5`}>
            {visiblePlans.map((planId) => {
              const plan = PLANS_DATA[planId];
              const isCurrent = planId === currentPlan;
              const isFounder = planId === "founder";

              return (
                <div
                  key={planId}
                  className="relative rounded-xl p-4 flex flex-col"
                  style={isCurrent ? {
                    background: "oklch(1 0 0 / 0.03)",
                    border: "1px solid oklch(1 0 0 / 0.1)",
                  } : {
                    background: "oklch(0.72 0.25 285 / 0.05)",
                    border: "1px solid oklch(0.72 0.25 285 / 0.25)",
                  }}
                >
                  {/* Top-center badge */}
                  <span
                    className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
                    style={isCurrent ? {
                      background: "oklch(0.35 0 0)",
                      color: "var(--c-80)",
                      border: "1px solid var(--bd-8)",
                    } : isFounder ? {
                      background: "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                      color: "white",
                    } : {
                      background: "oklch(0.72 0.25 285)",
                      color: "white",
                    }}
                  >
                    {isCurrent ? "Current"
                      : isFounder ? `🔥 ${founderSpotsLeft !== null ? `${founderSpotsLeft} spots left` : "First 100"}`
                      : "Upgrade"}
                  </span>

                  <div className="mb-2 mt-1">
                    <p className="text-sm font-semibold" style={{ color: "var(--c-90)" }}>{plan.name}</p>
                    <p className="text-base font-bold mt-1" style={{ color: "var(--c-90)" }}>
                      {plan.price}
                      <span className="text-xs font-normal" style={{ color: "var(--c-40)" }}>{plan.period}</span>
                    </p>
                    <p className="text-[10px] mt-0.5" style={{ color: "var(--c-40)" }}>{plan.limit}</p>
                  </div>

                  <p className="text-xs flex-1 mb-3" style={{ color: "var(--c-45)" }}>{plan.description}</p>

                  <button
                    onClick={() => handlePurchase(planId)}
                    className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
                    style={isCurrent ? {
                      background: "var(--bg-progress)",
                      color: "var(--c-70)",
                      border: "1px solid var(--bd-8)",
                    } : {
                      background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                      color: "var(--c-98)",
                    }}
                  >
                    {isCurrent ? <RotateCcw size={12} /> : <ArrowUp size={12} />}
                    {isCurrent ? "Repurchase" : "Upgrade"}
                  </button>
                </div>
              );
            })}
          </div>

          {error && (
            <p
              className="text-xs px-3 py-2 rounded-lg mb-4"
              style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}
            >
              {error}
            </p>
          )}

          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-lg text-sm font-medium transition-all hover:opacity-80"
            style={{ background: "transparent", color: "var(--c-50)" }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
