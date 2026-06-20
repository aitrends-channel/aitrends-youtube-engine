"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DemoStepCostCard } from "@/components/demo/DemoStepCostCard";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

// Mirror the actual channel page's helpers so the demo table renders
// identical duration/avg formatting. Kept inline rather than shared
// because the demo page is intentionally self-contained.
function formatDuration(iso?: string): string {
  if (!iso) return "—";
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return "—";
  const h = parseInt(m[1] ?? "0", 10);
  const min = parseInt(m[2] ?? "0", 10);
  const s = parseInt(m[3] ?? "0", 10);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(min)}:${pad(s)}`;
}

function parseDurationSeconds(iso?: string): number | null {
  if (!iso) return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const h = parseInt(m[1] ?? "0", 10);
  const min = parseInt(m[2] ?? "0", 10);
  const s = parseInt(m[3] ?? "0", 10);
  return h * 3600 + min * 60 + s;
}

function formatSecondsAsHHMMSS(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function averageDurationSeconds(videos: { duration?: string }[]): number | null {
  const seconds = videos.map((v) => parseDurationSeconds(v.duration)).filter((s): s is number => s != null);
  if (!seconds.length) return null;
  return Math.round(seconds.reduce((sum, s) => sum + s, 0) / seconds.length);
}

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
  const { state, update } = useDemoState();

  const { channelPhase, channelContentType, channelTopicMode, channelTopicHint } = state;

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
            // Intentionally not auto-routing to /demo/topic here so the
            // user can stay on the channel page, flip between content-
            // type tabs, and re-analyze freely. They advance to topic
            // via the existing "Continue to Topic →" button on the
            // result card below when they're ready.
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
    // Demo re-analyze is intentionally cheap: flip the phase back to
    // "loading" and let the effect re-run the steps animation. We
    // deliberately DON'T resetDemo here — that would clobber the user's
    // contentType pick and any downstream navigation, and the whole
    // point of demo re-analyses is to let them swap between Long /
    // Shorts / Both and see the resulting top-10 update without
    // starting over. From "done" the channelPhase change is what
    // triggers the useEffect; setTimeout(0) keeps the update on the
    // next tick so React batches cleanly with the click.
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
          <div className="px-4 sm:px-8 pt-6 sm:pt-8 pb-24 space-y-8">

            <div>
              <h1 className="text-2xl font-bold tracking-tight">Channel Setup</h1>
              <p className="text-sm mt-1" style={{ color: "var(--c-50)" }}>
                Enter a YouTube channel URL to automatically extract style DNA and generate content.
              </p>
              <div className="mt-3">
                <DemoStepCostCard column="channel_analysis" />
              </div>
            </div>

            {/* URL input + topic strategy card */}
            <div className="rounded-2xl p-6 space-y-5"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>

              {/* Content Type — mirrors the real flow's first decision.
                  Locked once the demo analysis has run so a Re-analyze
                  doesn't allow swapping scope mid-demo. */}
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                  Content Type
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { value: "long", label: "Long Videos", desc: "Standard YouTube videos" },
                    { value: "shorts", label: "Shorts", desc: "Vertical short-form" },
                    { value: "both", label: "Both", desc: "Long + shorts" },
                  ] as const).map((opt) => {
                    const selected = channelContentType === opt.value;
                    // Demo flow: tabs are only locked WHILE the steps
                    // animation is running. Once done, they're clickable
                    // again so the user can flip to a different content
                    // type and hit "Re-analyze" — supporting unlimited
                    // re-runs is intentional for the demo.
                    const locked = isLoading;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => update({ channelContentType: opt.value })}
                        disabled={locked}
                        // Selected tab stays fully visible even when the
                        // group is locked during a run, so the user can
                        // still read off which scope is being applied.
                        // Only the unselected siblings dim.
                        className={`px-4 py-2.5 rounded-xl text-sm text-left transition-all ${locked ? "cursor-not-allowed" : ""} ${locked && !selected ? "opacity-50" : ""}`}
                        style={{
                          background: selected ? "oklch(0.72 0.25 285 / 0.12)" : "var(--bg-progress)",
                          border: `1px solid ${selected ? "oklch(0.72 0.25 285 / 0.3)" : "var(--bd-8)"}`,
                          color: selected ? "oklch(0.72 0.25 285)" : "var(--c-55)",
                        }}
                      >
                        <p className="font-medium">{opt.label}</p>
                        <p className="text-xs mt-0.5 opacity-70">{opt.desc}</p>
                      </button>
                    );
                  })}
                </div>
                {!channelContentType && (
                  <p className="text-xs" style={{ color: "var(--c-45)" }}>
                    Pick a content type to begin.
                  </p>
                )}
              </div>

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
                    disabled={isLoading || !channelContentType}
                    placeholder={!channelContentType ? "Pick a content type above first" : undefined}
                    className="flex-1 min-w-0 px-4 py-2.5 rounded-xl text-sm outline-none"
                    style={{
                      background: "var(--bg-progress)",
                      border: "1px solid var(--bd-8)",
                      color: "var(--c-90)",
                      opacity: isLoading || !channelContentType ? 0.6 : 1,
                    }}
                  />
                  <button
                    onClick={handleAnalyze}
                    disabled={isLoading || !channelContentType}
                    className="shrink-0 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                    style={{
                      background: isDone ? "var(--bg-progress)" : "oklch(0.72 0.25 285)",
                      color: isDone ? "var(--c-60)" : "var(--bg-page-2)",
                      border: isDone ? "1px solid var(--bd-8)" : "none",
                      boxShadow: isLoading || isDone || !channelContentType ? "none" : "0 0 16px oklch(0.72 0.25 285 / 0.3)",
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
            {isDone && (() => {
              // Mirror the real flow: the top-10 table renders the set
              // matching the user's contentType pick. Fallback to long
              // covers the (rare) case of a stale session-storage row
              // missing the field — same default the real channel page
              // assumes when nothing is saved on the project row yet.
              const topVideos = channelContentType === "shorts"
                ? DEMO_DATA.channelTopVideos.shorts
                : channelContentType === "both"
                  ? DEMO_DATA.channelTopVideos.both
                  : DEMO_DATA.channelTopVideos.long;
              return (
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

                <div className="space-y-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
                      Top {topVideos.length} Video{topVideos.length === 1 ? "" : "s"}
                    </p>
                    {(() => {
                      const avg = averageDurationSeconds(topVideos);
                      return avg != null ? (
                        <p className="text-xs font-semibold uppercase tracking-wider tabular-nums" style={{ color: "var(--c-45)" }}>
                          Avg duration <span style={{ color: "var(--c-75)" }}>{formatSecondsAsHHMMSS(avg)}</span>
                        </p>
                      ) : null;
                    })()}
                  </div>
                  <div className="rounded-lg overflow-hidden" style={{ background: "var(--bg-progress)" }}>
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                          <th className="text-left px-3 py-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>Title</th>
                          <th className="text-right px-3 py-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--c-45)" }}>Words</th>
                          <th className="text-center px-3 py-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--c-45)" }}>Captions</th>
                          <th className="text-right px-3 py-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--c-45)" }}>Duration</th>
                          <th className="text-right px-3 py-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--c-45)" }}>Views</th>
                          <th className="text-right px-3 py-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--c-45)" }}>Published</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topVideos.map((v) => (
                          <tr key={v.videoId} style={{ borderTop: "1px solid var(--bd-7)" }}>
                            <td className="px-3 py-2 min-w-0">
                              <a
                                href={`https://www.youtube.com/watch?v=${v.videoId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1.5 min-w-0 hover:opacity-80 transition-opacity"
                                style={{ color: "oklch(0.72 0.25 285)" }}
                                title={v.title}
                              >
                                <span
                                  className="truncate underline underline-offset-2"
                                  style={{ textDecorationColor: "oklch(0.72 0.25 285 / 0.5)" }}
                                >
                                  {v.title}
                                </span>
                                <ArrowUpRight size={12} strokeWidth={2.25} className="shrink-0 opacity-70" aria-hidden />
                              </a>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--c-75)" }}>
                              {v.wordCount != null ? v.wordCount.toLocaleString() : "—"}
                            </td>
                            <td className="px-3 py-2 text-center whitespace-nowrap">
                              {v.hasCaptions === true ? (
                                <span style={{ color: "oklch(0.65 0.15 145)" }}>Yes</span>
                              ) : v.hasCaptions === false ? (
                                <span style={{ color: "var(--c-45)" }}>No</span>
                              ) : (
                                <span style={{ color: "var(--c-45)" }}>—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--c-75)" }}>
                              {formatDuration(v.duration)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--c-75)" }}>
                              {v.viewCount.toLocaleString()}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--c-75)" }}>
                              {v.publishedAt
                                ? new Date(v.publishedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <button
                  onClick={() => router.push("/demo/topic")}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  Continue to Topic →
                </button>
              </div>
              );
            })()}

          </div>
        </main>
      </div>
    </div>
  );
}
