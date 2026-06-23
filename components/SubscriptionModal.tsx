"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { X, Check, PlayCircle } from "lucide-react";

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
  // Synthetic flag set only on the "Production test" plan (not in
  // the DB). Drives the small "Test" pill so the card is visually
  // distinguishable from the real paid tiers.
  isTestPlan?: boolean;
}

const PRODUCTION_TEST_SLUG = "production-test";

function buildProductionTestPlan(paymentLink: string): PlanDTO {
  return {
    slug: PRODUCTION_TEST_SLUG,
    name: "Production test",
    priceDisplay: "Test",
    periodDisplay: "",
    limitDisplay: "Verification only",
    features: [
      "Live Dodo production checkout",
      "For verifying the production payment flow end-to-end",
    ],
    nichesPerMonth: null,
    paymentLink,
    highlighted: false,
    disabled: false,
    isFounder: false,
    sortOrder: 999,
    isTestPlan: true,
  };
}

interface Props {
  email: string;
  onClose: () => void;
  onSuccess: () => void;
  defaultPlan?: string;
  hideTryDemo?: boolean;
}


export function SubscriptionModal({ email, onClose, defaultPlan, hideTryDemo }: Props) {
  const router = useRouter();
  const [plans, setPlans] = useState<PlanDTO[] | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<string>(defaultPlan ?? "");
  const [spotsLeft, setSpotsLeft] = useState<number | null>(null);
  const [founderActive, setFounderActive] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);

  useEffect(() => {
    fetch("/api/plans", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        const list = (d?.plans as PlanDTO[] | undefined) ?? [];
        // Append the admin-only "Production test" card when /api/plans
        // returned a productionTestLink (server gates this on
        // isAdminUser, so the link is null for non-admins).
        const adminLink = typeof d?.productionTestLink === "string" ? d.productionTestLink : null;
        const full = adminLink ? [...list, buildProductionTestPlan(adminLink)] : list;
        setPlans(full);
        if (!defaultPlan && full.length > 0) {
          const founder = full.find(p => p.isFounder && !p.disabled);
          setSelectedPlan((founder ?? full.find(p => !p.disabled && !p.isTestPlan) ?? full[0]).slug);
        }
      })
      .catch(() => setPlans([]));
  }, [defaultPlan]);

  useEffect(() => {
    // cache: "no-store" so admin edits to the founder cap or slot
    // count reflect immediately on the next modal open instead of
    // sitting behind whatever the browser cached from a prior fetch.
    fetch("/api/founder-spots", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (typeof d.active === "boolean") setFounderActive(d.active);
        if (typeof d.spots_left === "number") setSpotsLeft(d.spots_left);
      })
      .catch(() => {});
  }, []);

  // Founder visibility gated by the single 'active' flag from the server.
  const founderAvailable = founderActive === null || founderActive === true;

  const visiblePlans = useMemo(() => {
    if (!plans) return [];
    return plans.filter((p) => !p.isFounder || founderAvailable);
  }, [plans, founderAvailable]);

  // If the currently-selected slug is a founder plan and founder is no
  // longer available, fall back to the first non-founder, non-disabled
  // plan. Mirrors the previous "fall back to pro" behavior generically.
  useEffect(() => {
    if (!plans || !selectedPlan) return;
    const current = plans.find(p => p.slug === selectedPlan);
    if (!current) {
      const fallback = visiblePlans.find(p => !p.disabled);
      if (fallback) setSelectedPlan(fallback.slug);
      return;
    }
    if (current.isFounder && !founderAvailable) {
      const fallback = visiblePlans.find(p => !p.disabled && !p.isFounder);
      if (fallback) setSelectedPlan(fallback.slug);
    }
  }, [plans, selectedPlan, founderAvailable, visiblePlans]);

  function handleSubscribe() {
    const plan = plans?.find(p => p.slug === selectedPlan);
    const base = plan?.paymentLink;
    if (!base) {
      setError("Payment not configured for this plan. Contact support.");
      return;
    }
    setSubscribing(true);
    try { sessionStorage.setItem("dodo_pending_plan", selectedPlan); } catch {}
    const callbackUrl = `${window.location.origin}/payment/callback`;
    const url = new URL(base);
    url.searchParams.set("redirect_url", callbackUrl);
    if (email) url.searchParams.set("customer[email]", email);
    window.location.href = url.toString();
  }

  const selected = plans?.find(p => p.slug === selectedPlan) ?? null;
  // 4 plans wrap to 2x2 on mobile, single row on sm+ so the admin
  // production-test card stays alongside the customer plans rather
  // than overflowing the modal width.
  const gridCols = visiblePlans.length >= 4
    ? "grid-cols-2 sm:grid-cols-4"
    : visiblePlans.length === 3
      ? "grid-cols-3"
      : visiblePlans.length === 2
        ? "grid-cols-2"
        : "grid-cols-1";

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center p-4"
      style={{ background: "oklch(0 0 0 / 0.72)", backdropFilter: "blur(6px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-2xl rounded-2xl overflow-hidden"
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


        <div className="text-center mb-6">
          <h2 className="text-xl font-bold mb-1" style={{ color: "var(--c-90)" }}>Unlock Heclus</h2>
          <p className="text-sm" style={{ color: "var(--c-45)" }}>Pick the plan that fits your workflow.</p>
        </div>

        {/* Try Demo */}
        {!hideTryDemo && <button
          onClick={() => { onClose(); router.push("/demo/channel"); }}
          className="w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all hover:opacity-90 cursor-pointer"
          style={{ background: "oklch(1 0 0 / 0.04)", border: "1px solid oklch(1 0 0 / 0.08)", marginBottom: "30px" }}
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" }}>
              <PlayCircle size={16} />
            </div>
            <div className="text-left">
              <p className="text-sm font-semibold" style={{ color: "var(--c-80)" }}>Try end-to-end workflow</p>
              <p className="text-xs" style={{ color: "var(--c-40)" }}>Explore Heclus with a guided walkthrough — free</p>
            </div>
          </div>
          <span className="text-xs font-medium shrink-0" style={{ color: "oklch(0.72 0.25 285)" }}>
            Free →
          </span>
        </button>}

        {plans === null ? (
          <div className="flex items-center justify-center py-10 text-sm" style={{ color: "var(--c-50)" }}>
            <span className="w-4 h-4 mr-2 border-2 border-current border-t-transparent rounded-full animate-spin" />
            Loading plans…
          </div>
        ) : visiblePlans.length === 0 ? (
          <p className="text-center text-sm py-10" style={{ color: "var(--c-50)" }}>
            No plans are available right now.
          </p>
        ) : (
          <>
            {/* Plan selector */}
            <div className={`grid ${gridCols} gap-3 mb-6`}>
              {visiblePlans.map((plan) => (
                <button
                  key={plan.slug}
                  onClick={() => !plan.disabled && setSelectedPlan(plan.slug)}
                  className="relative rounded-xl p-3 text-left transition-all"
                  style={{
                    background: plan.disabled ? "oklch(1 0 0 / 0.01)" : selectedPlan === plan.slug ? "oklch(0.72 0.25 285 / 0.12)" : "oklch(1 0 0 / 0.03)",
                    border: plan.disabled ? "1px solid oklch(1 0 0 / 0.05)" : selectedPlan === plan.slug
                      ? "1px solid oklch(0.72 0.25 285 / 0.50)"
                      : "1px solid oklch(1 0 0 / 0.08)",
                    opacity: plan.disabled ? 0.4 : 1,
                    cursor: plan.disabled ? "not-allowed" : "pointer",
                  }}
                >
                  {plan.isFounder && spotsLeft !== null && (
                    <span
                      className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
                      style={{ background: "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))", color: "white" }}
                    >
                      🔥 {spotsLeft} spots left
                    </span>
                  )}
                  {plan.highlighted && (
                    <span
                      className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
                      style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
                    >
                      💪 Popular
                    </span>
                  )}
                  {plan.disabled && (
                    <span
                      className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
                      style={{ background: "oklch(0.35 0 0)", color: "oklch(0.60 0 0)" }}
                    >
                      Soon
                    </span>
                  )}
                  {plan.isTestPlan && (
                    <span
                      className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
                      style={{ background: "oklch(0.55 0.15 145)", color: "white" }}
                    >
                      Test
                    </span>
                  )}
                  <p className="text-xs font-semibold mb-1" style={{ color: selectedPlan === plan.slug ? "oklch(0.82 0.18 285)" : "var(--c-60)" }}>
                    {plan.name}
                  </p>
                  <p className="text-base font-bold" style={{ color: "var(--c-90)" }}>
                    {plan.priceDisplay}<span className="text-xs font-normal" style={{ color: "var(--c-40)" }}>{plan.periodDisplay}</span>
                  </p>
                  <p className="text-[10px] mt-0.5" style={{ color: "var(--c-35)" }}>{plan.limitDisplay}</p>
                </button>
              ))}
            </div>

            {/* Selected plan features */}
            {selected && (
              <ul className="space-y-2 mb-6">
                {selected.features.map((f) => (
                  <li key={f} className="flex items-center gap-2.5 text-sm" style={{ color: "var(--c-65)" }}>
                    <span
                      className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                      style={{ background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)" }}
                    >
                      <Check size={9} strokeWidth={3} />
                    </span>
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {error && (
          <p
            className="text-xs px-3 py-2 rounded-lg mb-4"
            style={{
              background: "oklch(0.6 0.22 25 / 0.1)",
              color: "oklch(0.7 0.2 25)",
              border: "1px solid oklch(0.6 0.22 25 / 0.2)",
            }}
          >
            {error}
          </p>
        )}

        <button
          onClick={handleSubscribe}
          disabled={subscribing || !selected || selected.disabled}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all hover:opacity-90 disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer"
          style={{
            background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
            color: "var(--c-98)",
          }}
        >
          {subscribing ? (
            <>
              <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Loading…
            </>
          ) : (
            `Subscribe${selected ? ` to ${selected.name}` : ""}`
          )}
        </button>

        </div>
      </div>
    </div>
  );
}
