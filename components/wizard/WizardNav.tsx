"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Image from "next/image";
import {
  Tv, Lightbulb, ScrollText, ImageIcon, Wand2, Clapperboard, Film,
  Check, ZoomIn, ZoomOut, LayoutTemplate, LayoutDashboard,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIconThemeStore } from "@/store/iconThemeStore";
import { ICON_THEMES, THEME_ORDER, type ThemeId, type PhaseKey } from "@/lib/iconThemes";
import { ThemeToggle } from "@/components/ThemeToggle";

const PHASES: { id: PhaseKey; label: string; sublabel: string; path: string; states: number[]; navigableFrom?: number }[] = [
  { id: "channel",    label: "Channel",    sublabel: "Analysis & Style",    path: "channel",    states: [1, 2, 3, 4, 5] },
  { id: "topic",      label: "Topic",      sublabel: "Video Idea",           path: "topic",      states: [6] },
  { id: "script",     label: "Script",     sublabel: "Generate & Edit",     path: "script",     states: [6], navigableFrom: 6 },
  { id: "visuals",    label: "Visuals",    sublabel: "Style Extraction",    path: "visuals",    states: [7, 8, 11, 12], navigableFrom: 6 },
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
}

export function WizardNav({ projectId, currentState, highestState, channelName, activeOverridePath, progressComplete }: WizardNavProps) {
  const reached = highestState ?? currentState;
  const router = useRouter();
  const pathname = usePathname();
  const { themeId, setTheme, zoom, zoomIn, zoomOut } = useIconThemeStore();
  const [showThemePicker, setShowThemePicker] = useState(false);

  const theme = ICON_THEMES[themeId];
  const effectivePath = activeOverridePath ? `/${activeOverridePath}` : pathname;
  const currentPathRank = Object.entries(PATH_RANK).find(([p]) => effectivePath.endsWith(`/${p}`))?.[1] ?? -1;

  function getPhaseStatus(phase: (typeof PHASES)[0]) {
    if (progressComplete && phase.id === "thumbnails") return "done";
    if (effectivePath.endsWith(`/${phase.path}`)) return "active";
    const phaseRank = PATH_RANK[phase.id] ?? 0;
    const min = Math.min(...phase.states);
    if (phaseRank < currentPathRank && reached >= min) return "done";
    return "locked";
  }

  function isNavigable(phase: (typeof PHASES)[0]) {
    if (phase.navigableFrom !== undefined) return reached >= phase.navigableFrom;
    return reached >= Math.min(...phase.states);
  }

  const currentPhaseIndex = PHASES.findIndex((p) => pathname.endsWith(`/${p.path}`));
  const progressPct = progressComplete ? 100 : Math.max(0, Math.round(((currentPhaseIndex + 1) / PHASES.length) * 100));

  return (
    <aside className="w-64 shrink-0 flex flex-col h-screen sticky top-0 overflow-hidden"
      style={{ background: "var(--bg-nav)", borderRight: "1px solid var(--bd-7)" }}>

      {/* Logo */}
      <div className="px-5 py-5 border-b" style={{ borderColor: "var(--bd-7)" }}>
        <button onClick={() => router.push("/")} className="flex items-center gap-3 group w-full">
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

      {/* Dashboard link */}
      <div className="px-3 py-2 border-b" style={{ borderColor: "var(--bd-7)" }}>
        <button
          onClick={() => router.push("/dashboard")}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-all hover:bg-white/5"
          style={{ color: "var(--c-45)" }}
        >
          <LayoutDashboard size={14} />
          Go to Dashboard
        </button>
      </div>

      {/* Steps */}
      <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto">
        {PHASES.map((phase, i) => {
          const status = getPhaseStatus(phase);
          const navigable = isNavigable(phase);
          const isActive = status === "active";
          const isDone = status === "done";
          const Icon = PHASE_ICONS[phase.id];

          return (
            <div key={phase.id}>
              <button
                onClick={() => navigable && router.push(`/projects/${projectId}/${phase.path}`)}
                disabled={!navigable}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-all duration-200",
                  isDone && "cursor-pointer hover:bg-white/5",
                  !isActive && !isDone && navigable && "cursor-pointer hover:bg-white/5",
                  !navigable && "cursor-not-allowed",
                )}
                style={isActive ? {
                  background: "oklch(0.72 0.25 285 / 0.12)",
                  boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.25)",
                } : {}}
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-all"
                  style={
                    isActive ? {
                      background: "oklch(0.72 0.25 285)",
                      color: "oklch(0.06 0 0)",
                      boxShadow: "0 0 14px oklch(0.72 0.25 285 / 0.5)",
                    } : isDone ? {
                      background: "oklch(0.55 0.15 145)",
                      color: "white",
                    } : {
                      background: "var(--bg-step-idle)",
                      color: "var(--c-38)",
                    }
                  }
                >
                  {isDone ? <Check size={16} strokeWidth={2.5} /> : <Icon size={16} strokeWidth={1.75} />}
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

      {/* Progress bar */}
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

      {/* Zoom + Theme controls */}
      <div className="px-4 pb-3" style={{ borderTop: "1px solid var(--bd-7)" }}>
        <div className="flex items-center gap-2 mt-3">
          <div className="flex-1 flex items-center justify-between px-3 py-2.5 rounded-xl"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            <div className="flex items-center gap-2">
              <ZoomIn size={13} style={{ color: "var(--c-45)" }} />
              <span className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Zoom</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={zoomOut}
                disabled={zoom <= 80}
                className="w-6 h-6 flex items-center justify-center rounded-md text-sm font-bold transition-all disabled:opacity-30 hover:bg-white/10"
                style={{ color: "var(--c-60)" }}
              >
                <ZoomOut size={13} />
              </button>
              <span className="text-xs font-mono w-9 text-center" style={{ color: "oklch(0.72 0.25 285)" }}>
                {zoom}%
              </span>
              <button
                onClick={zoomIn}
                disabled={zoom >= 125}
                className="w-6 h-6 flex items-center justify-center rounded-md text-sm font-bold transition-all disabled:opacity-30 hover:bg-white/10"
                style={{ color: "var(--c-60)" }}
              >
                <ZoomIn size={13} />
              </button>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </div>

      {/* Icon theme picker */}
      <div className="px-4 pb-4 pt-2">
        <button
          onClick={() => setShowThemePicker(!showThemePicker)}
          className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all"
          style={{
            background: showThemePicker ? "oklch(0.72 0.25 285 / 0.08)" : "var(--bg-panel)",
            border: `1px solid ${showThemePicker ? "oklch(0.72 0.25 285 / 0.2)" : "var(--bd-7)"}`,
          }}
        >
          <div className="flex items-center gap-2">
            <span className="text-base" style={{ color: "oklch(0.72 0.25 285)" }}>
              {theme.doneIcon}
            </span>
            <span className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
              {theme.name} Style
            </span>
          </div>
          <span className="text-xs" style={{ color: "var(--c-35)" }}>
            {showThemePicker ? "▲" : "▼"}
          </span>
        </button>

        {showThemePicker && (
          <div className="mt-2 space-y-1">
            {THEME_ORDER.map((id) => {
              const t = ICON_THEMES[id];
              const isSelected = themeId === id;
              return (
                <button
                  key={id}
                  onClick={() => { setTheme(id as ThemeId); setShowThemePicker(false); }}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl transition-all"
                  style={isSelected ? {
                    background: "oklch(0.72 0.25 285 / 0.1)",
                    border: "1px solid oklch(0.72 0.25 285 / 0.25)",
                  } : {
                    background: "var(--bg-panel)",
                    border: "1px solid var(--bd-6)",
                  }}
                >
                  <span className="text-xs font-medium"
                    style={{ color: isSelected ? "oklch(0.72 0.25 285)" : "var(--c-50)" }}>
                    {t.name}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm" style={{ color: isSelected ? "oklch(0.72 0.25 285)" : "var(--c-40)" }}>
                      {t.doneIcon}
                    </span>
                    <span className="text-xs font-mono" style={{ color: isSelected ? "oklch(0.5 0.1 285)" : "var(--c-30)" }}>
                      done
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
