"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";

type Phase = "loading" | "done";

const WAVEFORM_HEIGHTS = [30, 55, 75, 45, 90, 60, 80, 40, 65, 50];

export default function DemoGeneratePage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const duration = 2500;
    const interval = 50;
    const steps = duration / interval;
    let current = 0;

    const id = setInterval(() => {
      current += 1;
      const pct = Math.min(Math.round((current / steps) * 100), 100);
      setProgress(pct);
      if (current >= steps) {
        clearInterval(id);
        setTimeout(() => setPhase("done"), 200);
      }
    }, interval);

    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={3} />
      <DemoBanner onSubscribe={() => router.push("/dashboard")} />

      <main className="flex-1 overflow-y-auto">
        <div
          className="px-8 py-5"
          style={{
            borderBottom: "1px solid var(--bd-6)",
            background: "var(--bg-header-2)",
            backdropFilter: "blur(12px)",
            marginTop: "36px",
          }}
        >
          <h1 className="font-bold text-lg">Generate Assets</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
            AI-generated images and voiceover for your video
          </p>
        </div>

        <div className="max-w-3xl mx-auto px-8 py-8 space-y-8">

          {phase === "loading" && (
            <div
              className="rounded-2xl p-8 text-center space-y-6"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}
            >
              <div className="space-y-2">
                <p className="text-sm font-semibold" style={{ color: "var(--c-75)" }}>
                  Generating your assets…
                </p>
                <p className="text-xs" style={{ color: "var(--c-45)" }}>
                  Creating images and synthesizing voiceover
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs" style={{ color: "var(--c-45)" }}>
                  <span>Progress</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${progress}%`,
                      background: "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                      boxShadow: "0 0 8px oklch(0.72 0.25 285 / 0.5)",
                      transition: "width 50ms linear",
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {phase === "done" && (
            <div className="space-y-8">

              {/* AI Images */}
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-base"
                    style={{
                      background: "oklch(0.72 0.25 285 / 0.1)",
                      color: "oklch(0.72 0.25 285)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                    }}
                  >
                    ◈
                  </div>
                  <div>
                    <p className="font-semibold text-sm">AI Images</p>
                    <p className="text-xs" style={{ color: "var(--c-45)" }}>4 scenes generated from script beats</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {DEMO_DATA.imagePrompts.map((prompt, i) => (
                    <div
                      key={i}
                      className="rounded-xl aspect-square flex items-center justify-center p-4"
                      style={{
                        background: "oklch(0.72 0.25 285 / 0.08)",
                        border: "1px solid oklch(0.72 0.25 285 / 0.15)",
                      }}
                    >
                      <p
                        className="text-xs italic text-center leading-relaxed"
                        style={{ color: "var(--c-50)" }}
                      >
                        {prompt}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Voiceover */}
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-base"
                    style={{
                      background: "oklch(0.72 0.25 285 / 0.1)",
                      color: "oklch(0.72 0.25 285)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                    }}
                  >
                    ♪
                  </div>
                  <div>
                    <p className="font-semibold text-sm">Voiceover</p>
                    <p className="text-xs" style={{ color: "var(--c-45)" }}>Text-to-speech from your script</p>
                  </div>
                </div>

                <div
                  className="rounded-xl p-5"
                  style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}
                >
                  <div className="flex items-center gap-4">
                    <button
                      className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all hover:opacity-80"
                      style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.06 0 0)" }}
                    >
                      <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
                        <path d="M0 1L12 7L0 13V1Z" />
                      </svg>
                    </button>

                    <div className="flex-1 flex items-center gap-0.5 h-8">
                      {WAVEFORM_HEIGHTS.map((h, i) => (
                        <div
                          key={i}
                          className="flex-1 rounded-full"
                          style={{
                            height: `${h}%`,
                            background: "oklch(0.72 0.25 285)",
                            opacity: 0.7,
                          }}
                        />
                      ))}
                    </div>

                    <span className="text-xs font-mono shrink-0" style={{ color: "var(--c-50)" }}>
                      2:34
                    </span>
                  </div>
                </div>
              </div>

              {/* Continue */}
              <div className="flex justify-end pt-2">
                <button
                  onClick={() => router.push("/demo/finish")}
                  className="px-6 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                  style={{
                    background: "oklch(0.72 0.25 285)",
                    color: "var(--bg-page-2)",
                    boxShadow: "0 0 16px oklch(0.72 0.25 285 / 0.3)",
                  }}
                >
                  Continue →
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
