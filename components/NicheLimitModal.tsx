"use client";

import { useState } from "react";
import Image from "next/image";
import { X, RefreshCw, Zap, AlertTriangle } from "lucide-react";

const PLAN_PERMALINKS: Record<string, string> = {
  founder: process.env.NEXT_PUBLIC_GUMROAD_PRODUCT_FOUNDER ?? "svxbq",
  starter: process.env.NEXT_PUBLIC_GUMROAD_PRODUCT_STARTER ?? "ipntsc",
  pro:     process.env.NEXT_PUBLIC_GUMROAD_PRODUCT_PRO     ?? "htvrim",
};

const PLAN_LABELS: Record<string, string> = {
  founder: "Founder",
  starter: "Starter",
  pro:     "Pro",
};

const PLAN_LIMITS: Record<string, number | null> = {
  founder: 20,
  starter: 5,
  pro:     null,
};

const PLAN_PRICES: Record<string, string> = {
  founder: "$40/yr",
  starter: "$19/mo",
  pro:     "$49/mo",
};

// Next tier to suggest when at limit
const UPGRADE_PATH: Record<string, string> = {
  founder: "pro",
  starter: "pro",
};

function loadGumroadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[src*="gumroad.com/js"]')) { resolve(); return; }
    const script = document.createElement("script");
    script.src = "https://gumroad.com/js/gumroad.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Gumroad"));
    document.head.appendChild(script);
  });
}

interface Props {
  email: string;
  userPlan: string;
  nicheLimit: number;
  onClose: () => void;
  onSuccess: () => void;
}

export function NicheLimitModal({ email, userPlan, nicheLimit, onClose, onSuccess }: Props) {
  const [loading, setLoading] = useState<"renew" | "upgrade" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const planLabel = PLAN_LABELS[userPlan] ?? userPlan;
  const isAlreadyPro = userPlan === "pro";
  const upgradePlan = UPGRADE_PATH[userPlan] ?? null;
  const upgradePlanLabel = upgradePlan ? (PLAN_LABELS[upgradePlan] ?? upgradePlan) : null;
  const upgradePlanPrice = upgradePlan ? (PLAN_PRICES[upgradePlan] ?? "") : "";

  function pollForPayment() {
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/plan");
        const data = await res.json();
        if (data.paid) {
          clearInterval(interval);
          onSuccess();
        }
      } catch { /* keep polling */ }
    }, 2000);
    setTimeout(() => clearInterval(interval), 30000);
  }

  async function handleGumroad(plan: string, type: "renew" | "upgrade") {
    setLoading(type);
    setError(null);
    try {
      await loadGumroadScript();
    } catch {
      setLoading(null);
      setError("Could not load payment. Check your connection and try again.");
      return;
    }

    const permalink = PLAN_PERMALINKS[plan];
    if (!permalink) { setLoading(null); return; }

    const a = document.createElement("a");
    a.href = `https://aitrendschannel.gumroad.com/l/${permalink}?wanted=true&email=${encodeURIComponent(email)}`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { if (a.parentNode) a.parentNode.removeChild(a); }, 100);

    const observer = new MutationObserver(() => {
      const overlay = document.querySelector(".gumroad-overlay-container, #gumroad-overlay, iframe[src*='gumroad']");
      if (!overlay) {
        observer.disconnect();
        setLoading(null);
        pollForPayment();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center p-4"
      style={{ background: "oklch(0 0 0 / 0.72)", backdropFilter: "blur(6px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-md rounded-2xl p-8 space-y-6"
        style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}>

        <button onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg transition-opacity hover:opacity-60 cursor-pointer"
          style={{ color: "var(--c-40)" }}>
          <X size={16} />
        </button>

        {/* Top-left logo */}
        <div className="flex items-center gap-2">
          <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="rounded-xl" />
          <span className="text-sm font-bold text-foreground">Heclus</span>
        </div>

        {/* Icon + heading */}
        <div className="flex flex-col items-center text-center gap-3">
          <div className="w-10 h-10 rounded-2xl flex items-center justify-center"
            style={{ background: "oklch(0.6 0.22 25 / 0.12)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}>
            <AlertTriangle size={18} style={{ color: "oklch(0.7 0.2 25)" }} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">Niche limit reached</h2>
            <p className="text-sm mt-1" style={{ color: "var(--c-50)" }}>
              You&apos;ve used all <strong style={{ color: "var(--c-75)" }}>{nicheLimit} niches</strong> included in your{" "}
              <strong style={{ color: "var(--c-75)" }}>{planLabel}</strong> plan.
            </p>
          </div>
        </div>

        <p className="text-xs text-center leading-relaxed" style={{ color: "var(--c-42)" }}>
          Choose an option below to continue creating niches.
        </p>

        {/* Options */}
        <div className="space-y-3">
          {/* Renew current plan */}
          {!isAlreadyPro && (
            <button
              onClick={() => handleGumroad(userPlan, "renew")}
              disabled={loading !== null}
              className="w-full rounded-xl p-4 text-left transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
              style={{ background: "oklch(1 0 0 / 0.06)", border: "1px solid oklch(1 0 0 / 0.1)" }}
            >
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
                  {loading === "renew" ? (
                    <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin"
                      style={{ color: "oklch(0.72 0.25 285)" }} />
                  ) : (
                    <RefreshCw size={14} style={{ color: "oklch(0.72 0.25 285)" }} />
                  )}
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Renew {planLabel} plan
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                    Get another {PLAN_LIMITS[userPlan] ?? nicheLimit} niches — keeps all your existing work
                  </p>
                </div>
              </div>
            </button>
          )}

          {/* Upgrade to next tier */}
          {upgradePlan && (
            <button
              onClick={() => handleGumroad(upgradePlan, "upgrade")}
              disabled={loading !== null}
              className="w-full rounded-xl p-4 text-left transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
              style={{
                background: "linear-gradient(135deg, oklch(0.72 0.25 285 / 0.12), oklch(0.58 0.28 300 / 0.12))",
                border: "1px solid oklch(0.72 0.25 285 / 0.35)",
              }}
            >
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: "oklch(0.72 0.25 285)", boxShadow: "0 0 12px oklch(0.72 0.25 285 / 0.4)" }}>
                  {loading === "upgrade" ? (
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Zap size={14} style={{ color: "white" }} />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">Upgrade to {upgradePlanLabel}</p>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                      style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
                      {upgradePlanPrice}
                    </span>
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                    Unlimited niches — never worry about limits again
                  </p>
                </div>
              </div>
            </button>
          )}
        </div>

        {error && (
          <p className="text-xs px-3 py-2 rounded-lg"
            style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}>
            {error}
          </p>
        )}

        <p className="text-center text-xs" style={{ color: "var(--c-30)" }}>
          Secured by Gumroad · Instant activation
        </p>
      </div>
    </div>
  );
}
