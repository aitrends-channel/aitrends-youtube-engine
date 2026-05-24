"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Tv, Lightbulb, ScrollText, ImageIcon, Wand2, Clapperboard, Film, LayoutTemplate, Check, RotateCcw, X, Settings, LogOut } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useDemoState } from "@/lib/demo-context";
import { ThemeToggle } from "@/components/ThemeToggle";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export const DEMO_STEPS: { label: string; sublabel: string; Icon: LucideIcon; href: string }[] = [
  { label: "Channel",    sublabel: "Analysis & Style",    Icon: Tv,             href: "/demo/channel" },
  { label: "Topic",      sublabel: "Video Idea",           Icon: Lightbulb,      href: "/demo/topic" },
  { label: "Script",     sublabel: "Generate & Edit",      Icon: ScrollText,     href: "/demo/script" },
  { label: "Visuals",    sublabel: "Style Extraction",     Icon: ImageIcon,      href: "/demo/visuals" },
  { label: "Prompts",    sublabel: "Image & Video Beats",  Icon: Wand2,          href: "/demo/prompts" },
  { label: "Generate",   sublabel: "Assets & Export",      Icon: Clapperboard,   href: "/demo/generate" },
  { label: "Assemble",   sublabel: "Final Video",          Icon: Film,           href: "/demo/assemble" },
  { label: "Thumbnails", sublabel: "Concepts & Images",    Icon: LayoutTemplate, href: "/demo/thumbnails" },
];

interface DemoNavProps {
  currentStep: number;
}

