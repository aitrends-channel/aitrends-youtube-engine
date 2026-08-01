"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
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
}

const PRODUCTION_TEST_SLUG = "production-test";

interface Props {
  email: string;
  onClose: () => void;
  onSuccess: () => void;
  defaultPlan?: string;
  hideTryDemo?: boolean;
  /** Force-hide the production-test card regardless of the QA flag or
   * has_current_access. Set from surfaces (like /plan) that already
   * know the user is subscribed — even if /api/usage's cache is stale,
   * the card stays hidden. */
  hideProductionTest?: boolean;
}


export function SubscriptionModal({ email, onClose, defaultPlan, hideTryDemo, hideProductionTest }: Props) {
  const router = useRouter();
  const [selectedPlan, setSelectedPlan] = useState<string>(defaultPlan ?? "");
  const [error, setError] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);

  // SWR caches the response in-memory across modal opens for instant
  // re-render, but each fetch bypasses the browser + edge cache so
  // admin-edited features show up immediately. The founder-spots
  // query is also live since the slot counter ticks down on every
  // claim — staleness there is visible to the user.
  const swrFetcher = async (url: string) => {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const { data: plansData } = useSWR<{ plans?: PlanDTO[] }>("/api/plans", swrFetcher, {
    revalidateOnMount: true,
    revalidateOnFocus: true,
    dedupingInterval: 2_000,
  });
  const { data: founderData } = useSWR<{ active?: boolean; spots_left?: number }>(
    "/api/founder-spots",
    swrFetcher,
    { revalidateOnFocus: true, refreshInterval: 30_000 },
  );
  // Used solely to read is_production_test for the current user — the
  // production-test plan card is otherwise hidden so customers never
  // see it. is_admin is also returned here but we don't need it.
  const { data: usageData, isLoading: usageLoading } = useSWR<{ is_production_test?: boolean; has_active_subscription?: boolean; has_current_access?: boolean; subscription_expired?: boolean; plan?: string }>(
    "/api/usage",
    swrFetcher,
    { revalidateOnFocus: true },
  );
  const plans: PlanDTO[] | null = plansData?.plans ?? null;
  const founderActive: boolean | null = typeof founderData?.active === "boolean" ? founderData.active : null;
  const spotsLeft: number | null = typeof founderData?.spots_left === "number" ? founderData.spots_left : null;
  const isProductionTest = usageData?.is_production_test === true;
  // Hide the production-test card while the user still has access —
  // either an active sub OR a cancelled-but-in-grace-period sub.
  const hasCurrentAccess = usageData?.has_current_access === true;
  // Ex-subscriber whose paid period lapsed: reframe the whole modal as
  // a renewal/upgrade (they already know the product — "Unlock Heclus"
  // and the free-demo pitch would read as if their account was wiped).
  const isRenewal = usageData?.subscription_expired === true;
  const previousPlan = isRenewal ? plans?.find(p => p.slug === usageData?.plan) ?? null : null;

  // Seed the selectedPlan once plans land. SWR may resolve before
  // this effect runs (cache hit), so we guard on a non-empty plans
  // list rather than a "just loaded" trigger. We also wait for the
  // usage fetch to settle: an expired subscriber should re-open on
  // their previous plan, and seeding before /api/usage answers would
  // lock in the founder/default pick instead. On fetch error
  // usageLoading flips false with no data, so seeding still happens.
  useEffect(() => {
    if (defaultPlan || !plans || plans.length === 0 || selectedPlan || usageLoading) return;
    if (isRenewal && previousPlan && !previousPlan.disabled) {
      setSelectedPlan(previousPlan.slug);
      return;
    }
    const founder = plans.find(p => p.isFounder && !p.disabled);
    setSelectedPlan(
      (founder ?? plans.find(p => !p.disabled && p.slug !== PRODUCTION_TEST_SLUG) ?? plans[0]).slug,
    );
  }, [plans, defaultPlan, selectedPlan, usageLoading, isRenewal, previousPlan]);

  // Founder visibility gates on the server's 'active' flag AND the slot
  // count: sold out is unavailable even if the flag hasn't been flipped
  // yet, since claim_founder_spot would reject the purchase anyway.
  // A null count means "not known", which must not hide the card.
  const founderSoldOut = spotsLeft !== null && spotsLeft <= 0;
  const founderAvailable = (founderActive === null || founderActive === true) && !founderSoldOut;

  const visiblePlans = useMemo(() => {
    if (!plans) return [];
    return plans
      // production-test is the live-Dodo verification harness — only
      // accounts flagged with app_metadata.is_production_test see it,
      // AND only when the user has no current access (unpaid or fully
      // expired). Once someone is paid — even if they've cancelled and
      // are riding out the paid period — the "Try end-to-end" card is
      // noise.
      .filter((p) => p.slug !== PRODUCTION_TEST_SLUG || (isProductionTest && !hasCurrentAccess && !hideProductionTest))
      .filter((p) => !p.isFounder || founderAvailable);
  }, [plans, founderAvailable, isProductionTest, hasCurrentAccess, hideProductionTest]);

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
    // Save the pending plan in TWO places:
    //   - sessionStorage on this tab (unchanged, so a same-tab flow
    //     still works if a browser ever blocks the new-tab open)
    //   - localStorage so the checkout tab (a new window/tab) can read
    //     it — sessionStorage is per-tab and doesn't cross windows.
    // Also encode the plan in the callback URL as a third fallback in
    // case both storages are blocked (private/incognito profiles).
    try { sessionStorage.setItem("dodo_pending_plan", selectedPlan); } catch {}
    try { localStorage.setItem("dodo_pending_plan", selectedPlan); } catch {}
    const callbackUrl = new URL("/payment/callback", window.location.origin);
    callbackUrl.searchParams.set("plan", selectedPlan);
    const url = new URL(base);
    url.searchParams.set("redirect_url", callbackUrl.toString());
    if (email) url.searchParams.set("customer[email]", email);
    // Open Dodo checkout in a new tab via a synthetic anchor click.
    // window.open with "noopener" returns null even on success in most
    // browsers, so relying on its return value for a same-tab fallback
    // caused BOTH tabs to navigate (double-open). The anchor approach
    // never lies: the tab opens, the current tab stays put.
    const a = document.createElement("a");
    a.href = url.toString();
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setSubscribing(false);
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
        className="relative w-full max-w-4xl rounded-2xl overflow-hidden"
        style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}
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
        <div className="p-8">


        <div className="text-center mb-6">
          <h2 className="text-xl font-bold mb-1" style={{ color: "var(--c-90)" }}>
            {isRenewal ? "Your subscription has expired" : "Unlock Heclus"}
          </h2>
          <p className="text-sm" style={{ color: "var(--c-45)" }}>
            {isRenewal
              ? "Your niches and videos are safe. Renew to keep creating — or move up a plan."
              : "Pick the plan that fits your workflow."}
          </p>
        </div>

        {/* Try Demo — hidden when the caller explicitly opts out
            (hideTryDemo), when the user already has current access, OR
            when this is a renewal (an expired subscriber has done the
            demo's job already; pitching "explore Heclus free" next to
            "your subscription expired" reads like a downgrade offer). */}
        {!hideTryDemo && !hasCurrentAccess && !isRenewal && <button
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
                  {plan.slug === PRODUCTION_TEST_SLUG && (
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
          ) : !selected ? (
            "Subscribe"
          ) : !isRenewal ? (
            `Subscribe to ${selected.name}`
          ) : !previousPlan || previousPlan.slug === selected.slug ? (
            // Unknown previous plan (webhook wrote paid but never a
            // slug, or the plan was retired) still reads as a renewal.
            `Renew ${selected.name}`
          ) : selected.sortOrder > previousPlan.sortOrder ? (
            `Upgrade to ${selected.name}`
          ) : (
            `Switch to ${selected.name}`
          )}
        </button>

        </div>
      </div>
    </div>
  );
}
