"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";

type Phase = "loading" | "done";

const CAPTURE_STEPS = [
  "Fetching top videos from channel…",
  "Capturing thumbnail images…",
  "Extracting frame stills…",
  "Analysing visual style DNA…",
];

export default function DemoVisualsPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    let i = 0;
    function next() {
      if (i >= CAPTURE_STEPS.length) {
        setTimeout(() => setPhase("done"), 400);
        return;
      }
      setStepIndex(i);
      i++;
      setTimeout(next, 900);
    }
    next();
  }, []);

  const { visualProfile } = DEMO_DATA;

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={3} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner onSubscribe={() => router.push("/dashboard")} />
        <main className="flex-1 overflow-y-auto">
          <div
            className="flex items-center justify-between px-8 py-5"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}
          >
            <div>
              <h1 className="font-bold text-lg">Visual Style Extraction</h1>
              <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                Auto-captured screenshots analysed for channel visual DNA
              </p>
            </div>
            {phase === "done" && (
              <button
                onClick={() => router.push("/demo/prompts")}
                className="px-4 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                Continue to Prompts →
              </button>
            )}
          </div>

          <div className="p-8 max-w-4xl mx-auto space-y-6">

            {/* Progress steps */}
            <div className="rounded-2xl p-6 space-y-4" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--c-40)" }}>
                {phase === "done" ? "Capture complete" : "Capturing…"}
              </p>
              <div className="space-y-3">
                {CAPTURE_STEPS.map((label, i) => {
                  const done = phase === "done" || i < stepIndex;
                  const running = phase !== "done" && i === stepIndex;
                  return (
                    <div key={i} className="flex items-center gap-3">
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs"
                        style={{
                          background: done
                            ? "oklch(0.55 0.15 145 / 0.2)"
                            : running
                            ? "oklch(0.72 0.25 285 / 0.15)"
                            : "var(--bg-track)",
                          border: `1px solid ${done ? "oklch(0.55 0.15 145 / 0.4)" : running ? "oklch(0.72 0.25 285 / 0.4)" : "var(--c-25)"}`,
                          color: done ? "oklch(0.7 0.15 145)" : running ? "oklch(0.72 0.25 285)" : "var(--c-40)",
                        }}
                      >
                        {done ? "✓" : running ? (
                          <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
                        ) : "○"}
                      </div>
                      <p className="text-sm" style={{ color: done || running ? "var(--c-80)" : "var(--c-40)" }}>
                        {label}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Visual profile — shown after loading */}
            {phase === "done" && (
              <>
                {/* Color palette */}
                <div className="rounded-2xl p-6 space-y-4" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                  <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--c-40)" }}>
                    Color Palette
                  </p>
                  <div className="flex gap-3">
                    {visualProfile.palette.map((hex, i) => (
                      <div key={i} className="flex flex-col items-center gap-2">
                        <div
                          className="w-12 h-12 rounded-xl border"
                          style={{ background: hex, borderColor: "oklch(1 0 0 / 0.08)" }}
                        />
                        <span className="text-[10px] font-mono" style={{ color: "var(--c-40)" }}>
                          {hex}
                        </span>
                        <span className="text-[10px]" style={{ color: "var(--c-35)" }}>
                          {visualProfile.paletteLabels[i]}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Style attributes */}
                <div className="rounded-2xl p-6 space-y-4" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                  <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--c-40)" }}>
                    Style Profile
                  </p>
                  <p className="text-sm leading-relaxed" style={{ color: "var(--c-70)" }}>
                    {visualProfile.style}
                  </p>
                  <div className="grid grid-cols-1 gap-3 pt-1">
                    {[
                      { label: "Thumbnail pattern", value: visualProfile.thumbnailPattern },
                      { label: "Editing pace",       value: visualProfile.editingPace },
                      { label: "Music mood",         value: visualProfile.musicMood },
                    ].map(({ label, value }) => (
                      <div key={label} className="rounded-xl px-4 py-3" style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-7)" }}>
                        <p className="text-xs font-semibold mb-1" style={{ color: "var(--c-50)" }}>{label}</p>
                        <p className="text-sm" style={{ color: "var(--c-75)" }}>{value}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={() => router.push("/demo/prompts")}
                    className="px-6 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                    style={{
                      background: "oklch(0.72 0.25 285)",
                      color: "var(--bg-page-2)",
                      boxShadow: "0 0 16px oklch(0.72 0.25 285 / 0.3)",
                    }}
                  >
                    Continue to Prompts →
                  </button>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
