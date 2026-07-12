"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DemoStepCostCard } from "@/components/demo/DemoStepCostCard";
import { DemoStepBalanceCard } from "@/components/demo/DemoStepBalanceCard";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

type StepStatus = "idle" | "running" | "done";

const ANALYZE_STEPS = [
  { key: "analyze", label: "Extract visual style", sublabel: "Analyzing art direction, lighting, mood, and composition" },
] as const;

function StepRow({ label, sublabel, status }: { label: string; sublabel: string; status: StepStatus }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-sm"
        style={
          status === "done"    ? { background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.7 0.15 145)" } :
          status === "running" ? { background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" } :
          { background: "var(--bg-progress)", color: "var(--c-35)" }
        }
      >
        {status === "done" ? "✓" :
         status === "running" ? <span className="block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" /> :
         "○"}
      </div>
      <div>
        <p className="text-sm font-medium" style={{ color: status === "idle" ? "var(--c-40)" : "var(--c-85)" }}>{label}</p>
        <p className="text-xs" style={{ color: "var(--c-40)" }}>{sublabel}</p>
      </div>
    </div>
  );
}

function SelectableImage({ url, selected, onToggle, label }: { url: string; selected: boolean; onToggle: () => void; label?: string }) {
  return (
    <button
      onClick={onToggle}
      className="relative rounded-xl overflow-hidden transition-all"
      style={{
        border: `2px solid ${selected ? "oklch(0.72 0.25 285)" : "var(--bd-8)"}`,
        boxShadow: selected ? "0 0 12px oklch(0.72 0.25 285 / 0.3)" : "none",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={label ?? ""} className="w-full aspect-video object-cover" />
      <div className="absolute inset-0 transition-all"
        style={{ background: selected ? "oklch(0.72 0.25 285 / 0.12)" : "transparent" }} />
      {selected && (
        <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
          style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
          ✓
        </div>
      )}
      {label && (
        <div className="absolute bottom-0 inset-x-0 px-2 py-1 text-xs truncate"
          style={{ background: "oklch(0.06 0 0 / 0.8)", color: "var(--c-60)" }}>
          {label}
        </div>
      )}
    </button>
  );
}

export default function DemoVisualsPage() {
  const router = useRouter();
  const { state, update } = useDemoState();
  const [navigating, setNavigating] = useState(false);

  const { visualsFetchPhase, visualsAnalyzePhase } = state;

  const screenshots = DEMO_DATA.fakeScreenshots;
  const allUrls = [...new Set(screenshots.flatMap((s) => [s.thumbnailUrl, ...s.frameUrls]))];

  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(() =>
    visualsFetchPhase === "done" ? new Set(allUrls) : new Set()
  );

  const hasFetched  = visualsFetchPhase === "done";
  const hasDone     = visualsAnalyzePhase === "done";
  const isAnalyzing = visualsAnalyzePhase === "running";

  const totalSelected = selectedUrls.size;

  function fetchScreenshots() {
    update({ visualsFetchPhase: "fetching" });
    setTimeout(() => {
      update({ visualsFetchPhase: "done" });
      setSelectedUrls(new Set(allUrls));
    }, 2000);
  }

  function analyzeVisuals() {
    update({ visualsAnalyzePhase: "running" });
    setTimeout(() => update({ visualsAnalyzePhase: "done" }), 2500);
  }

  function toggleUrl(url: string) {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }

  const { visualProfile } = DEMO_DATA;

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={3} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 flex flex-col overflow-hidden lg:px-[15px]">

          {/* Header */}
          <div
            className="shrink-0 px-5 sm:px-8 py-4 sm:py-5"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}
          >
            <h1 className="font-bold text-lg">Visual Style Extraction</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Auto-capture screenshots so we can extract the channel&apos;s visual signature
            </p>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <DemoStepCostCard column="visuals" />
              <DemoStepBalanceCard />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
          <div className="px-5 sm:px-8 py-4 sm:py-8 pb-[200px] space-y-6">

            {/* Mode toggle (Manual locked) */}
            <div className="flex gap-2 p-1 rounded-xl"
              style={{ background: "var(--bg-elevated)", border: "1px solid var(--bd-7)" }}>
              {[
                { id: "auto",   label: "⚡ Auto Screenshot", disabled: false },
                { id: "manual", label: "↑ Manual Upload",    disabled: true  },
              ].map((m) => (
                <button
                  key={m.id}
                  disabled={m.disabled}
                  className="flex-1 px-3 sm:px-5 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-35"
                  style={!m.disabled ? {
                    background: "oklch(0.72 0.25 285)",
                    color: "var(--bg-page-2)",
                  } : {
                    color: "var(--c-50)",
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* Fetch panel */}
            <div className="rounded-2xl p-5"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <p className="font-semibold text-sm">Auto-capture from Channel Videos</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                    Fetches thumbnails + 2 frame stills from each of the top {screenshots.length} videos
                  </p>
                </div>
                <button
                  onClick={fetchScreenshots}
                  disabled={visualsFetchPhase === "fetching" || hasFetched}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-all"
                  style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                >
                  {visualsFetchPhase === "fetching" ? (
                    <>
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      Fetching…
                    </>
                  ) : hasFetched ? "✓ Fetched" : "⚡ Fetch Screenshots"}
                </button>
              </div>

              {!hasFetched && visualsFetchPhase === "idle" && (
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[
                    { icon: "◎", label: "Thumbnail images",   desc: "Official YouTube thumbnail per video" },
                    { icon: "◈", label: "Video frame stills", desc: "2 auto-frames per video" },
                    { icon: "✦", label: "Style extraction",   desc: "Analyzes colors, lighting, mood, and composition" },
                  ].map((item) => (
                    <div key={item.label} className="p-3 rounded-xl"
                      style={{ background: "oklch(0.09 0 0)", border: "1px solid var(--bd-6)" }}>
                      <span className="text-base" style={{ color: "oklch(0.72 0.25 285)" }}>{item.icon}</span>
                      <p className="font-medium text-xs mt-2 mb-0.5">{item.label}</p>
                      <p className="text-xs" style={{ color: "var(--c-40)" }}>{item.desc}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Fetched screenshot grid */}
            {hasFetched && (
              <div className="space-y-5">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">
                    Select images for analysis
                    <span className="ml-2 text-xs font-normal" style={{ color: "var(--c-45)" }}>
                      {totalSelected} selected
                    </span>
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSelectedUrls(new Set(allUrls))}
                      className="text-xs px-3 py-1 rounded-lg"
                      style={{ background: "var(--bg-progress)", color: "var(--c-55)", border: "1px solid var(--bd-7)" }}
                    >
                      Select all
                    </button>
                    <button
                      onClick={() => setSelectedUrls(new Set())}
                      className="text-xs px-3 py-1 rounded-lg"
                      style={{ background: "var(--bg-progress)", color: "var(--c-55)", border: "1px solid var(--bd-7)" }}
                    >
                      Clear all
                    </button>
                  </div>
                </div>

                {/* Images grid */}
                <div className="rounded-2xl overflow-hidden"
                  style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                  <div className="px-5 py-3 flex items-center gap-2"
                    style={{ borderBottom: "1px solid var(--bd-6)" }}>
                    <span style={{ color: "oklch(0.72 0.25 285)" }}>◈</span>
                    <p className="text-xs font-semibold">Captured Images</p>
                  </div>
                  <div className="p-5">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {allUrls.map((url, i) => (
                        <SelectableImage
                          key={url}
                          url={url}
                          selected={selectedUrls.has(url)}
                          onToggle={() => toggleUrl(url)}
                          label={`Image ${i + 1}`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Analysis progress */}
            {(isAnalyzing || hasDone) && (
              <div className="rounded-2xl p-5 space-y-4"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
                  Analysis Progress
                </p>
                <div className="space-y-3">
                  {ANALYZE_STEPS.map((step) => (
                    <StepRow
                      key={step.key}
                      label={step.label}
                      sublabel={step.sublabel}
                      status={hasDone ? "done" : isAnalyzing ? "running" : "idle"}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Analyze button */}
            {!hasDone && (
              <button
                onClick={analyzeVisuals}
                disabled={!hasFetched || totalSelected < 3 || isAnalyzing}
                className="w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
                style={{ background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))", color: "var(--bg-page-2)" }}
              >
                {isAnalyzing ? "Analyzing…" :
                 !hasFetched   ? "Fetch screenshots first" :
                 totalSelected < 3 ? "Select at least 3 images" :
                 `Analyze ${totalSelected} selected images`}
              </button>
            )}

            {/* Visual profile result */}
            {hasDone && (
              <div className="rounded-2xl overflow-hidden"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)", marginBottom: "60px" }}>
                <div className="px-5 py-4 flex items-center justify-between gap-2"
                  style={{ borderBottom: "1px solid var(--bd-6)", background: "oklch(0.55 0.15 145 / 0.06)" }}>
                  <div className="flex items-center gap-2">
                    <span style={{ color: "oklch(0.7 0.15 145)" }}>✓</span>
                    <p className="font-semibold text-sm" style={{ color: "oklch(0.7 0.15 145)" }}>
                      Visual Style Profile Extracted
                    </p>
                  </div>
                  {/* Edit is present to mirror the real step but disabled in the
                      demo — profile edits can't be persisted here. */}
                  <button
                    disabled
                    title="Editing is available in the full app"
                    className="text-xs px-3 py-1 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ background: "transparent", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
                  >
                    Edit
                  </button>
                </div>
                <div className="p-5 grid grid-cols-2 gap-4">
                  {[
                    { label: "Art Style",  value: visualProfile.artStyle },
                    { label: "Lighting",   value: visualProfile.lightingStyle },
                    { label: "Camera",     value: visualProfile.cameraStyle },
                    { label: "Mood",       value: visualProfile.mood },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-xs mb-1" style={{ color: "var(--c-45)" }}>{label}</p>
                      <p className="text-sm" style={{ color: "oklch(0.8 0 0)" }}>{value}</p>
                    </div>
                  ))}
                  <div className="col-span-2">
                    <p className="text-xs mb-2" style={{ color: "var(--c-45)" }}>Color Palette</p>
                    <div className="flex gap-2 flex-wrap">
                      {visualProfile.palette.map((hex, i) => (
                        <span key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs"
                          style={{ background: "var(--bg-progress)", color: "var(--c-70)", border: "1px solid var(--bd-8)" }}>
                          <span className="w-3 h-3 rounded-sm inline-block shrink-0" style={{ background: hex }} />
                          {visualProfile.paletteLabels[i]}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

          </div>
          </div>
        </main>
      </div>

      {hasDone && (
        <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
          {/* Mirror the content's insets exactly — main's lg:px-[15px] plus
              the body's px-5 sm:px-8 — so the full-width button lines up flush
              with the cards above it. */}
          <div className="lg:px-[15px]">
          <div className="px-5 sm:px-8">
            <button
              onClick={() => { setNavigating(true); setTimeout(() => router.push("/demo/prompts"), 500); }}
              disabled={navigating}
              className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 transition-all"
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
      )}
    </div>
  );
}
