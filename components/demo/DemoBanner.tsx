"use client";

import { useState, useEffect, Fragment } from "react";
import { useRouter } from "next/navigation";
import { Settings, LogOut, Check } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useDemoState } from "@/lib/demo-context";
import { DEMO_STEPS } from "@/components/demo/DemoNav";
import { SubscriptionModal } from "@/components/SubscriptionModal";

export function DemoBanner() {
  const router = useRouter();
  const [showMenu, setShowMenu] = useState(false);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const { currentStep, setDrawerOpen, setDrawerHighlightStep } = useDemoState();

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email) setUserEmail(data.user.email);
    });
  }, []);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  const onWorkflowPage = currentStep >= 0;

  return (
    <>
      {/*
        Spacer so page content clears the fixed mobile elements.
        Workflow pages: nav (56) + banner (37) + stepper (57) = 150px.
        Other pages (dashboard): just nav (56px).
      */}
      <div className={`md:hidden shrink-0 ${onWorkflowPage ? "h-[142px]" : "h-14"}`} />

      {/*
        On mobile workflow pages this entire block is fixed below the nav.
        On desktop it stays in-flow (the sidebar handles navigation).
      */}
      <div
        className={
          onWorkflowPage
            ? "fixed top-14 inset-x-0 z-[190] md:static md:top-auto md:inset-x-auto md:z-auto shrink-0"
            : "shrink-0"
        }
      >
        {/* ── Demo mode banner bar ──────────────────────────────────── */}
        <div
          className="flex items-center justify-between px-4 sm:px-6 py-2.5 text-xs"
          style={{
            background: "oklch(0.22 0.08 285)",
            borderBottom: "1px solid oklch(0.72 0.25 285 / 0.35)",
            color: "oklch(0.82 0.04 285)",
          }}
        >
          <span className="hidden sm:inline">✨ You&apos;re viewing a demo — subscribe to run this on your own channel.</span>
          <span className="sm:hidden">✨ Demo mode</span>

          <div className="flex items-center gap-3 shrink-0 ml-4">
            <button
              onClick={() => setShowSubscriptionModal(true)}
              className="px-3 py-1 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
              style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.06 0 0)" }}
            >
              Subscribe Now →
            </button>

            <button
              onClick={() => router.push("/dashboard")}
              className="hidden sm:block px-3 py-1 rounded-lg text-xs font-medium transition-all hover:opacity-80"
              style={{ background: "var(--bg-control)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Dashboard
            </button>

            {/* Theme + profile: desktop only — mobile top bar owns these */}
            <span className="hidden sm:inline-flex"><ThemeToggle /></span>

            <div className="relative hidden sm:block">
              <button
                onClick={() => setShowMenu((v) => !v)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
                style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
              >
                {userEmail ? userEmail[0].toUpperCase() : "?"}
              </button>

              {showMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                  <div
                    className="absolute right-0 top-9 z-50 w-56 rounded-2xl py-3 shadow-2xl"
                    style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}
                  >
                    <div className="px-4 pb-3" style={{ borderBottom: "1px solid oklch(1 0 0 / 0.07)" }}>
                      <p className="text-xs font-semibold truncate" style={{ color: "var(--c-88)" }}>
                        {userEmail || "Loading…"}
                      </p>
                      <span
                        className="mt-1.5 inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full"
                        style={{
                          background: "oklch(0.72 0.25 285 / 0.15)",
                          color: "oklch(0.72 0.25 285)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.25)",
                        }}
                      >
                        Free plan
                      </span>
                    </div>
                    <div className="px-2 pt-2">
                      <button
                        onClick={() => { setShowMenu(false); router.push("/setup"); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                        style={{ color: "var(--c-60)" }}
                      >
                        <Settings size={13} />
                        <span>Setup</span>
                      </button>
                      <button
                        onClick={() => { setShowMenu(false); handleSignOut(); }}
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
        </div>

        {/* ── Step dots with labels — mobile only, workflow pages only ── */}
        {onWorkflowPage && (
          <div
            className="md:hidden py-[10px]"
            style={{ background: "var(--bg-nav)", borderBottom: "1px solid var(--bd-6)" }}
          >
            {/* Circles + connecting lines */}
            <div className="flex items-center px-4">
              {DEMO_STEPS.map((step, i) => {
                const isDone = i < currentStep;
                const isActive = i === currentStep;
                return (
                  <Fragment key={step.label}>
                    <button
                      onClick={() => { setDrawerHighlightStep(i); setDrawerOpen(true); }}
                      className="w-4 h-4 rounded-full shrink-0 flex items-center justify-center transition-all focus:outline-none"
                      style={
                        isDone
                          ? { background: "oklch(0.55 0.15 145)" }
                          : isActive
                          ? { background: "oklch(0.72 0.25 285)", boxShadow: "0 0 6px oklch(0.72 0.25 285 / 0.6)" }
                          : { background: "transparent", border: "1.5px solid var(--bd-8)" }
                      }
                    >
                      {isDone && <Check size={8} strokeWidth={3} color="white" />}
                    </button>
                    {i < DEMO_STEPS.length - 1 && (
                      <div
                        className="flex-1 h-px mx-0.5 transition-all"
                        style={{ background: isDone ? "oklch(0.55 0.15 145 / 0.4)" : "var(--bd-6)" }}
                      />
                    )}
                  </Fragment>
                );
              })}
            </div>

            {/* Labels — mirror the circles row so each label sits under its circle */}
            <div className="flex items-start px-4 pt-1 pb-2">
              {DEMO_STEPS.map((step, i) => {
                const isDone = i < currentStep;
                const isActive = i === currentStep;
                return (
                  <Fragment key={step.label}>
                    <div className="w-4 shrink-0 relative flex justify-center">
                      <span
                        className="absolute text-[7px] leading-none whitespace-nowrap"
                        style={{
                          color: isActive
                            ? "oklch(0.72 0.25 285)"
                            : isDone
                            ? "oklch(0.55 0.15 145)"
                            : "var(--c-35)",
                          transform: "translateX(-50%)",
                          left: "50%",
                        }}
                      >
                        {step.label}
                      </span>
                    </div>
                    {i < DEMO_STEPS.length - 1 && <div className="flex-1" />}
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {showSubscriptionModal && (
        <SubscriptionModal
          email={userEmail}
          onClose={() => setShowSubscriptionModal(false)}
          onSuccess={() => { setShowSubscriptionModal(false); router.push("/dashboard"); }}
          hideTryDemo
        />
      )}
    </>
  );
}
