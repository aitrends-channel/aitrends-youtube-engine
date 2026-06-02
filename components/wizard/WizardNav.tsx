"use client";

import { useState, useEffect, useRef, Fragment } from "react";
import { useRouter, usePathname } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  Tv, Lightbulb, ScrollText, ImageIcon, Wand2, Clapperboard, Film,
  Check, CheckCircle2, LayoutTemplate, ArrowLeft, X, Settings, LogOut,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIconThemeStore } from "@/store/iconThemeStore";
import { type PhaseKey } from "@/lib/iconThemes";
import { ThemeToggle } from "@/components/ThemeToggle";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const PHASES: { id: PhaseKey; label: string; sublabel: string; path: string; states: number[]; navigableFrom?: number }[] = [
  { id: "channel",    label: "Channel",    sublabel: "Analysis & Style",    path: "channel",    states: [1, 2, 3, 4, 5] },
  { id: "topic",      label: "Topic",      sublabel: "Video Idea",           path: "topic",      states: [6] },
  { id: "script",     label: "Script",     sublabel: "Generate & Edit",     path: "script",     states: [6], navigableFrom: 7 },
  { id: "visuals",    label: "Visuals",    sublabel: "Style Extraction",    path: "visuals",    states: [7, 8, 11, 12], navigableFrom: 7 },
  { id: "prompts",    label: "Prompts",    sublabel: "Image & Video Beats", path: "prompts",    states: [9, 10] },
  { id: "generate",   label: "Generate",   sublabel: "Assets & Export",     path: "generate",   states: [14] },
  { id: "assemble",   label: "Assemble",   sublabel: "Final Video",         path: "assemble",   states: [15], navigableFrom: 14 },
  { id: "thumbnails", label: "Thumbnails", sublabel: "Concepts & Images",   path: "thumbnails", states: [13], navigableFrom: 9 },
];

const PHASE_ICONS: Record<PhaseKey, LucideIcon> = {
  channel:    Tv,
  topic:      Lightbulb,
  script:     ScrollText,
  visuals:    ImageIcon,
  prompts:    Wand2,
  thumbnails: LayoutTemplate,
  generate:   Clapperboard,
  assemble:   Film,
};

const PATH_RANK: Record<string, number> = {
  channel: 0, topic: 1, script: 2, visuals: 3, prompts: 4, generate: 5, assemble: 6, thumbnails: 7,
};

interface WizardNavProps {
  projectId: string;
  currentState: number;
  highestState?: number;
  channelName?: string;
  activeOverridePath?: string;
  progressComplete?: boolean;
  topRightExtra?: React.ReactNode;
}

