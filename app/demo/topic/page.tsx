"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";

export default function DemoTopicPage() {
  const router = useRouter();
  const [selectedTopic, setSelectedTopic] = useState("");

  function handleContinue() {
    if (!selectedTopic) return;
    sessionStorage.setItem("demo_topic", selectedTopic);
    router.push("/demo/script");
  }

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={1} />
      <DemoBanner onSubscribe={() => router.push("/dashboard")} />

      <main className="flex-1 overflow-y-auto">
        <div
          className="px-8 py-5"
          style={{
            borderBottom: "1px solid var(--bd-6)",
            background: "var(--bg-header-2)",
            backdropFilter: "blur(12px)",
          }}
        >
          <h1 className="font-bold text-lg">Choose Your Topic</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
            Select a video idea generated for FinanceFuel
          </p>
        </div>

        <div className="max-w-2xl mx-auto px-8 pt-14 pb-8 space-y-5">

          <div className="space-y-2">
            {DEMO_DATA.videoIdeas.map((idea, i) => (
              <button
                key={i}
                onClick={() => setSelectedTopic(idea)}
                className="w-full text-left p-4 rounded-xl transition-all"
                style={
                  selectedTopic === idea
                    ? {
                        background: "oklch(0.72 0.25 285 / 0.12)",
                        border: "1px solid oklch(0.72 0.25 285 / 0.35)",
                      }
                    : {
                        background: "var(--bg-panel)",
                        border: "1px solid var(--bd-7)",
                      }
                }
                onMouseEnter={(e) => {
                  if (selectedTopic !== idea)
                    (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.2)";
                }}
                onMouseLeave={(e) => {
                  if (selectedTopic !== idea)
                    (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-7)";
                }}
              >
                <div className="flex items-start gap-3">
                  <span
                    className="text-xs font-mono mt-0.5 shrink-0"
                    style={{
                      color: "oklch(0.72 0.25 285)",
                      background: "oklch(0.72 0.25 285 / 0.1)",
                      padding: "2px 6px",
                      borderRadius: "4px",
                    }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span
                    className="text-sm leading-relaxed"
                    style={{ color: selectedTopic === idea ? "var(--c-90)" : "var(--c-65)" }}
                  >
                    {idea}
                  </span>
                </div>
              </button>
            ))}
          </div>

          <button
            onClick={handleContinue}
            disabled={!selectedTopic}
            className="w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
          >
            Continue to Script →
          </button>
        </div>
      </main>
    </div>
  );
}
