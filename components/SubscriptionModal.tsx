"use client";

import { useState } from "react";
import { X, Check, Zap } from "lucide-react";

const FEATURES = [
  "Full AI automation pipeline",
  "Script & voiceover generation",
  "AI images & video clips",
  "Thumbnail generation",
  "Unlimited projects",
  "Priority support",
];

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
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      console.error("[Paystack] PaystackPop not found on window after script load");
      setLoading(false);
      setError("Paystack failed to initialise. Please refresh the page and try again.");
      return;
    }

    setLoading(false);

    try {
      const handler = window.PaystackPop.setup({
        key: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
        email,
        amount: Number(process.env.NEXT_PUBLIC_PAYSTACK_AMOUNT),
        currency: process.env.NEXT_PUBLIC_PAYSTACK_CURRENCY ?? "NGN",
        ref: `ait_${Date.now()}`,
        label: "Heclus",
        callback: function (response: { reference: string }) {
          setVerifying(true);
          fetch("/api/paystack/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reference: response.reference }),
          })
            .then(function (res) {
              if (res.ok) {
                onSuccess();
                return;
              }
              return res.json().catch(() => ({})).then(function (data) {
                setError(data.error ?? "Payment verification failed. Contact support.");
              });
            })
            .catch(function () {
              setError("Failed to verify payment. Contact support.");
            })
            .finally(function () {
              setVerifying(false);
            });
        },
        onClose: function () {},
      });

      handler.openIframe();
    } catch (err) {
      console.error("[Paystack] setup/openIframe failed:", err);
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
        className="relative w-full max-w-md rounded-2xl p-8"
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
        <div className="flex justify-center mb-6">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold"
            style={{
              background: "oklch(0.72 0.25 285 / 0.15)",
              color: "oklch(0.72 0.25 285)",
              border: "1px solid oklch(0.72 0.25 285 / 0.25)",
            }}
          >
            <Zap size={12} />
            Subscription Required
          </div>
        </div>

        {/* Heading */}
        <div className="text-center mb-6">
          <h2 className="text-xl font-bold mb-1.5" style={{ color: "var(--c-90)" }}>
            Heclus One Time Subscription
          </h2>
          <p className="text-sm leading-relaxed" style={{ color: "var(--c-45)" }}>
            Subscribe to unlock the full YouTube automation workflow.
          </p>
        </div>

        {/* Features */}
        <ul className="space-y-2.5 mb-8">
          {FEATURES.map((f) => (
            <li key={f} className="flex items-center gap-3 text-sm" style={{ color: "var(--c-70)" }}>
              <span
                className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                style={{ background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)" }}
              >
                <Check size={10} strokeWidth={3} />
              </span>
              {f}
            </li>
          ))}
        </ul>

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
          {verifying ? "Verifying payment…" : loading ? "Loading…" : "Subscribe"}
        </button>

        <p className="text-center text-xs mt-3" style={{ color: "var(--c-32)" }}>
          Secured by Paystack · One-time payment · Lifetime access
        </p>
      </div>
    </div>
  );
}
