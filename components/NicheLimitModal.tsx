"use client";

import { useEffect, useMemo, useState } from "react";
import { X, AlertCircle, RotateCcw, ArrowUp } from "lucide-react";

interface PlanDTO {
  slug: string;
  name: string;
  priceDisplay: string;
  periodDisplay: string;
  limitDisplay: string;
  features: string[];
  nichesPerMonth: number | null;
  paymentLink: string | null;
  highlighted: boolean;
  disabled: boolean;
  isFounder: boolean;
  sortOrder: number;
}

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
  const [loadingPlanId, setLoadingPlanId] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanDTO[] | null>(null);
  // Single source of truth: the active flag. When inactive, spots_left
  // comes back as 0 and the UI hides Founder. null = still loading or
  // fetch failed → treat as available so a transient error doesn't strip
  // Founder from the UI.
  const [founderActive, setFounderActive] = useState<boolean | null>(null);
  const [founderSpotsLeft, setFounderSpotsLeft] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/plans", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setPlans((d?.plans as PlanDTO[] | undefined) ?? []))
      .catch(() => setPlans([]));
  }, []);

  useEffect(() => {
    // cache: "no-store" so admin edits to the founder cap reflect
    // immediately on the next open instead of behind the browser cache.
    fetch("/api/founder-spots", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (typeof d.active === "boolean") setFounderActive(d.active);
        if (typeof d.spots_left === "number") setFounderSpotsLeft(d.spots_left);
      })
      .catch(() => {});
  }, []);

  function handlePurchase(planSlug: string) {
    const plan = plans?.find((p) => p.slug === planSlug);
    const base = plan?.paymentLink;
    if (!base) {
      setError("Payment not configured for this plan. Contact support.");
      return;
    }
    setLoadingPlanId(planSlug);
    // Belt-and-suspenders storage so the checkout tab (opened in a new
    // window below) can still recover the pending plan on return. See
    // SubscriptionModal.handleSubscribe for the rationale.
    try { sessionStorage.setItem("dodo_pending_plan", planSlug); } catch {}
    try { localStorage.setItem("dodo_pending_plan", planSlug); } catch {}
    const callbackUrl = new URL("/payment/callback", window.location.origin);
    callbackUrl.searchParams.set("plan", planSlug);
    const url = new URL(base);
    url.searchParams.set("redirect_url", callbackUrl.toString());
    if (email) url.searchParams.set("customer[email]", email);
    // Synthetic anchor click — see SubscriptionModal for why this beats
    // window.open (which returns null even on success under noopener).
    const a = document.createElement("a");
    a.href = url.toString();
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setLoadingPlanId(null);
  }

  // Founder visibility is gated by the single 'active' flag.
  // null = loading / fetch error → show optimistically.
  const founderAvailable = founderActive === null || founderActive === true;

  // Rank by sort_order so admin re-ordering controls which plans count
  // as "above" the user's current tier (i.e. the upgrade set).
  const visiblePlans = useMemo<PlanDTO[]>(() => {
    if (!plans) return [];
    const currentRank = plans.find((p) => p.slug === currentPlan)?.sortOrder ?? -1;
    return plans
      .filter((p) => !p.disabled)
      .filter((p) => p.slug === currentPlan || p.sortOrder > currentRank)
      .filter((p) => !p.isFounder || founderAvailable);
  }, [plans, currentPlan, founderAvailable]);

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
          aria-label="Close"
          title="Close"
          className="absolute top-4 right-4 z-10 h-8 px-3 rounded-full flex items-center gap-1.5 text-xs font-medium transition-all cursor-pointer hover:scale-105 active:scale-95"
          style={{
            background: "oklch(1 0 0 / 0.06)",
            border: "1px solid oklch(1 0 0 / 0.08)",
            color: "var(--c-60)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "oklch(0.6 0.22 25 / 0.15)";
            e.currentTarget.style.borderColor = "oklch(0.6 0.22 25 / 0.35)";
            e.currentTarget.style.color = "oklch(0.7 0.22 25)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "oklch(1 0 0 / 0.06)";
            e.currentTarget.style.borderColor = "oklch(1 0 0 / 0.08)";
            e.currentTarget.style.color = "var(--c-60)";
          }}
        >
          <X size={14} />
          Close
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
          {plans === null ? (
            <div className="flex items-center justify-center py-10 text-xs" style={{ color: "var(--c-50)" }}>
              <span className="w-3 h-3 mr-2 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Loading plans…
            </div>
          ) : visiblePlans.length === 0 ? (
            <p className="text-center text-xs py-10" style={{ color: "var(--c-50)" }}>
              No upgrade options available right now.
            </p>
          ) : (
            <div className={`grid ${gridClass} gap-3 mb-5`}>
              {visiblePlans.map((plan) => {
                const isCurrent = plan.slug === currentPlan;
                const isFounder = plan.isFounder;

                return (
                  <div
                    key={plan.slug}
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
                        background: "oklch(0.55 0.15 145)",
                        color: "white",
                      } : isFounder ? {
                        background: "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                        color: "white",
                      } : {
                        background: "oklch(0.72 0.25 285)",
                        color: "white",
                      }}
                    >
                      {isCurrent ? "Current"
                        : isFounder ? `🔥 ${founderSpotsLeft !== null ? `${founderSpotsLeft} spots left` : "Limited"}`
                        : "Upgrade"}
                    </span>

                    <div className="mb-2 mt-1">
                      <p className="text-sm font-semibold" style={{ color: "var(--c-90)" }}>{plan.name}</p>
                      <p className="text-base font-bold mt-1" style={{ color: "var(--c-90)" }}>
                        {plan.priceDisplay}
                        <span className="text-xs font-normal" style={{ color: "var(--c-40)" }}>{plan.periodDisplay}</span>
                      </p>
                      <p className="text-[10px] mt-0.5" style={{ color: "var(--c-40)" }}>{plan.limitDisplay}</p>
                    </div>

                    {plan.features.length > 0 && (
                      <p className="text-xs flex-1 mb-3" style={{ color: "var(--c-45)" }}>{plan.features[0]}</p>
                    )}

                    <button
                      onClick={() => handlePurchase(plan.slug)}
                      disabled={loadingPlanId !== null}
                      className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-70 disabled:cursor-not-allowed"
                      style={isCurrent ? {
                        background: "linear-gradient(135deg, oklch(0.55 0.15 145), oklch(0.45 0.15 145))",
                        color: "white",
                      } : {
                        background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                        color: "var(--c-98)",
                      }}
                    >
                      {loadingPlanId === plan.slug ? (
                        <>
                          <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Loading…
                        </>
                      ) : (
                        <>
                          {isCurrent ? <RotateCcw size={12} /> : <ArrowUp size={12} />}
                          {isCurrent ? "Repurchase" : "Upgrade"}
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

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
