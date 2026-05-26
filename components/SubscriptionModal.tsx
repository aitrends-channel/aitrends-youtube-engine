"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { X, Check, Zap, PlayCircle } from "lucide-react";

const FOUNDER_LIMIT = 100;

const PLANS = [
  {
    id: "founder",
    name: "Founder",
    price: "$0",
    period: " / year",
    limit: "1 year · 20 niches",
    features: ["20 niches", "HD image processing", "Full AI pipeline", "All features included", "1 year — no renewal"],
    highlighted: false,
    disabled: false,
    founder: true,
  },
  {
    id: "starter",
    name: "Starter",
    price: "$19",
    period: "/mo",
    limit: "5 niches/month",
    features: ["5 niches/month", "Standard image processing", "Full AI pipeline", "All features included", "Community support"],
    disabled: false,
  },
  {
    id: "pro",
    name: "Pro",
    price: "$49",
    period: "/mo",
    limit: "Unlimited niches",
    features: ["Everything in Starter", "Clone unlimited YouTube niches", "Unlimited video creation", "Bulk video generation", "Priority rendering queue", "Priority support"],
    highlighted: true,
    disabled: false,
  },
];

const DODO_PAYMENT_LINKS: Record<string, string> = {
  founder: process.env.NEXT_PUBLIC_DODO_LINK_FOUNDER ?? "",
  starter: process.env.NEXT_PUBLIC_DODO_LINK_STARTER ?? "",
  pro:     process.env.NEXT_PUBLIC_DODO_LINK_PRO     ?? "",
};

interface Props {
  email: string;
  onClose: () => void;
  onSuccess: () => void;
  defaultPlan?: string;
  hideTryDemo?: boolean;
}


export function SubscriptionModal({ email, onClose, onSuccess, defaultPlan, hideTryDemo }: Props) {
  const router = useRouter();
  const [selectedPlan, setSelectedPlan] = useState(defaultPlan ?? "founder");
  const [spotsLeft, setSpotsLeft] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/founder-spots")
      .then(r => r.json())
      .then(d => setSpotsLeft(d.remaining))
      .catch(() => {});
  }, []);

  function handleSubscribe() {
    const base = DODO_PAYMENT_LINKS[selectedPlan];
    if (!base) {
      setError("Payment not configured for this plan. Contact support.");
      return;
    }
    try { sessionStorage.setItem("dodo_pending_plan", selectedPlan); } catch {}
    const callbackUrl = `${window.location.origin}/payment/callback`;
    const url = new URL(base);
    url.searchParams.set("redirect_url", callbackUrl);
    window.location.href = url.toString();
  }

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
          className="absolute top-4 right-4 z-10 p-1.5 rounded-lg transition-opacity hover:opacity-60 cursor-pointer"
          style={{ color: "var(--c-40)" }}
        >
          <X size={16} />
        </button>
        <div className="overflow-y-auto p-8" style={{ maxHeight: "90vh" }}>

        {/* Badge */}
        <div className="flex justify-center mb-5">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold"
            style={{
              background: "oklch(0.72 0.25 285 / 0.15)",
              color: "oklch(0.72 0.25 285)",
              border: "1px solid oklch(0.72 0.25 285 / 0.25)",
            }}
          >
            <Zap size={12} />
            Choose a Plan
          </div>
        </div>

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

        {/* Plan selector */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {PLANS.map((plan) => (
            <button
              key={plan.id}
              onClick={() => !plan.disabled && setSelectedPlan(plan.id)}
              className="relative rounded-xl p-3 text-left transition-all"
              style={{
                background: plan.disabled ? "oklch(1 0 0 / 0.01)" : selectedPlan === plan.id ? "oklch(0.72 0.25 285 / 0.12)" : "oklch(1 0 0 / 0.03)",
                border: plan.disabled ? "1px solid oklch(1 0 0 / 0.05)" : selectedPlan === plan.id
                  ? "1px solid oklch(0.72 0.25 285 / 0.50)"
                  : "1px solid oklch(1 0 0 / 0.08)",
                opacity: plan.disabled ? 0.4 : 1,
                cursor: plan.disabled ? "not-allowed" : "pointer",
              }}
            >
              {plan.founder && (
                <span
                  className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
                  style={{ background: "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))", color: "white" }}
                >
                  🔥 {spotsLeft !== null ? `${spotsLeft} spots left` : "First 100"}
                </span>
              )}
              {plan.highlighted && (
                <span
                  className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
                  style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
                >
                  Popular
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
              <p className="text-xs font-semibold mb-1" style={{ color: selectedPlan === plan.id ? "oklch(0.82 0.18 285)" : "var(--c-60)" }}>
                {plan.name}
              </p>
              <p className="text-base font-bold" style={{ color: "var(--c-90)" }}>
                {plan.price}<span className="text-xs font-normal" style={{ color: "var(--c-40)" }}>{plan.period}</span>
              </p>
              <p className="text-[10px] mt-0.5" style={{ color: "var(--c-35)" }}>{plan.limit}</p>
            </button>
          ))}
        </div>

        {/* Selected plan features */}
        {(() => {
          const plan = PLANS.find(p => p.id === selectedPlan)!;
          return (
            <ul className="space-y-2 mb-6">
              {plan.features.map((f) => (
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
          );
        })()}

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
          className="w-full py-3 rounded-xl text-sm font-bold transition-all hover:opacity-90 cursor-pointer"
          style={{
            background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
            color: "var(--c-98)",
          }}
        >
          {`Subscribe to ${PLANS.find(p => p.id === selectedPlan)?.name}`}
        </button>

        <p className="text-center text-xs mt-3" style={{ color: "var(--c-32)" }}>
          Secured by DodoPayments · Cancel anytime
        </p>
        </div>
      </div>
    </div>
  );
}
