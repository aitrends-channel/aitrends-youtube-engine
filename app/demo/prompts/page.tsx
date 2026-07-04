"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DemoStepCostCard } from "@/components/demo/DemoStepCostCard";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

type Tab = "image" | "video";

// Demo prompts intentionally don't appear until the user clicks
// Generate (or Regenerate). Mirrors the real workflow where image and
// video prompts are produced by an explicit Claude call — the empty
// landing state makes that pipeline step visible instead of
// pre-populating the beat list as if it ran for free.
const GENERATE_MS = 2200;

export default function DemoPromptsPage() {
  const router = useRouter();
  const { state, update } = useDemoState();
  const [navigating, setNavigating] = useState(false);
  const activeTab = state.promptsTab;
  const setActiveTab = (tab: Tab) => update({ promptsTab: tab });
  const promptsPhase = state.promptsPhase;
  const isGenerating = promptsPhase === "generating";
  const isDone = promptsPhase === "done";

  function generatePrompts() {
    update({ promptsPhase: "generating" });
    setTimeout(() => update({ promptsPhase: "done" }), GENERATE_MS);
  }

  return (
    <div className="flex h-screen overflow-x-hidden" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={4} />
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 overflow-y-auto lg:px-[15px]">
          {/* Header */}
          <div
            className="py-4 sticky top-0 z-10"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}
          >
            <h1 className="font-bold text-lg">Prompt Studio</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              {DEMO_DATA.promptStepBeats.length} beats · image & video prompts
            </p>
            <div className="mt-3">
              <DemoStepCostCard column="prompts" />
            </div>
          </div>

          {/* Step cards — coloring keys off promptsPhase so the user sees
              the steps move from pending (gray) → running (purple) →
              done (green) alongside the Generate button below. */}
          <div className="py-4 space-y-2" style={{ borderBottom: "1px solid var(--bd-6)" }}>
            {[
              { num: 1, title: "Image Prompts", desc: "One AI image prompt per script beat, matched to your channel's visual style", beats: DEMO_DATA.promptStepBeats.length },
              { num: 2, title: "Video Prompts", desc: "Camera movement and motion instructions layered on top of each image beat", beats: DEMO_DATA.promptStepBeats.length },
            ].map(({ num, title, desc, beats }) => {
              const styleByPhase = isDone
                ? { border: "1px solid oklch(0.55 0.15 145 / 0.25)", badgeBg: "oklch(0.55 0.15 145 / 0.2)", badgeColor: "oklch(0.65 0.15 145)", badgeBorder: "oklch(0.55 0.15 145 / 0.4)", icon: "✓" }
                : isGenerating
                  ? { border: "1px solid oklch(0.72 0.25 285 / 0.3)", badgeBg: "oklch(0.72 0.25 285 / 0.15)", badgeColor: "oklch(0.72 0.25 285)", badgeBorder: "oklch(0.72 0.25 285 / 0.4)", icon: "•" }
                  : { border: "1px solid var(--bd-7)", badgeBg: "var(--bg-track)", badgeColor: "var(--c-50)", badgeBorder: "var(--bd-7)", icon: String(num) };
              return (
                <div
                  key={num}
                  className="flex items-center gap-2 sm:gap-4 px-3 sm:px-4 py-3 rounded-xl min-w-0"
                  style={{ background: "var(--bg-panel)", border: styleByPhase.border }}
                >
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
                    style={{ background: styleByPhase.badgeBg, color: styleByPhase.badgeColor, border: `1px solid ${styleByPhase.badgeBorder}` }}
                  >
                    {isGenerating ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> : styleByPhase.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold" style={{ color: "var(--c-80)" }}>{title}</p>
                    <p className="text-xs mt-0.5 truncate" style={{ color: "var(--c-45)" }}>{desc}</p>
                  </div>
                  <span className="text-xs font-medium shrink-0" style={{ color: styleByPhase.badgeColor }}>
                    {isDone ? `${beats} beats` : isGenerating ? "Generating…" : "Pending"}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Idle / generating landing — Generate button replaces the
              tabs+beat list until the user explicitly kicks off the
              run. Once done, swap to the tabs/list and let them
              Regenerate via the button next to the Continue bar. */}
          {!isDone ? (
            <div className="py-12 flex flex-col items-center justify-center gap-4">
              <p className="text-sm text-center max-w-md" style={{ color: "var(--c-50)" }}>
                {isGenerating
                  ? "Reading the script and shaping image + video prompts for every beat…"
                  : "Generate one image prompt and one video motion prompt per script beat — matched to your channel's visual style DNA."}
              </p>
              <button
                onClick={generatePrompts}
                disabled={isGenerating}
                className="px-6 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 transition-all"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                {isGenerating ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Generating prompts…
                  </span>
                ) : "Generate Prompts"}
              </button>
            </div>
          ) : (
            <>
              {/* Tabs */}
              <div className="pt-4 flex gap-1" style={{ borderBottom: "1px solid var(--bd-6)" }}>
                {(["image", "video"] as Tab[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className="px-4 py-2 text-xs font-medium rounded-t-lg transition-all capitalize"
                    style={activeTab === tab ? {
                      background: "oklch(0.72 0.25 285 / 0.08)",
                      color: "oklch(0.72 0.25 285)",
                      borderBottom: "2px solid oklch(0.72 0.25 285)",
                    } : {
                      color: "var(--c-45)",
                    }}
                  >
                    {tab} Prompts
                  </button>
                ))}
              </div>

              {/* Beat list */}
              <div className="pt-5 pb-24 space-y-3">
                {DEMO_DATA.promptStepBeats.map((beat) => (
                  <div
                    key={beat.beat}
                    className="rounded-xl p-4 space-y-2 min-w-0"
                    style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="text-xs font-mono px-1.5 py-0.5 rounded"
                        style={{ background: "oklch(0.72 0.25 285 / 0.1)", color: "oklch(0.72 0.25 285)" }}
                      >
                        Beat {beat.beat}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed break-words" style={{ color: "var(--c-75)" }}>
                      {activeTab === "image" ? beat.imagePrompt : beat.videoPrompt}
                    </p>
                  </div>
                ))}
              </div>
            </>
          )}
        </main>
      </div>

      <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
        style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
        <div className="flex gap-3">
          {isDone && (
            <button
              onClick={generatePrompts}
              disabled={isGenerating || navigating}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all hover:opacity-90 flex items-center justify-center gap-2"
              style={{ background: "var(--bg-progress)", color: "var(--c-70)", border: "1px solid var(--bd-7)" }}
            >
              <RefreshCw size={14} strokeWidth={2.5} />
              Regenerate
            </button>
          )}
          <button
            onClick={() => { setNavigating(true); setTimeout(() => router.push("/demo/voiceover"), 500); }}
            disabled={!isDone || navigating}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
          >
            {navigating ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Loading…
              </span>
            ) : "Continue →"}
          </button>
        </div>
      </div>
    </div>
  );
}
