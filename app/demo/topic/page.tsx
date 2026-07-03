"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DemoStepCostCard } from "@/components/demo/DemoStepCostCard";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

export default function DemoTopicPage() {
  const router = useRouter();
  const { state, update } = useDemoState();
  const selectedTopic = state.selectedTopic;
  const [navigating, setNavigating] = useState(false);
  const isTopicLocked = !!(selectedTopic && state.scriptPhase === "done");

  function handleContinue() {
    if (!selectedTopic) return;
    setNavigating(true);
    setTimeout(() => router.push("/demo/script"), 500);
  }

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={1} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 overflow-y-auto">
        <div
          className="py-4 sm:py-5"
          style={{
            borderBottom: "1px solid var(--bd-6)",
            background: "var(--bg-header-2)",
            backdropFilter: "blur(12px)",
          }}
        >
          <h1 className="font-bold text-lg">Choose Your Topic</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
            {isTopicLocked ? "Topic is locked — already used in script generation" : "Select a video idea generated for AncientHeclus"}
          </p>
          <div className="mt-3">
            <DemoStepCostCard column="topic" />
          </div>
        </div>

        <div className="pt-6 pb-24 space-y-5">

          {isTopicLocked ? (
            <>
              <div className="rounded-2xl p-5 space-y-3"
                style={{ background: "var(--bg-panel)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
                    Selected Topic
                  </p>
                  <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full"
                    style={{ background: "oklch(0.55 0.15 145 / 0.12)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }}>
                    <Lock size={10} strokeWidth={2.5} />
                    Locked
                  </span>
                </div>
                <p className="text-base font-semibold leading-snug" style={{ color: "var(--c-90)" }}>
                  {selectedTopic}
                </p>
                <p className="text-xs" style={{ color: "var(--c-40)" }}>
                  This topic has been used in script generation and cannot be changed.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                {DEMO_DATA.videoIdeas.map((idea, i) => {
                  const locked = i > 0;
                  const selected = selectedTopic === idea;
                  return (
                    <button
                      key={i}
                      onClick={() => !locked && update({ selectedTopic: idea })}
                      disabled={locked}
                      className="w-full text-left p-4 rounded-xl transition-all"
                      style={
                        selected
                          ? { background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.35)" }
                          : locked
                          ? { background: "var(--bg-panel)", border: "1px solid var(--bd-7)", opacity: 0.35, cursor: "not-allowed" }
                          : { background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }
                      }
                      onMouseEnter={(e) => {
                        if (!locked && !selected)
                          (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.2)";
                      }}
                      onMouseLeave={(e) => {
                        if (!locked && !selected)
                          (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-7)";
                      }}
                    >
                      <div className="flex items-start gap-3">
                        {selected ? (
                          <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center"
                            style={{ background: "oklch(0.55 0.15 145)", color: "var(--bg-page-2)" }}>
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                              <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                        ) : (
                          <span
                            className="text-xs font-mono mt-0.5 shrink-0"
                            style={{
                              color: locked ? "var(--c-35)" : "oklch(0.72 0.25 285)",
                              background: locked ? "var(--bg-track)" : "oklch(0.72 0.25 285 / 0.1)",
                              padding: "2px 6px",
                              borderRadius: "4px",
                            }}
                          >
                            {String(i + 1).padStart(2, "0")}
                          </span>
                        )}
                        <span
                          className="text-sm leading-relaxed"
                          style={{ color: selected ? "var(--c-90)" : locked ? "var(--c-35)" : "var(--c-65)" }}
                        >
                          {idea}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

            </>
          )}
        </div>
        </main>

        {/* Fixed bottom Continue bar — pinned to the viewport bottom
            (below DemoBanner, beside DemoNav on desktop) so the action
            is always visible regardless of how far the user has
            scrolled. Mirrors the real workflow's Continue bar pattern. */}
        <div
          className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}
        >
          <div className="px-4 sm:px-8">
            {isTopicLocked ? (
              <button
                onClick={() => router.push("/demo/script")}
                className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                Go to Script →
              </button>
            ) : (
              <button
                onClick={handleContinue}
                disabled={!selectedTopic || navigating}
                className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                {navigating ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Preparing script…
                  </span>
                ) : "Continue to Script →"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
