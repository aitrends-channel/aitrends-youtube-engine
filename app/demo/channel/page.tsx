"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";

type Phase = "input" | "loading";

interface StepState {
  label: string;
  status: "idle" | "running" | "done";
}

export default function DemoChannelPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("input");
  const [steps, setSteps] = useState<StepState[]>(
    DEMO_DATA.analysisSteps.map((label) => ({ label, status: "idle" }))
  );
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    if (phase !== "loading") return;

    let i = 0;

    function runStep(index: number) {
      if (index >= DEMO_DATA.analysisSteps.length) {
        setTimeout(() => router.push("/demo/topic"), 400);
        return;
      }

      setActiveIndex(index);
      setSteps((prev) =>
        prev.map((s, si) =>
          si === index ? { ...s, status: "running" } : s
        )
      );

      setTimeout(() => {
        setSteps((prev) =>
          prev.map((s, si) =>
            si === index ? { ...s, status: "done" } : s
          )
        );
        runStep(index + 1);
      }, 1200);
    }

    runStep(0);
  }, [phase, router]);

  function handleAnalyze() {
    setPhase("loading");
    setSteps(DEMO_DATA.analysisSteps.map((label) => ({ label, status: "idle" })));
  }

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={0} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner onSubscribe={() => router.push("/dashboard")} />
        <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 pt-8 pb-10 space-y-8">

          <div>
            <h1 className="text-2xl font-bold tracking-tight">Channel Setup</h1>
            <p className="text-sm mt-1" style={{ color: "var(--c-50)" }}>
              Enter a YouTube channel URL to automatically extract style DNA and generate content.
            </p>
          </div>

          {/* URL input card */}
          <div
            className="rounded-2xl p-6 space-y-5"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}
          >
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                YouTube Channel URL
              </label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={DEMO_DATA.channel.url}
                  readOnly
                  disabled={phase === "loading"}
                  className="flex-1 px-4 py-2.5 rounded-xl text-sm outline-none"
                  style={{
                    background: "var(--bg-progress)",
                    border: "1px solid var(--bd-8)",
                    color: "var(--c-90)",
                    opacity: phase === "loading" ? 0.6 : 1,
                  }}
                />
                <button
                  onClick={handleAnalyze}
                  disabled={phase === "loading"}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                  style={{
                    background: "oklch(0.72 0.25 285)",
                    color: "var(--bg-page-2)",
                    boxShadow: phase === "loading" ? "none" : "0 0 16px oklch(0.72 0.25 285 / 0.3)",
                  }}
                >
                  {phase === "loading" ? "Running…" : "Analyze Channel"}
                </button>
              </div>
            </div>

            <div
              className="flex items-center gap-4 px-4 py-3 rounded-xl"
              style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-8)" }}
            >
              <div>
                <p className="text-sm font-semibold" style={{ color: "var(--c-90)" }}>{DEMO_DATA.channel.name}</p>
                <p className="text-xs mt-0.5" style={{ color: "var(--c-50)" }}>
                  {DEMO_DATA.channel.subscribers} subscribers · {DEMO_DATA.channel.avgViews} avg views
                </p>
              </div>
              <div
                className="ml-auto px-2 py-1 rounded-full text-xs font-medium shrink-0"
                style={{
                  background: "oklch(0.72 0.25 285 / 0.12)",
                  border: "1px solid oklch(0.72 0.25 285 / 0.25)",
                  color: "oklch(0.72 0.25 285)",
                }}
              >
                Demo Channel
              </div>
            </div>
          </div>

          {/* Analysis progress */}
          {phase === "loading" && (
            <div
              className="rounded-2xl p-6 space-y-4"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}
            >
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                Analysis Progress
              </p>
              <div className="space-y-4">
                {steps.map((step, i) => (
                  <div key={i}>
                    <div className="flex items-center gap-3">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm"
                        style={{
                          background:
                            step.status === "done"
                              ? "oklch(0.55 0.15 145 / 0.2)"
                              : step.status === "running"
                              ? "oklch(0.72 0.25 285 / 0.15)"
                              : "var(--bg-track)",
                          border: `1px solid ${
                            step.status === "done"
                              ? "oklch(0.55 0.15 145 / 0.4)"
                              : step.status === "running"
                              ? "oklch(0.72 0.25 285 / 0.4)"
                              : "var(--c-25)"
                          }`,
                          color:
                            step.status === "done"
                              ? "oklch(0.7 0.15 145)"
                              : step.status === "running"
                              ? "oklch(0.72 0.25 285)"
                              : "var(--c-40)",
                        }}
                      >
                        {step.status === "done" ? (
                          "✓"
                        ) : step.status === "running" ? (
                          <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
                        ) : (
                          "○"
                        )}
                      </div>
                      <div>
                        <p
                          className="text-sm font-medium"
                          style={{ color: step.status === "idle" ? "var(--c-45)" : "var(--c-90)" }}
                        >
                          {step.label}
                        </p>
                        <p className="text-xs" style={{ color: "var(--c-45)" }}>
                          {step.status === "done"
                            ? "Complete"
                            : step.status === "running"
                            ? "In progress…"
                            : "Waiting"}
                        </p>
                      </div>
                    </div>
                    {i < steps.length - 1 && (
                      <div
                        className="ml-4 mt-1 mb-1 w-px h-3"
                        style={{
                          background:
                            step.status === "done" ? "oklch(0.55 0.15 145 / 0.3)" : "var(--c-22)",
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        </main>
      </div>
    </div>
  );
}
