"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Stage = "verifying" | "success" | "failed" | "cancelled";

function CallbackContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("verifying");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const status = searchParams.get("status");
    const paymentId = searchParams.get("payment_id");

    if (status === "cancelled") {
      setStage("cancelled");
      return;
    }

    if (!paymentId || (status && status !== "succeeded")) {
      setStage("failed");
      setErrorMsg("Payment was not completed.");
      return;
    }

    (async () => {
      // Read the plan the user selected before redirecting to Dodo.
      // Do NOT remove it until verify succeeds — on a transient failure +
      // page refresh, we'd lose the selection and a fallback default could
      // mark the user on the wrong tier even though they paid for another.
      let plan: string | null = null;
      try { plan = sessionStorage.getItem("dodo_pending_plan"); } catch {}

      if (!plan) {
        setStage("failed");
        setErrorMsg("Plan selection was lost. Please contact support with your payment ID — do not retry payment.");
        return;
      }

      try {
        const res = await fetch("/api/dodo/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payment_id: paymentId, plan }),
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
          <Loader2 size={40} className="animate-spin mb-5" style={{ color: "oklch(0.72 0.25 285)" }} />
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
            <Loader2 size={36} className="animate-spin" style={{ color: "oklch(0.72 0.25 285)" }} />
          </div>
        }
      >
        <CallbackContent />
      </Suspense>
    </div>
  );
}
