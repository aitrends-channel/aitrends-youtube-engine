"use client";

import { useState, useEffect } from "react";
import { X, Check, Zap } from "lucide-react";

const FOUNDER_LIMIT = 100;

const PLANS = [
  {
    id: "founder",
    name: "Founder",
    price: "$40",
    period: " / year",
    limit: "1 year · 20 niches",
    amountEnv: "NEXT_PUBLIC_PAYSTACK_AMOUNT_FOUNDER",
    features: ["20 niches", "Unlimited videos per niche", "Full AI pipeline", "All features included", "1 year — no renewal"],
    highlighted: false,
    disabled: false,
    founder: true,
  },
  {
    id: "starter",
    name: "Starter",
    price: "$19",
    period: "/mo",
    limit: "5 niches · 3 videos each",
    amountEnv: "NEXT_PUBLIC_PAYSTACK_AMOUNT_STARTER",
    features: ["5 niches/month", "3 videos per niche", "Full AI pipeline", "All features included", "Community support"],
    disabled: false,
  },
  {
    id: "pro",
    name: "Pro",
    price: "$49",
    period: "/mo",
    limit: "Unlimited niches & videos",
    amountEnv: "NEXT_PUBLIC_PAYSTACK_AMOUNT_PRO",
    features: ["Unlimited niches", "Unlimited videos per niche", "Full AI pipeline", "All features included", "Priority support"],
    highlighted: true,
    disabled: false,
  },
  {
    id: "agency",
    name: "Agency",
    price: "$99",
    period: "/mo",
    limit: "3 seats + unlimited",
    amountEnv: "NEXT_PUBLIC_PAYSTACK_AMOUNT_AGENCY",
    features: ["3 team seats", "Unlimited niches", "Full AI pipeline", "All Pro features", "Priority support"],
    disabled: true,
  },
];

const PLAN_AMOUNTS: Record<string, number> = {
  founder: Number(process.env.NEXT_PUBLIC_PAYSTACK_AMOUNT_FOUNDER),
  starter: Number(process.env.NEXT_PUBLIC_PAYSTACK_AMOUNT_STARTER),
  pro:     Number(process.env.NEXT_PUBLIC_PAYSTACK_AMOUNT_PRO),
  agency:  Number(process.env.NEXT_PUBLIC_PAYSTACK_AMOUNT_AGENCY),
};

declare global {
  interface Window {
    PaystackPop: {
      setup: (config: Record<string, unknown>) => { openIframe: () => void };
    };
  }
}

interface Props {
  email: string;
  onClose: () => void;
  onSuccess: () => void;
}

function loadPaystackScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.PaystackPop) return resolve();
    const script = document.createElement("script");
    script.src = "https://js.paystack.co/v1/inline.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Paystack"));
    document.head.appendChild(script);
  });
}

export function SubscriptionModal({ email, onClose, onSuccess }: Props) {
  const [selectedPlan, setSelectedPlan] = useState("founder");
  const [spotsLeft, setSpotsLeft] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/founder-spots")
      .then(r => r.json())
      .then(d => setSpotsLeft(d.remaining))
      .catch(() => {});
  }, []);

  async function handleSubscribe() {
    setLoading(true);
    setError(null);

    try {
      await loadPaystackScript();
    } catch (err) {
      console.error("[Paystack] Script load failed:", err);
      setLoading(false);
      setError("Could not load Paystack. Check your internet connection and try again.");
      return;
    }

    if (!window.PaystackPop) {
      setLoading(false);
      setError("Paystack failed to initialise. Please refresh the page and try again.");
      return;
    }

    setLoading(false);

    const amount = PLAN_AMOUNTS[selectedPlan] || Number(process.env.NEXT_PUBLIC_PAYSTACK_AMOUNT);

    try {
      const handler = window.PaystackPop.setup({
        key: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
        email,
        amount,
        currency: process.env.NEXT_PUBLIC_PAYSTACK_CURRENCY ?? "NGN",
        channels: ["card"],
        ref: `ait_${selectedPlan}_${Date.now()}`,
        label: "Heclus",
        callback: function (response: { reference: string }) {
          setVerifying(true);
          fetch("/api/paystack/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reference: response.reference, plan: selectedPlan }),
          })
            .then(function (res) {
              if (res.ok) { onSuccess(); return; }
              return res.json().catch(() => ({})).then(function (data) {
                setError(data.error ?? "Payment verification failed. Contact support.");
              });
            })
            .catch(function () {
              setError("Failed to verify payment. Contact support.");
            })
            .finally(function () { setVerifying(false); });
        },
        onClose: function () {},
      });

      handler.openIframe();
    } catch (err) {
      setError(`Payment setup failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "oklch(0 0 0 / 0.72)", backdropFilter: "blur(6px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-2xl rounded-2xl p-8"
        style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg transition-opacity hover:opacity-60 cursor-pointer"
          style={{ color: "var(--c-40)" }}
        >
          <X size={16} />
        </button>

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

        {/* Plan selector */}
        <div className="grid grid-cols-4 gap-3 mb-6">
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
          disabled={loading || verifying}
          className="w-full py-3 rounded-xl text-sm font-bold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          style={{
            background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
            color: "var(--c-98)",
          }}
        >
          {verifying ? "Verifying payment…" : loading ? "Loading…" : `Subscribe to ${PLANS.find(p => p.id === selectedPlan)?.name}`}
        </button>

        <p className="text-center text-xs mt-3" style={{ color: "var(--c-32)" }}>
          Secured by Paystack · Cancel anytime
        </p>
      </div>
    </div>
  );
}
