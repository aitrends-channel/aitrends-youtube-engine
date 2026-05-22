"use client";

import { useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Tv, Lightbulb, ScrollText, ImageIcon, Wand2, Clapperboard, Film, LayoutTemplate, Check } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useDemoState } from "@/lib/demo-context";

const STEPS: { label: string; sublabel: string; Icon: LucideIcon; href: string }[] = [
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
  const { state, update } = useDemoState();
  const highestStep = state.highestStep;

  useEffect(() => {
    if (currentStep > highestStep) {
      update({ highestStep: currentStep });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep]);

  const progressPct = Math.min(Math.round(((highestStep + 1) / 8) * 100), 100);

  return (
    <>
      <aside
        className="w-64 shrink-0 flex flex-col h-screen sticky top-0 overflow-hidden"
        style={{ background: "var(--bg-nav)", borderRight: "1px solid var(--bd-7)" }}
      >
        {/* Logo */}
        <div className="px-5 py-5 border-b" style={{ borderColor: "var(--bd-7)" }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center">
              <Image src="/heclus-icon-white.svg" alt="Heclus" width={40} height={40} className="object-cover w-full h-full" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-foreground/90 leading-tight">Heclus</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span
                  className="text-xs font-semibold px-1.5 py-0.5 rounded"
                  style={{
                    background: "oklch(0.72 0.25 285 / 0.15)",
                    border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                    color: "oklch(0.72 0.25 285)",
                  }}
                >
                  Demo
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Steps */}
        <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto">
          {STEPS.map((step, i) => {
            const isActive = i === currentStep;
            const isDone = !isActive && i <= highestStep;
            const isClickable = i <= highestStep;

            return (
              <div key={step.label}>
                <div
                  role={isClickable ? "button" : undefined}
                  onClick={isClickable ? () => router.push(step.href) : undefined}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-opacity"
                  style={{
                    cursor: isClickable ? "pointer" : "default",
                    ...(isActive
                      ? {
                          background: "oklch(0.72 0.25 285 / 0.12)",
                          boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.25)",
                        }
                      : isDone
                      ? { opacity: 0.75 }
                      : {}),
                  }}
                >
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-all"
                    style={
                      isActive
                        ? {
                            background: "oklch(0.72 0.25 285)",
                            color: "oklch(0.06 0 0)",
                            boxShadow: "0 0 14px oklch(0.72 0.25 285 / 0.5)",
                          }
                        : isDone
                        ? {
                            background: "oklch(0.55 0.15 145)",
                            color: "white",
                          }
                        : {
                            background: "var(--bg-step-idle)",
                            color: "var(--c-38)",
                          }
                    }
                  >
                    {isDone ? <Check size={16} strokeWidth={2.5} /> : <step.Icon size={16} strokeWidth={1.75} />}
                  </div>

                  <div className="min-w-0">
                    <p
                      className="text-sm font-semibold leading-tight"
                      style={{
                        color: isActive
                          ? "var(--c-90)"
                          : isDone
                          ? "var(--c-65)"
                          : "oklch(0.95 0 0 / 0.25)",
                      }}
                    >
                      {step.label}
                    </p>
                    <p
                      className="text-xs leading-tight mt-0.5"
                      style={{ color: isActive ? "var(--c-50)" : "oklch(0.95 0 0 / 0.25)" }}
                    >
                      {step.sublabel}
                    </p>
                  </div>
                </div>

                {i < STEPS.length - 1 && (
                  <div className="flex justify-center my-0.5">
                    <div
                      className="w-px h-4 rounded-full transition-all"
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

      </aside>
    </>
  );
}
