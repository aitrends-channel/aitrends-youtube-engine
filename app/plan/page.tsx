"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ArrowLeft, Check, LogOut, Zap, CalendarDays, RefreshCw, Settings } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PageLoader } from "@/components/PageLoader";
import { SubscriptionModal } from "@/components/SubscriptionModal";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Spinner } from "@/components/ui/spinner";

const PLANS: Record<string, {
  name: string;
  price: string;
  period: string;
  color: string;
  features: string[];
}> = {
  founder: {
    name: "Founder",
    price: "$0.50",
    period: "/ year",
    color: "oklch(0.72 0.25 285)",
    features: ["20 niches", "HD image processing", "Full AI pipeline", "All features included", "1 year — no renewal"],
  },
  starter: {
    name: "Starter",
    price: "$19",
    period: "/mo",
    color: "oklch(0.62 0.18 200)",
    features: ["5 niches/month", "Standard image processing", "Full AI pipeline", "All features included", "Community support"],
  },
  pro: {
    name: "Pro",
    price: "$49",
    period: "/mo",
    color: "oklch(0.72 0.25 285)",
    features: ["Unlimited niches", "HD image processing", "Full AI pipeline", "All features included", "Priority support"],
  },
};

interface PlanData {
  email: string;
  paid: boolean;
  paid_at: string | null;
  plan: string | null;
  plan_expires_at: string | null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" });
}

