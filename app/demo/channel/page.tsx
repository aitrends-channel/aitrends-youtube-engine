"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

type StepStatus = "idle" | "running" | "done";

interface AnalysisStep {
  label: string;
  sublabel: string;
  status: StepStatus;
}

function StepIndicator({ step }: { step: AnalysisStep }) {
  const isDone = step.status === "done";
  const isRunning = step.status === "running";
  const isIdle = step.status === "idle";

  return (
    <div className="flex items-center gap-4">
      {/* Item: icon + label */}
      <div className="flex items-center gap-3 shrink-0">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm"
          style={{
            background: isDone ? "oklch(0.55 0.15 145 / 0.2)"
              : isRunning ? "oklch(0.55 0.15 145 / 0.15)"
              : "var(--bg-track)",
            border: `1px solid ${isDone ? "oklch(0.55 0.15 145 / 0.4)"
              : isRunning ? "oklch(0.55 0.15 145 / 0.35)"
              : "var(--c-25)"}`,
            color: isDone ? "oklch(0.7 0.15 145)"
              : isRunning ? "oklch(0.65 0.15 145)"
              : "var(--c-40)",
          }}
        >
          {isDone ? "✓"
            : isRunning ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
            : "○"}
        </div>
        <div className="w-28 sm:w-32">
          <p className="text-sm font-medium truncate" style={{ color: isIdle ? "var(--c-45)" : "var(--c-90)" }}>
            {step.label}
          </p>
          {step.sublabel && <p className="text-xs truncate" style={{ color: "var(--c-45)" }}>{step.sublabel}</p>}
        </div>
      </div>

      {/* Progress bar — fills green incrementally while running, snaps full on done */}
      <div className="flex-1 ml-2 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
        {isDone ? (
          <div className="h-full w-full rounded-full" style={{ background: "oklch(0.55 0.15 145)" }} />
        ) : isRunning ? (
          <div
            className="h-full wizard-progress-fill"
            style={{ background: "oklch(0.6 0.16 145)", ["--wizard-fill-duration" as string]: "1.2s" } as React.CSSProperties}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function DemoChannelPage() {
  const router = useRouter();
  const { state, update, resetDemo } = useDemoState();

  const { channelPhase, channelTopicMode, channelTopicHint } = state;

  const initialSteps = (): AnalysisStep[] =>
    DEMO_DATA.analysisSteps.map((s) => ({ ...s, status: "idle" as StepStatus }));

  const doneSteps = (): AnalysisStep[] =>
    DEMO_DATA.analysisSteps.map((s) => ({ ...s, status: "done" as StepStatus }));

  const [steps, setSteps] = useState<AnalysisStep[]>(
    channelPhase === "done" ? doneSteps() : initialSteps()
  );

  useEffect(() => {
    if (channelPhase !== "loading") return;

    setSteps(initialSteps());
    let cancelled = false;

    function runStep(index: number) {
      if (cancelled) return;
      if (index >= DEMO_DATA.analysisSteps.length) {
        setTimeout(() => {
          if (!cancelled) {
            update({ channelPhase: "done" });
            fetch("/api/demo-niche", { method: "POST" }).catch(() => {});
            router.push("/demo/topic");
          }
        }, 400);
        return;
      }

      setSteps((prev) =>
        prev.map((s, si) => ({ ...s, status: si === index ? "running" : si < index ? "done" : "idle" }))
      );

      setTimeout(() => {
        setSteps((prev) =>
          prev.map((s, si) => si === index ? { ...s, status: "done" } : s)
        );
        runStep(index + 1);
      }, 1200);
    }

    runStep(0);
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelPhase]);

  function handleAnalyze() {
    if (isDone) {
      // Wipe all state and start fresh — resetDemo sets DEFAULTS (channelPhase:"idle"),
      // then we immediately kick off loading so the effect fires.
      resetDemo();
    }
    // Use a short delay when re-analyzing so the reset setState flush finishes first
    setTimeout(() => update({ channelPhase: "loading" }), 0);
  }

  const isLoading = channelPhase === "loading";
  const isDone    = channelPhase === "done";

  return (
    <div className="flex h-screen overflow-x-hidden" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={0} />
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 sm:px-8 pt-6 sm:pt-8 pb-24 space-y-8">

            <div>
              <h1 className="text-2xl font-bold tracking-tight">Channel Setup</h1>
              <p className="text-sm mt-1" style={{ color: "var(--c-50)" }}>
                Enter a YouTube channel URL to automatically extract style DNA and generate content.
              </p>
            </div>

            {/* URL input + topic strategy card */}
            <div className="rounded-2xl p-6 space-y-5"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>

              {/* Channel URL */}
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                  YouTube Channel URL
                </label>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={DEMO_DATA.channel.url}
                    readOnly
                    disabled={isLoading}
                    className="flex-1 min-w-0 px-4 py-2.5 rounded-xl text-sm outline-none"
                    style={{
                      background: "var(--bg-progress)",
                      border: "1px solid var(--bd-8)",
                      color: "var(--c-90)",
                      opacity: isLoading ? 0.6 : 1,
                    }}
                  />
                  <button
                    onClick={handleAnalyze}
                    disabled={isLoading}
                    className="shrink-0 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                    style={{
                      background: isDone ? "var(--bg-progress)" : "oklch(0.72 0.25 285)",
                      color: isDone ? "var(--c-60)" : "var(--bg-page-2)",
                      border: isDone ? "1px solid var(--bd-8)" : "none",
                      boxShadow: isLoading || isDone ? "none" : "0 0 16px oklch(0.72 0.25 285 / 0.3)",
                    }}
                  >
                    {isLoading ? "Running…" : isDone ? "Re-analyze" : "Analyze"}
                  </button>
                </div>
              </div>

              {/* Topic Strategy */}
              <div className="space-y-3">
                <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                  Topic Strategy
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(["generate", "custom"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => update({ channelTopicMode: mode })}
                      disabled={isLoading}
                      className="px-4 py-2.5 rounded-xl text-sm text-left transition-all disabled:opacity-50"
                      style={{
                        background: channelTopicMode === mode ? "oklch(0.72 0.25 285 / 0.12)" : "var(--bg-progress)",
                        border: `1px solid ${channelTopicMode === mode ? "oklch(0.72 0.25 285 / 0.3)" : "var(--bd-8)"}`,
                        color: channelTopicMode === mode ? "oklch(0.72 0.25 285)" : "var(--c-55)",
                      }}
                    >
                      <p className="font-medium">{mode === "generate" ? "Generate Ideas" : "Custom Topic"}</p>
                      <p className="text-xs mt-0.5 opacity-70">
                        {mode === "generate" ? "AI creates 5 video ideas" : "I already have a topic"}
                      </p>
                    </button>
                  ))}
                </div>

                {channelTopicMode === "generate" && (
                  <input
                    type="text"
                    placeholder="Optional topic direction hint (e.g. 'avoiding lifestyle inflation')"
                    value={channelTopicHint}
                    onChange={(e) => update({ channelTopicHint: e.target.value })}
                    disabled={isLoading}
                    className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-8)", color: "var(--c-90)" }}
                  />
                )}

                {channelTopicMode === "custom" && (
                  <input
                    type="text"
                    placeholder="Enter your video topic"
                    disabled={isLoading}
                    className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all opacity-50"
                    style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-8)", color: "var(--c-90)" }}
                  />
                )}
              </div>
            </div>

            {/* Analysis progress */}
            {(isLoading || isDone) && (
              <div className="rounded-2xl p-6 space-y-4"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                  Analysis Progress
                </p>
                <div className="space-y-4">
                  {steps.map((step, i) => (
                    <div key={i}>
                      <StepIndicator step={step} />
                      {i < steps.length - 1 && (
                        <div className="ml-4 mt-1 mb-1 w-px h-3"
                          style={{ background: step.status === "done" ? "oklch(0.55 0.15 145 / 0.3)" : "var(--c-22)" }} />
                      )}
                    </div>
                  ))}
                </div>

                {isDone && (
                  <div className="mt-2 px-3 py-2 rounded-lg text-sm text-center"
                    style={{ background: "oklch(0.55 0.15 145 / 0.1)", border: "1px solid oklch(0.55 0.15 145 / 0.2)", color: "oklch(0.7 0.15 145)" }}>
                    Analysis complete
                  </div>
                )}
              </div>
            )}

            {/* Channel info result card */}
            {isDone && (
              <div className="rounded-2xl p-6 space-y-4"
                style={{ background: "var(--bg-panel)", border: "1px solid oklch(0.72 0.25 285 / 0.15)" }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-semibold truncate">{DEMO_DATA.channel.name}</h2>
                    <p className="text-sm truncate" style={{ color: "var(--c-50)" }}>
                      {DEMO_DATA.channel.subscribers} subscribers · {DEMO_DATA.channel.avgViews} avg views
                    </p>
                  </div>
                  <div className="px-2 py-1 rounded-full text-xs font-medium"
                    style={{ background: "oklch(0.55 0.15 145 / 0.15)", border: "1px solid oklch(0.55 0.15 145 / 0.3)", color: "oklch(0.7 0.15 145)" }}>
                    Found
                  </div>
                </div>

                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
                    Top Videos
                  </p>
                  {DEMO_DATA.channelTopVideos.map((v) => (
                    <div key={v.videoId} className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm"
                      style={{ background: "var(--bg-progress)" }}>
                      <span className="text-xs shrink-0" style={{ color: "var(--c-50)" }}>
                        {v.viewCount.toLocaleString()} views
                      </span>
                      <span className="truncate" style={{ color: "var(--c-75)" }}>{v.title}</span>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => router.push("/demo/topic")}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  Continue to Topic →
                </button>
              </div>
            )}

          </div>
        </main>
      </div>
    </div>
  );
}