export function WizardNav({ projectId, currentState, highestState, channelName, activeOverridePath, progressComplete, topRightExtra }: WizardNavProps) {
  const reached = highestState ?? currentState;
  const router = useRouter();
  const pathname = usePathname();
  const { zoom } = useIconThemeStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerHighlightPhase, setDrawerHighlightPhase] = useState(-1);
  const [userEmail, setUserEmail] = useState("");
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email) setUserEmail(data.user.email);
    });
  }, []);

  // Apply zoom only on desktop — never touch document.documentElement.style.zoom on touch
  // devices as it disrupts iOS Safari's viewport scale calculation.
  useEffect(() => {
    const isTouch = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
    if (isTouch) return;
    document.documentElement.style.zoom = `${zoom / 100}`;
    return () => { document.documentElement.style.zoom = ""; };
  }, [zoom]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  const effectivePath = activeOverridePath ? `/${activeOverridePath}` : pathname;
  const currentPathRank = Object.entries(PATH_RANK).find(([p]) => effectivePath.endsWith(`/${p}`))?.[1] ?? -1;

  function getPhaseStatus(phase: (typeof PHASES)[0]) {
    if (progressComplete && phase.id === "thumbnails") return "done";
    if (effectivePath.endsWith(`/${phase.path}`)) return "active";
    // Thumbnails is a side-branch — only mark done via progressComplete above
    if (phase.id === "thumbnails") return "locked";
    // A phase is visually "done" only when project state has moved past it
    if (reached > Math.max(...phase.states)) return "done";
    return "locked";
  }

  function isNavigable(phase: (typeof PHASES)[0]) {
    const phaseRank = PATH_RANK[phase.id] ?? 0;
    const effectiveMin = phase.navigableFrom !== undefined ? phase.navigableFrom : Math.min(...phase.states);
    // Going backward or staying: navigable if you've reached the phase's start state
    if (phaseRank <= currentPathRank) return reached >= Math.min(...phase.states);
    // Going forward: only if the project has reached the navigableFrom threshold
    return reached >= effectiveMin;
  }

  const currentPhaseIndex = PHASES.findIndex((p) => pathname.endsWith(`/${p.path}`));
  // Cap at 99% until progressComplete signals everything is truly done.
  // Thumbnails is the final phase (index 7 of 8) so the raw fraction would
  // be 100% the moment the user lands on the page — even before any
  // thumbnails have generated. Hold at 99 until the parent confirms.
  const progressPct = progressComplete
    ? 100
    : Math.min(99, Math.max(0, Math.round(((currentPhaseIndex + 1) / PHASES.length) * 100)));

  function navigate(href: string) {
    setDrawerOpen(false);
    router.push(href);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    setDrawerHighlightPhase(-1);
  }

  const stepList = (
    <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto">
      {PHASES.map((phase, i) => {
        const status = getPhaseStatus(phase);
        const navigable = isNavigable(phase);
        const isActive = status === "active";
        const isDone = status === "done";
        const isHighlighted = i === drawerHighlightPhase && drawerHighlightPhase >= 0;
        const Icon = PHASE_ICONS[phase.id];

        return (
          <div key={phase.id}>
            <button
              onClick={() => navigable && navigate(`/projects/${projectId}/${phase.path}`)}
              disabled={!navigable}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-all duration-200",
                isDone && "cursor-pointer hover:bg-white/5",
                !isActive && !isDone && navigable && "cursor-pointer hover:bg-white/5",
                !navigable && "cursor-not-allowed",
              )}
              style={{
                ...(isActive ? {
                  background: "oklch(0.72 0.25 285 / 0.12)",
                  boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.25)",
                } : {}),
                ...(isHighlighted && !isActive ? {
                  boxShadow: "inset 0 0 0 1.5px oklch(0.72 0.25 285 / 0.55)",
                } : {}),
              }}
            >
              <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-all"
                style={
                  isActive ? {
                    background: "oklch(0.72 0.25 285)",
                    color: "oklch(0.06 0 0)",
                    boxShadow: "0 0 14px oklch(0.72 0.25 285 / 0.5)",
                  } : isDone ? {
                    background: "transparent",
                    color: "oklch(0.55 0.15 145)",
                  } : {
                    background: "var(--bg-step-idle)",
                    color: "var(--c-38)",
                  }
                }
              >
                {isDone ? <CheckCircle2 size={18} strokeWidth={2} /> : <Icon size={16} strokeWidth={1.75} />}
              </div>

              <div className="min-w-0">
                <p className={cn("text-sm font-semibold leading-tight",
                  isActive && "text-foreground",
                  isDone && "text-foreground/65",
                  status === "locked" && "text-foreground/25",
                )}>
                  {phase.label}
                </p>
                <p className={cn("text-xs leading-tight mt-0.5",
                  isActive ? "text-foreground/50" : "text-foreground/25",
                )}>
                  {phase.sublabel}
                </p>
              </div>
            </button>

            {i < PHASES.length - 1 && (
              <div className="flex justify-center my-0.5">
                <div className="w-px h-4 rounded-full transition-all"
                  style={{
                    background: isDone
                      ? "oklch(0.55 0.15 145 / 0.5)"
                      : isActive
                      ? "oklch(0.72 0.25 285 / 0.35)"
                      : "var(--c-22)"
                  }} />
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );

  const progressFooter = (
    <>
      <div className="px-5 py-4 border-t" style={{ borderColor: "var(--bd-7)" }}>
        <div className="flex justify-between text-xs mb-2" style={{ color: "var(--c-45)" }}>
          <span>Progress</span>
          <span>{progressPct}%</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${progressPct}%`,
              background: "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
              boxShadow: "0 0 8px oklch(0.72 0.25 285 / 0.5)",
            }}
          />
        </div>
      </div>



    </>
  );

  return (
    <>
      {/* ── Desktop top-right: Back to Dashboard + Profile ──────────── */}
      <div className="hidden md:flex fixed top-4 right-4 z-50 items-center gap-2">
        {topRightExtra}
        <button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
          style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
        >
          <ArrowLeft size={13} />
          Back
        </button>

        <ThemeToggle />

        {/* Profile avatar + dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowProfileMenu((v) => !v)}
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
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
                </div>
                <div className="px-2 pt-2">
                  <button
                    onClick={() => { setShowProfileMenu(false); navigate("/setup"); }}
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

      {/* ── Mobile top bar + step dots (fixed) ──────────────────────── */}
      <div
        className="md:hidden fixed top-0 inset-x-0 z-[200] flex flex-col shrink-0"
        style={{ background: "var(--bg-nav)", borderBottom: "1px solid var(--bd-7)" }}
      >
        {/* Logo row */}
        <div className="h-14 flex items-center justify-between px-4">
          <button onClick={() => router.push("/dashboard")} className="flex items-center gap-2">
            <div className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center">
              <Image src="/heclus-icon-white.svg" alt="Heclus" width={28} height={28} className="object-cover w-full h-full" />
            </div>
            <span className="text-sm font-bold" style={{ color: "var(--c-90)" }}>Heclus</span>
          </button>

          <div className="flex items-center gap-2">
            {topRightExtra}
            <button
              onClick={() => router.push("/dashboard")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
              style={{ color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
            >
              <ArrowLeft size={13} />
              Back
            </button>
            <ThemeToggle />

            {/* Profile avatar + dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowProfileMenu((v) => !v)}
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
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
                    </div>
                    <div className="px-2 pt-2">
                      <button
                        onClick={() => { setShowProfileMenu(false); router.push("/setup"); }}
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

        {/* Step dots + labels row */}
        <div
          className="py-[10px]"
          style={{ borderTop: "1px solid var(--bd-6)" }}
        >
          {/* Circles + connecting lines */}
          <div className="flex items-center px-4">
            {PHASES.map((phase, i) => {
              const status = getPhaseStatus(phase);
              const isDone = status === "done";
              const isActive = status === "active";
              return (
                <Fragment key={phase.id}>
                  <button
                    onClick={() => { setDrawerHighlightPhase(i); setDrawerOpen(true); }}
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
                  {i < PHASES.length - 1 && (
                    <div
                      className="flex-1 h-px mx-0.5 transition-all"
                      style={{ background: isDone ? "oklch(0.55 0.15 145 / 0.4)" : "var(--bd-6)" }}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>

          {/* Labels — mirror the circles row */}
          <div className="flex items-start px-4 pt-1 pb-2">
            {PHASES.map((phase, i) => {
              const status = getPhaseStatus(phase);
              const isDone = status === "done";
              const isActive = status === "active";
              return (
                <Fragment key={phase.id}>
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
                      {phase.label}
                    </span>
                  </div>
                  {i < PHASES.length - 1 && <div className="flex-1" />}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Mobile drawer ───────────────────────────────────────────── */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-[300]">
          <div className="absolute inset-0 bg-black/60" onClick={closeDrawer} />
          <div
            className="absolute top-0 left-0 bottom-0 w-72 flex flex-col"
            style={{ background: "var(--bg-nav)", borderRight: "1px solid var(--bd-7)" }}
          >
            <div className="px-5 py-5 flex items-center justify-between border-b" style={{ borderColor: "var(--bd-7)" }}>
              <Link href="/dashboard" className="flex items-center gap-3 transition-opacity hover:opacity-80">
                <div className="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center">
                  <Image src="/heclus-icon-white.svg" alt="Heclus" width={36} height={36} className="object-cover w-full h-full" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold leading-tight" style={{ color: "var(--c-90)" }}>Heclus</p>
                  {channelName && (
                    <p className="text-xs leading-tight mt-0.5 truncate max-w-[140px]" style={{ color: "var(--c-45)" }}>
                      {channelName}
                    </p>
                  )}
                </div>
              </Link>
              <button
                onClick={closeDrawer}
                className="p-1.5 rounded-lg transition-all hover:opacity-80 shrink-0"
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
      <aside className="hidden md:flex w-64 shrink-0 flex-col h-screen sticky top-0 overflow-hidden"
        style={{ background: "var(--bg-nav)", borderRight: "1px solid var(--bd-7)" }}>

        <div className="px-5 py-5 border-b" style={{ borderColor: "var(--bd-7)" }}>
          <button onClick={() => router.push("/dashboard")} className="flex items-center gap-3 group w-full">
            <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center">
              <Image src="/heclus-icon-white.svg" alt="Heclus" width={40} height={40} className="object-cover w-full h-full" />
            </div>
            <div className="min-w-0 text-left">
              <p className="text-sm font-bold text-foreground/90 group-hover:text-foreground transition-colors leading-tight">
                Heclus
              </p>
              <p className="text-xs leading-tight mt-0.5" style={{ color: "var(--c-45)" }}>
                {channelName ? (
                  <span className="truncate block max-w-[140px]">{channelName}</span>
                ) : "Heclus"}
              </p>
            </div>
          </button>
        </div>

        {stepList}
        {progressFooter}
      </aside>
    </>
  );
}
