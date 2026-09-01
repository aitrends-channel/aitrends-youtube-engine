"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { PENDING_CREDIT_PURCHASE_KEY } from "@/lib/credits-checkout";

type Stage = "verifying" | "success" | "failed" | "cancelled";

function CallbackContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("verifying");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Guard against React StrictMode firing this effect twice in dev (and
  // any other accidental remount). Server idempotency is the real fix,
  // but this avoids two network roundtrips per legitimate verification.
  const verifyStartedRef = useRef(false);

  useEffect(() => {
    if (verifyStartedRef.current) return;
    verifyStartedRef.current = true;
    const status = searchParams.get("status");
    const paymentId = searchParams.get("payment_id");
   
    const subscriptionId = searchParams.get("subscription_id");

    if (status === "cancelled") {
      setStage("cancelled");
      return;
    }

    const goodStatuses = new Set(["succeeded", "active", "on_trial"]);
    const hasId = !!(paymentId || subscriptionId);
    const statusOk = !status || goodStatuses.has(status);
    if (!hasId || !statusOk) {
      setStage("failed");
      setErrorMsg("Payment was not completed.");
      return;
    }

    (async () => {
      // A credit top-up is not a plan purchase: it grants credits and can be
      // bought repeatedly, so it must not go through /api/dodo/verify, which
      // would rewrite the customer's plan and expiry. It also carries no plan,
      // which is why this page used to reject it with "Plan selection was lost".
      //
      // Intent is marked the same way the plan flow marks its own: a URL param
      // when the product's return URL provides one, plus storage set at click
      // time so it works whatever the product is configured with.
      //
      // Which wallet, as well as whether: "credits" is the GenAI video wallet,
      // "heclus" is the general one and "free_images" is the image allowance.
      // They credit different balances from
      // different routes, so guessing between them would hand a customer the
      // wrong thing for their money.
      const marker = (): string | null => {
        const fromUrl = searchParams.get("type");
        if (fromUrl === "credits" || fromUrl === "heclus" || fromUrl === "free_images") return fromUrl;
        // localStorage before sessionStorage: it is what survives a new-tab
        // checkout, which is how the Balance page opens Dodo.
        try {
          const v = localStorage.getItem(PENDING_CREDIT_PURCHASE_KEY);
          if (v === "credits" || v === "heclus" || v === "free_images") return v;
        } catch {}
        try {
          const v = sessionStorage.getItem(PENDING_CREDIT_PURCHASE_KEY);
          if (v === "credits" || v === "heclus" || v === "free_images") return v;
        } catch {}
        return null;
      };
      const wallet = marker();
      const buyingCredits = wallet !== null;

      if (buyingCredits) {
        if (!paymentId) {
          setStage("failed");
          setErrorMsg("Credit purchases need a payment id. Contact support with your receipt — do not retry payment.");
          return;
        }
        try {
          // One route per wallet, because each grants a different thing.
          const topupRoute = wallet === "heclus"
            ? "/api/heclus-credits/topup"
            : wallet === "free_images"
              ? "/api/free-images/topup"
              : "/api/credits/topup";
          const res = await fetch(topupRoute, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payment_id: paymentId }),
          });
          const data = await res.json().catch(() => ({})) as { error?: string; credits?: number };
          if (!res.ok) {
            setStage("failed");
            setErrorMsg(data.error ?? "We could not confirm that payment. Contact support with your payment ID.");
            return;
          }
          // Cleared only after the credits actually landed, so a refresh after a
          // transient failure still knows what was being bought.
          try { localStorage.removeItem(PENDING_CREDIT_PURCHASE_KEY); } catch {}
          try { sessionStorage.removeItem(PENDING_CREDIT_PURCHASE_KEY); } catch {}
          setStage("success");
          setTimeout(() => router.replace("/billing"), 2000);
        } catch {
          setStage("failed");
          setErrorMsg("Could not reach the credit service. Contact support with your payment ID.");
        }
        return;
      }

      // Read the plan the user selected before redirecting to Dodo.
      // Do NOT remove until verify succeeds — on a transient failure +
      // page refresh we'd lose the selection and a fallback default
      // could mark the user on the wrong tier even though they paid.
      //
      // Sources, in order:
      //   1. URL param — set by SubscriptionModal / NicheLimitModal
      //      when they encode plan=<slug> into the redirect_url. Robust
      //      because Dodo preserves the caller's query params.
      //   2. localStorage — set alongside sessionStorage; survives the
      //      new-tab checkout flow where sessionStorage is per-tab.
      //   3. sessionStorage — legacy same-tab path, kept for safety.
      let plan: string | null = searchParams.get("plan");
      if (!plan) {
        try { plan = localStorage.getItem("dodo_pending_plan"); } catch {}
      }
      if (!plan) {
        try { plan = sessionStorage.getItem("dodo_pending_plan"); } catch {}
      }

      if (!plan) {
        setStage("failed");
        setErrorMsg("Plan selection was lost. Please contact support with your payment ID — do not retry payment.");
        return;
      }

      try {
        const res = await fetch("/api/dodo/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payment_id: paymentId, subscription_id: subscriptionId, plan }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          setStage("failed");
          setErrorMsg(data.error ?? "Payment verification failed. Contact support.");
          return;
        }
      } catch {
        setStage("failed");
        setErrorMsg("Could not reach verification service. Contact support.");
        return;
      }

      // Only clear the pending plan after verification confirmed success.
      try { sessionStorage.removeItem("dodo_pending_plan"); } catch {}
      try { localStorage.removeItem("dodo_pending_plan"); } catch {}

      const supabase = createSupabaseBrowserClient();
      await supabase.auth.refreshSession();
      setStage("success");
      setTimeout(() => router.replace("/dashboard"), 2500);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-4 py-16 text-center">
      {stage === "verifying" && (
        <>
          <Loader2 size={40} className="animate-spin mb-5" style={{ color: "var(--brand-text)" }} />
          <h1 className="text-xl font-bold mb-2" style={{ color: "var(--c-90)" }}>Verifying your payment…</h1>
          <p className="text-sm" style={{ color: "var(--c-45)" }}>Please wait, this only takes a moment.</p>
        </>
      )}

      {stage === "success" && (
        <>
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5"
            style={{ background: "oklch(0.55 0.15 145 / 0.12)", border: "1px solid oklch(0.55 0.15 145 / 0.3)" }}
          >
            <CheckCircle2 size={32} style={{ color: "oklch(0.65 0.15 145)" }} />
          </div>
          <h1 className="text-xl font-bold mb-2" style={{ color: "var(--c-90)" }}>Payment confirmed!</h1>
          <p className="text-sm mb-6" style={{ color: "var(--c-45)" }}>
            Welcome aboard. Redirecting you to your dashboard…
          </p>
          <button
            onClick={() => router.replace("/dashboard")}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 cursor-pointer"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
          >
            Go to Dashboard →
          </button>
        </>
      )}

      {(stage === "failed" || stage === "cancelled") && (
        <>
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5"
            style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}
          >
            <XCircle size={32} style={{ color: "oklch(0.65 0.2 25)" }} />
          </div>
          <h1 className="text-xl font-bold mb-2" style={{ color: "var(--c-90)" }}>
            {stage === "cancelled" ? "Payment cancelled" : "Payment not verified"}
          </h1>
          <p className="text-sm mb-6" style={{ color: "var(--c-45)" }}>
            {stage === "cancelled"
              ? "You cancelled the payment. No charge was made."
              : (errorMsg ?? "We could not verify your payment. Contact support if your payment was deducted.")}
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.back()}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80 cursor-pointer"
              style={{ background: "var(--bg-control)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              ← Go Back
            </button>
            <button
              onClick={() => router.replace("/dashboard")}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
            >
              Dashboard
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function PaymentCallbackPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-page)" }}>
      <header
        className="flex items-center justify-between px-6 py-4 shrink-0"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}
      >
        <button onClick={() => router.push("/dashboard")} className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={28} height={28} className="object-cover w-full h-full" />
          </div>
          <span className="text-sm font-bold" style={{ color: "var(--c-90)" }}>Heclus</span>
        </button>
        <ThemeToggle />
      </header>

      <Suspense
        fallback={
          <div className="flex flex-col items-center justify-center flex-1 px-4">
            <Loader2 size={36} className="animate-spin" style={{ color: "var(--brand-text)" }} />
          </div>
        }
      >
        <CallbackContent />
      </Suspense>
    </div>
  );
}
