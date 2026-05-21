"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";

type Tab = "image" | "video";

export default function DemoPromptsPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("image");

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={4} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner onSubscribe={() => router.push("/dashboard")} />
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div
            className="flex items-center justify-between px-8 py-4 shrink-0"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}
          >
            <div>
              <h1 className="font-bold text-lg">Prompt Studio</h1>
              <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                {DEMO_DATA.promptBeats.length} beats · image & video prompts
              </p>
            </div>
            <button
              onClick={() => router.push("/demo/generate")}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              Generate →
            </button>
          </div>

          {/* Step cards */}
          <div className="px-8 py-4 space-y-2 shrink-0" style={{ borderBottom: "1px solid var(--bd-6)" }}>
            {[
              { num: 1, title: "Image Prompts", desc: "One AI image prompt per script beat, matched to your channel's visual style", beats: DEMO_DATA.promptBeats.length },
              { num: 2, title: "Video Prompts", desc: "Camera movement and motion instructions layered on top of each image beat", beats: DEMO_DATA.promptBeats.length },
            ].map(({ num, title, desc, beats }) => (
              <div
                key={num}
                className="flex items-center gap-4 px-4 py-3 rounded-xl"
                style={{ background: "var(--bg-panel)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }}
              >
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
                  style={{ background: "oklch(0.55 0.15 145 / 0.2)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.4)" }}
                >
                  ✓
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: "var(--c-80)" }}>{title}</p>
                  <p className="text-xs mt-0.5 truncate" style={{ color: "var(--c-45)" }}>{desc}</p>
                </div>
                <span className="text-xs font-medium shrink-0" style={{ color: "oklch(0.65 0.15 145)" }}>
                  {beats} beats ready
                </span>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="px-8 pt-4 shrink-0 flex gap-1" style={{ borderBottom: "1px solid var(--bd-6)" }}>
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
          <div className="flex-1 overflow-y-auto px-8 py-5 space-y-3">
            {DEMO_DATA.promptBeats.map((beat) => (
              <div
                key={beat.beat}
                className="rounded-xl p-4 space-y-2"
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
                <p className="text-sm leading-relaxed" style={{ color: "var(--c-75)" }}>
                  {activeTab === "image" ? beat.imagePrompt : beat.videoPrompt}
                </p>
              </div>
            ))}

            <div className="flex justify-end pt-2 pb-4">
              <button
                onClick={() => router.push("/demo/generate")}
                className="px-6 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                style={{
                  background: "oklch(0.72 0.25 285)",
                  color: "var(--bg-page-2)",
                  boxShadow: "0 0 16px oklch(0.72 0.25 285 / 0.3)",
                }}
              >
                Generate →
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