function daysUntil(iso: string) {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

export default function PlanPage() {
  const router = useRouter();
  const [planData, setPlanData] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [userEmail, setUserEmail] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  useEffect(() => {
    fetch("/api/plan")
      .then((r) => r.json())
      .then((d: PlanData) => {
        setPlanData(d);
        setUserEmail(d.email);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <PageLoader />;

  const plan = planData?.plan ? PLANS[planData.plan] : null;
  const expiresAt = planData?.plan_expires_at;
  const paidAt = planData?.paid_at;
  const daysLeft = expiresAt ? daysUntil(expiresAt) : null;
  const isExpired = daysLeft !== null && daysLeft <= 0;
  const expiringSOon = daysLeft !== null && daysLeft > 0 && daysLeft <= 30;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-page)" }}>
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
            <span className="text-sm tracking-tight ml-1" style={{ color: "var(--c-50)" }}>Plan</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => router.push("/dashboard")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
            style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
          >
            <ArrowLeft size={13} />
            Back
          </button>
          <ThemeToggle />
          <div className="relative" ref={profileMenuRef}>
            <button
              onClick={() => setShowProfileMenu(v => !v)}
              className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              {userEmail ? userEmail[0].toUpperCase() : "?"}
            </button>
            {showProfileMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
                <div
                  className="absolute right-0 top-11 z-50 w-56 rounded-2xl py-3 shadow-2xl"
                  style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}
                >
                  <div className="px-4 pb-3" style={{ borderBottom: "1px solid oklch(1 0 0 / 0.07)" }}>
                    <p className="text-xs font-semibold truncate" style={{ color: "var(--c-88)" }}>
                      {userEmail || "Loading…"}
                    </p>
                  </div>
                  <div className="px-2 pt-2">
                    <button
                      onClick={() => { setShowProfileMenu(false); router.push("/dashboard"); }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                      style={{ color: "var(--c-60)" }}
                    >
                      <Settings size={13} />
                      <span>Dashboard</span>
                    </button>
                    <button
                      onClick={() => { setShowProfileMenu(false); handleSignOut(); }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                      style={{ color: "#f87171" }}
                    >
                      <LogOut size={13} />
                      <span>Sign Out</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-xl mx-auto px-8 py-14 space-y-6">

        {/* Heading */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
              <Zap size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
            </div>
            <h1 className="text-2xl font-bold text-foreground">Your Plan</h1>
          </div>
          <p className="text-sm leading-relaxed" style={{ color: "var(--c-50)" }}>
            View your current plan details and manage your subscription.
          </p>
        </div>

        {!planData?.paid ? (
          /* No active plan */
          <div className="p-6 rounded-2xl text-center space-y-4"
            style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
            <p className="text-sm font-medium" style={{ color: "var(--c-60)" }}>You don&apos;t have an active plan.</p>
            <button
              onClick={() => setShowModal(true)}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
              style={{ background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))", color: "var(--c-98)" }}>
              Choose a Plan
            </button>
          </div>
        ) : (
          <>
            {/* Current plan card */}
            <div className="p-5 rounded-2xl space-y-5"
              style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
              <div className="flex items-start justify-between">
                <div>
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full capitalize mb-2"
                    style={{
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      color: "oklch(0.72 0.25 285)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                    }}>
                    <Zap size={10} />
                    {plan?.name ?? planData.plan} plan
                  </span>
                  <p className="text-2xl font-bold text-foreground">
                    {plan?.price ?? "—"}
                    <span className="text-sm font-normal ml-1" style={{ color: "var(--c-45)" }}>{plan?.period}</span>
                  </p>
                </div>

                {isExpired && (
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
                    style={{ background: "oklch(0.6 0.22 25 / 0.12)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}>
                    Expired
                  </span>
                )}
                {expiringSOon && !isExpired && (
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
                    style={{ background: "oklch(0.75 0.18 70 / 0.12)", color: "oklch(0.75 0.18 70)", border: "1px solid oklch(0.75 0.18 70 / 0.25)" }}>
                    Expiring soon
                  </span>
                )}
              </div>

              {plan && (
                <ul className="space-y-2">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2.5 text-sm" style={{ color: "var(--c-65)" }}>
                      <span className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                        style={{ background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)" }}>
                        <Check size={9} strokeWidth={3} />
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Billing details */}
            <div className="p-5 rounded-2xl space-y-3"
              style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--c-40)" }}>Billing Details</p>

              {paidAt && (
                <div className="flex items-center gap-3">
                  <CalendarDays size={14} style={{ color: "var(--c-40)" }} />
                  <div>
                    <p className="text-xs" style={{ color: "var(--c-40)" }}>Started</p>
                    <p className="text-sm font-medium text-foreground">{formatDate(paidAt)}</p>
                  </div>
                </div>
              )}

              {expiresAt && (
                <div className="flex items-center gap-3">
                  <CalendarDays size={14} style={{ color: isExpired ? "oklch(0.7 0.2 25)" : expiringSOon ? "oklch(0.75 0.18 70)" : "var(--c-40)" }} />
                  <div>
                    <p className="text-xs" style={{ color: "var(--c-40)" }}>
                      {isExpired ? "Expired on" : "Expires on"}
                    </p>
                    <p className="text-sm font-medium" style={{ color: isExpired ? "oklch(0.7 0.2 25)" : "var(--c-88)" }}>
                      {formatDate(expiresAt)}
                      {!isExpired && daysLeft !== null && (
                        <span className="ml-2 text-xs font-normal" style={{ color: expiringSOon ? "oklch(0.75 0.18 70)" : "var(--c-40)" }}>
                          ({daysLeft} day{daysLeft !== 1 ? "s" : ""} left)
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              )}

              {!expiresAt && (
                <div className="flex items-center gap-3">
                  <RefreshCw size={14} style={{ color: "oklch(0.65 0.15 145)" }} />
                  <div>
                    <p className="text-xs" style={{ color: "var(--c-40)" }}>Billing cycle</p>
                    <p className="text-sm font-medium text-foreground">
                      {plan?.period === "/mo" ? "Monthly" : "Annual"}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Renew / Change Plan */}
            <div className="space-y-3">
              {(isExpired || expiresAt) && (
                <button
                  onClick={() => setShowModal(true)}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                  style={{
                    background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                    color: "var(--c-98)",
                    boxShadow: "0 0 24px oklch(0.72 0.25 285 / 0.2)",
                  }}>
                  <RefreshCw size={15} />
                  {isExpired ? "Renew Plan" : "Renew Early"}
                </button>
              )}
              <button
                onClick={() => setShowModal(true)}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-80"
                style={{
                  background: "oklch(1 0 0 / 0.06)",
                  color: "var(--c-60)",
                  border: "1px solid oklch(1 0 0 / 0.08)",
                }}>
                Change Plan
              </button>
            </div>
          </>
        )}
      </main>

      {showModal && (
        <SubscriptionModal
          email={userEmail}
          onClose={() => setShowModal(false)}
          onSuccess={() => {
            setShowModal(false);
            window.location.reload();
          }}
        />
      )}
    </div>
  );
}
