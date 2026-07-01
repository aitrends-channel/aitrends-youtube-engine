"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Check, LogOut, Zap, CalendarDays, RefreshCw, KeyRound, CreditCard, ExternalLink } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PageLoader } from "@/components/PageLoader";
import { SubscriptionModal } from "@/components/SubscriptionModal";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

interface PlanDetails {
  slug: string;
  name: string;
  priceDisplay: string;
  periodDisplay: string;
  limitDisplay: string;
  features: string[];
}

interface PlanData {
  email: string;
  paid: boolean;
  paid_at: string | null;
  plan: string | null;
  plan_details: PlanDetails | null;
  plan_expires_at: string | null;
  can_cancel_subscription?: boolean;
  subscription_cancelled?: boolean;
  customer_portal_url?: string | null;
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
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  async function handleCancelSubscription() {
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch("/api/dodo/cancel-subscription", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCancelError(body?.error ?? "Could not cancel subscription. Please try again.");
        return;
      }
      setShowCancelModal(false);
      window.location.reload();
    } catch (e) {
      setCancelError((e as Error).message || "Could not cancel subscription.");
    } finally {
      setCancelling(false);
    }
  }

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

  const plan = planData?.plan_details ?? null;
  const expiresAt = planData?.plan_expires_at;
  const paidAt = planData?.paid_at;
  const daysLeft = expiresAt ? daysUntil(expiresAt) : null;
  const isExpired = daysLeft !== null && daysLeft <= 0;
  const expiringSOon = daysLeft !== null && daysLeft > 0 && daysLeft <= 30;
  // "Cancelled" = user asked Dodo to stop renewing but the current
  // period hasn't run out yet. Distinct from `isExpired` (period ran
  // out) — cancelled users still have access and see a "Resubscribe"
  // primary CTA instead of "Renew".
  const isCancelled = !!planData?.subscription_cancelled && !isExpired;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-page)" }}>
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <Link href="/dashboard" className="flex items-center gap-3 transition-opacity hover:opacity-80">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
            <span className="text-sm tracking-tight ml-1" style={{ color: "var(--c-50)" }}>Plan</span>
          </div>
        </Link>
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
                    <Link
                      href="/account"
                      onClick={() => setShowProfileMenu(false)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80"
                      style={{ color: "var(--c-60)" }}
                    >
                      <KeyRound size={13} />
                      <span>Account</span>
                    </Link>
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

      <main className="flex-1 w-full max-w-5xl mx-auto px-8 py-14 space-y-8">

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
          <div className="p-10 rounded-2xl text-center space-y-4"
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
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            {/* Current plan card */}
            <div className="lg:col-span-3 p-6 rounded-2xl space-y-6"
              style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full capitalize mb-3"
                    style={{
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      color: "oklch(0.72 0.25 285)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                    }}>
                    <Zap size={10} />
                    {plan?.name ?? planData.plan ?? "Active"} plan
                  </span>
                  <p className="text-3xl font-bold text-foreground">
                    {plan?.priceDisplay ?? "—"}
                    <span className="text-sm font-normal ml-1" style={{ color: "var(--c-45)" }}>{plan?.periodDisplay}</span>
                  </p>
                  {plan?.limitDisplay && (
                    <p className="text-xs mt-1.5" style={{ color: "var(--c-50)" }}>{plan.limitDisplay}</p>
                  )}
                </div>

                {isExpired && (
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full shrink-0"
                    style={{ background: "oklch(0.6 0.22 25 / 0.12)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}>
                    Expired
                  </span>
                )}
                {isCancelled && (
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full shrink-0"
                    style={{ background: "oklch(0.6 0.22 25 / 0.10)", color: "oklch(0.65 0.20 25)", border: "1px solid oklch(0.6 0.22 25 / 0.22)" }}>
                    Cancelled
                  </span>
                )}
                {expiringSOon && !isExpired && !isCancelled && (
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full shrink-0"
                    style={{ background: "oklch(0.75 0.18 70 / 0.12)", color: "oklch(0.75 0.18 70)", border: "1px solid oklch(0.75 0.18 70 / 0.25)" }}>
                    Expiring soon
                  </span>
                )}
              </div>

              {isCancelled && (
                <div className="p-3 rounded-xl flex items-start gap-3"
                  style={{ background: "oklch(0.6 0.22 25 / 0.06)", border: "1px solid oklch(0.6 0.22 25 / 0.20)" }}>
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                    style={{ background: "oklch(0.6 0.22 25 / 0.10)", border: "1px solid oklch(0.6 0.22 25 / 0.20)" }}>
                    <CalendarDays size={14} style={{ color: "oklch(0.65 0.20 25)" }} />
                  </div>
                  <div className="text-sm">
                    <p className="font-semibold" style={{ color: "var(--c-88)" }}>Subscription cancelled</p>
                    <p className="mt-0.5" style={{ color: "var(--c-55)" }}>
                      You&apos;ll keep access
                      {expiresAt ? <> until <span className="font-semibold" style={{ color: "var(--c-88)" }}>{formatDate(expiresAt)}</span></> : <> until the end of your current billing period</>}
                      . Resubscribe any time to keep going.
                    </p>
                  </div>
                </div>
              )}

              <div className="pt-4" style={{ borderTop: "1px solid oklch(1 0 0 / 0.07)" }}>
                <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: "var(--c-40)" }}>
                  What&apos;s included
                </p>
                {plan && plan.features.length > 0 ? (
                  <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-start gap-2.5 text-sm" style={{ color: "var(--c-65)" }}>
                        <span className="w-4 h-4 mt-0.5 rounded-full flex items-center justify-center shrink-0"
                          style={{ background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)" }}>
                          <Check size={9} strokeWidth={3} />
                        </span>
                        {f}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm" style={{ color: "var(--c-50)" }}>
                    Your plan is active but its details aren&apos;t available. Contact support if this persists.
                  </p>
                )}
              </div>
            </div>

            {/* Right column: Billing + actions */}
            <div className="lg:col-span-2 space-y-6">
              <div className="p-6 rounded-2xl space-y-4"
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
                    <CalendarDays size={14} style={{ color: isExpired ? "oklch(0.7 0.2 25)" : isCancelled ? "oklch(0.65 0.20 25)" : expiringSOon ? "oklch(0.75 0.18 70)" : "var(--c-40)" }} />
                    <div>
                      <p className="text-xs" style={{ color: "var(--c-40)" }}>
                        {isExpired ? "Expired on" : isCancelled ? "Access ends on" : "Expires on"}
                      </p>
                      <p className="text-sm font-medium" style={{ color: isExpired ? "oklch(0.7 0.2 25)" : "var(--c-88)" }}>
                        {formatDate(expiresAt)}
                        {!isExpired && daysLeft !== null && (
                          <span className="ml-2 text-xs font-normal" style={{ color: isCancelled ? "oklch(0.65 0.20 25)" : expiringSOon ? "oklch(0.75 0.18 70)" : "var(--c-40)" }}>
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
                        {plan?.periodDisplay === "/mo" ? "Monthly" : "Annual"}
                      </p>
                    </div>
                  </div>
                )}

                {planData?.customer_portal_url && (
                  <div className="flex items-center gap-3 pt-3" style={{ borderTop: "1px solid oklch(1 0 0 / 0.07)" }}>
                    <CreditCard size={14} style={{ color: "var(--c-40)" }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs" style={{ color: "var(--c-40)" }}>Payment method</p>
                      <p className="text-sm font-medium text-foreground">Card on file</p>
                    </div>
                    <a
                      href={planData.customer_portal_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
                      style={{ background: "transparent", color: "var(--c-70)", border: "1px solid var(--bd-8)" }}
                    >
                      Manage
                      <ExternalLink size={11} />
                    </a>
                  </div>
                )}
              </div>

              {/* Renew / Resubscribe / Change Plan */}
              <div className="space-y-3">
                {isCancelled ? (
                  <button
                    onClick={() => setShowModal(true)}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                    style={{
                      background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                      color: "var(--c-98)",
                      boxShadow: "0 0 24px oklch(0.72 0.25 285 / 0.2)",
                    }}>
                    <RefreshCw size={15} />
                    Resubscribe
                  </button>
                ) : (
                  <>
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
                      className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                      style={{
                        background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                        color: "var(--c-98)",
                        boxShadow: "0 0 24px oklch(0.72 0.25 285 / 0.2)",
                      }}>
                      Change Plan
                    </button>
                  </>
                )}
                {planData?.can_cancel_subscription && (
                  <button
                    onClick={() => { setCancelError(null); setShowCancelModal(true); }}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                    style={{
                      background: "oklch(0.6 0.22 25)",
                      color: "white",
                      boxShadow: "0 0 24px oklch(0.6 0.22 25 / 0.2)",
                    }}>
                    Cancel Subscription
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={() => !cancelling && setShowCancelModal(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-zinc-900">Cancel your subscription?</h2>
            <p className="mt-2 text-sm text-zinc-600">
              You&apos;ll keep access to your current plan until
              {expiresAt ? <> <span className="font-semibold text-zinc-900">{formatDate(expiresAt)}</span></> : <> the end of your current billing period</>}.
              After that, your plan will end and you can re-subscribe any time.
            </p>
            {cancelError && (
              <p className="mt-3 text-sm font-medium" style={{ color: "oklch(0.6 0.22 25)" }}>{cancelError}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowCancelModal(false)}
                disabled={cancelling}
                className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                Keep Plan
              </button>
              <button
                onClick={handleCancelSubscription}
                disabled={cancelling}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-60 flex items-center gap-2"
                style={{ background: "oklch(0.6 0.22 25)" }}
              >
                {cancelling && (
                  <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                )}
                {cancelling ? "Cancelling…" : "Cancel Subscription"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <SubscriptionModal
          email={userEmail}
          defaultPlan={planData?.plan === "starter" ? "pro" : undefined}
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