export function DemoNav({ currentStep }: DemoNavProps) {
  const router = useRouter();
  const { state, update, resetDemo, drawerOpen, setDrawerOpen, setCurrentStep, drawerHighlightStep, setDrawerHighlightStep } = useDemoState();
  const highestStep = state.highestStep;
  const [confirming, setConfirming] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email) setUserEmail(data.user.email);
    });
  }, []);

  useEffect(() => {
    setCurrentStep(currentStep);
    if (currentStep > highestStep) {
      update({ highestStep: currentStep });
    }
    return () => setCurrentStep(-1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  const progressPct = Math.min(Math.round(((highestStep + 1) / 8) * 100), 100);

  function navigateTo(href: string) {
    setDrawerOpen(false);
    router.push(href);
  }

  const stepList = (
    <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto">
      {DEMO_STEPS.map((step, i) => {
        const isActive = i === currentStep;
        const isDone = !isActive && i <= highestStep;
        const isClickable = i <= highestStep;
        const isHighlighted = i === drawerHighlightStep && drawerHighlightStep >= 0;

        return (
          <div key={step.label}>
            <div
              role={isClickable ? "button" : undefined}
              onClick={isClickable ? () => navigateTo(step.href) : undefined}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-opacity"
              style={{
                cursor: isClickable ? "pointer" : "default",
                ...(isActive
                  ? { background: "oklch(0.72 0.25 285 / 0.12)", boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.25)" }
                  : isDone
                  ? { opacity: 0.75 }
                  : {}),
                ...(isHighlighted && !isActive
                  ? { boxShadow: "inset 0 0 0 1.5px oklch(0.72 0.25 285 / 0.55)" }
                  : {}),
              }}
            >
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-all"
                style={
                  isActive
                    ? { background: "oklch(0.72 0.25 285)", color: "oklch(0.06 0 0)", boxShadow: "0 0 14px oklch(0.72 0.25 285 / 0.5)" }
                    : isDone
                    ? { background: "oklch(0.55 0.15 145)", color: "white" }
                    : { background: "var(--bg-step-idle)", color: "var(--c-38)" }
                }
              >
                {isDone ? <Check size={16} strokeWidth={2.5} /> : <step.Icon size={16} strokeWidth={1.75} />}
              </div>

              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight"
                  style={{ color: isActive ? "var(--c-90)" : isDone ? "var(--c-65)" : "oklch(0.95 0 0 / 0.25)" }}>
                  {step.label}
                </p>
                <p className="text-xs leading-tight mt-0.5"
                  style={{ color: isActive ? "var(--c-50)" : "oklch(0.95 0 0 / 0.25)" }}>
                  {step.sublabel}
                </p>
              </div>
            </div>

            {i < DEMO_STEPS.length - 1 && (
              <div className="flex justify-center my-0.5">
                <div className="w-px h-4 rounded-full transition-all"
                  style={{
                    background: isDone
                      ? "oklch(0.55 0.15 145 / 0.5)"
                      : isActive
                      ? "oklch(0.72 0.25 285 / 0.35)"
                      : "var(--c-22)",
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );

  const progressFooter = (
    <div className="px-5 py-4 border-t space-y-3" style={{ borderColor: "var(--bd-7)" }}>
      <div>
        <div className="flex justify-between text-xs mb-2" style={{ color: "var(--c-45)" }}>
          <span>Progress</span>
          <span>{progressPct}%</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${progressPct}%`,
              background: progressPct === 100
                ? "linear-gradient(90deg, oklch(0.6 0.18 145), oklch(0.5 0.2 145))"
                : "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
              boxShadow: progressPct === 100
                ? "0 0 8px oklch(0.6 0.18 145 / 0.5)"
                : "0 0 8px oklch(0.72 0.25 285 / 0.5)",
            }}
          />
        </div>
      </div>

      {confirming ? (
        <div className="flex gap-1.5">
          <button
            onClick={() => setConfirming(false)}
            className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
            style={{ background: "var(--bg-progress)", color: "var(--c-50)", border: "1px solid var(--bd-8)" }}
          >
            Cancel
          </button>
          <button
            onClick={() => { resetDemo(); navigateTo("/demo/channel"); }}
            className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
            style={{ background: "oklch(0.55 0.22 25)", color: "white" }}
          >
            Confirm
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
          style={{ background: "var(--bg-progress)", color: "var(--c-45)", border: "1px solid var(--bd-8)" }}
        >
          <RotateCcw size={11} />
          Reset process
        </button>
      )}
    </div>
  );

  return (
    <>
      {/* ── Mobile top bar (fixed) ──────────────────────────────────── */}
      <div
        className="md:hidden fixed top-0 inset-x-0 z-[200] h-14 flex items-center justify-between px-4 shrink-0"
        style={{ background: "var(--bg-nav)", borderBottom: "1px solid var(--bd-7)" }}
      >
        {/* Brand */}
        <button onClick={() => router.push("/dashboard")} className="flex items-center gap-2">
          <div className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={28} height={28} className="object-cover w-full h-full" />
          </div>
          <span className="text-sm font-bold" style={{ color: "var(--c-90)" }}>Heclus</span>
        </button>

        {/* Right controls */}
        <div className="flex items-center gap-2">
          <ThemeToggle />

          {/* Profile avatar + dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowProfileMenu((v) => !v)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              {userEmail ? userEmail[0].toUpperCase() : "?"}
            </button>

            {showProfileMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
                <div
                  className="absolute right-0 top-10 z-50 w-52 rounded-2xl py-3 shadow-2xl"
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
                      onClick={() => { setShowProfileMenu(false); router.push("/demo/dashboard"); }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                      style={{ color: "var(--c-60)" }}
                    >
                      <Settings size={13} />
                      <span>Setup</span>
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
      </div>

      {/* ── Mobile drawer ───────────────────────────────────────────── */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-[300]">
          <div className="absolute inset-0 bg-black/60" onClick={() => { setDrawerOpen(false); setDrawerHighlightStep(-1); }} />
          <div
            className="absolute top-0 left-0 bottom-0 w-72 flex flex-col"
            style={{ background: "var(--bg-nav)", borderRight: "1px solid var(--bd-7)" }}
          >
            <div className="px-5 py-5 flex items-center justify-between border-b" style={{ borderColor: "var(--bd-7)" }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center">
                  <Image src="/heclus-icon-white.svg" alt="Heclus" width={36} height={36} className="object-cover w-full h-full" />
                </div>
                <div>
                  <p className="text-sm font-bold leading-tight" style={{ color: "var(--c-90)" }}>Heclus</p>
                </div>
              </div>
              <button
                onClick={() => { setDrawerOpen(false); setDrawerHighlightStep(-1); }}
                className="p-1.5 rounded-lg transition-all hover:opacity-80"
                style={{ color: "var(--c-50)", background: "var(--bg-progress)", border: "1px solid var(--bd-8)" }}
              >
                <X size={16} />
              </button>
            </div>
            {stepList}
            {progressFooter}
          </div>
        </div>
      )}

      {/* ── Desktop sidebar ──────────────────────────────────────────── */}
      <aside
        className="hidden md:flex w-64 shrink-0 flex-col h-screen sticky top-0 overflow-hidden"
        style={{ background: "var(--bg-nav)", borderRight: "1px solid var(--bd-7)" }}
      >
        <div className="px-5 py-5 border-b" style={{ borderColor: "var(--bd-7)" }}>
          <button onClick={() => router.push("/dashboard")} className="flex items-center gap-3 group w-full">
            <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center">
              <Image src="/heclus-icon-white.svg" alt="Heclus" width={40} height={40} className="object-cover w-full h-full" />
            </div>
            <div className="min-w-0 text-left">
              <p className="text-sm font-bold text-foreground/90 leading-tight group-hover:text-foreground transition-colors">Heclus</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span
                  className="text-xs font-semibold px-1.5 py-0.5 rounded"
                  style={{ background: "oklch(0.72 0.25 285 / 0.15)", border: "1px solid oklch(0.72 0.25 285 / 0.3)", color: "oklch(0.72 0.25 285)" }}
                >
                  Demo
                </span>
              </div>
            </div>
          </button>
        </div>
        {stepList}
        {progressFooter}
      </aside>
    </>
  );
}
