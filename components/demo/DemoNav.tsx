"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { Tv, Lightbulb, ScrollText, Clapperboard, CheckCircle2, Check, LayoutDashboard } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const STEPS: { label: string; sublabel: string; Icon: LucideIcon }[] = [
  { label: "Channel", sublabel: "Analysis & Style", Icon: Tv },
  { label: "Topic", sublabel: "Video Idea", Icon: Lightbulb },
  { label: "Script", sublabel: "Generate & Edit", Icon: ScrollText },
  { label: "Generate", sublabel: "Assets & Export", Icon: Clapperboard },
  { label: "Done", sublabel: "Subscribe to Start", Icon: CheckCircle2 },
];

interface DemoNavProps {
  currentStep: number;
}

export function DemoNav({ currentStep }: DemoNavProps) {
  const router = useRouter();
  const progressPct = Math.round((currentStep / 4) * 100);

  return (
    <>
      <button
        onClick={() => router.push("/dashboard")}
        className="fixed top-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all hover:opacity-80"
        style={{ background: "var(--bg-control)", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
      >
        <LayoutDashboard size={13} />
        Back to Dashboard
      </button>

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
            const isDone = i < currentStep;

            return (
              <div key={step.label}>
                <div
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left"
                  style={
                    isActive
                      ? {
                          background: "oklch(0.72 0.25 285 / 0.12)",
                          boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.25)",
                        }
                      : {}
                  }
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
                background: "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                boxShadow: "0 0 8px oklch(0.72 0.25 285 / 0.5)",
              }}
            />
          </div>
        </div>
      </aside>
    </>
  );
}
