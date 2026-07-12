"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DemoStepCostCard } from "@/components/demo/DemoStepCostCard";
import { DemoStepBalanceCard } from "@/components/demo/DemoStepBalanceCard";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

type Tab = "image" | "video";
type PromptStyle = "general" | "cinematic";

// Inline prompt editor — read-only text with an "Edit" affordance that
// toggles a textarea + Save/Cancel. Mirrors the real prompts step; edits
// are held in the page's local state for the session (the demo has no
// backend to persist to).
function DemoEditablePrompt({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  if (!editing) {
    return (
      <div>
        <p className="text-sm leading-relaxed break-words" style={{ color: "var(--c-75)" }}>{value}</p>
        <button
          onClick={() => { setDraft(value); setEditing(true); }}
          className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium transition-opacity hover:opacity-80"
          style={{ color: "oklch(0.72 0.25 285)" }}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M8.5 1.5l2 2L4 10l-2.5.5L2 8l6.5-6.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        autoFocus
        className="w-full rounded-lg text-sm leading-relaxed p-3 outline-none resize-y"
        style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", color: "var(--c-80)" }}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => { onSave(draft.trim()); setEditing(false); }}
          disabled={!draft.trim()}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity disabled:opacity-40"
          style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
        >
          Save
        </button>
        <button
          onClick={() => { setEditing(false); setDraft(value); }}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          style={{ border: "1px solid var(--bd-card)", color: "var(--c-55)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

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
  // Image-prompt style (General / Cinematic) — mirrors the real step. In the
  // demo it's a visual toggle; a real run would re-prompt in that style.
  const [promptStyle, setPromptStyle] = useState<PromptStyle>("general");
  // Session-local prompt edits, keyed by `${beat}-${tab}`.
  const [editedPrompts, setEditedPrompts] = useState<Record<string, string>>({});

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
            className="px-5 sm:px-8 py-4 sticky top-0 z-10"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}
          >
            <h1 className="font-bold text-lg">Prompt Studio</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              {DEMO_DATA.promptStepBeats.length} beats · image & video prompts
            </p>
            <div className="mt-3 flex items-center gap-2">
              <DemoStepCostCard column="prompts" />
              <DemoStepBalanceCard />
            </div>
          </div>

          {/* Generation controls — style tabs + step cards live inside one
              white-bordered card, mirroring the real prompts step. */}
          <div className="px-5 sm:px-8 py-4">
          <div className="rounded-2xl p-4 sm:p-5 space-y-3"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
            {/* Image-prompt style tabs — General (default) vs Cinematic.
                Cinematic layers filmic cues into the prompt at generation
                time. Mirrors the real step. */}
            <div className="rounded-xl p-1 flex gap-1 w-fit"
              style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
              {([
                { id: "general" as const, label: "General" },
                { id: "cinematic" as const, label: "Cinematic" },
              ]).map((t) => {
                const active = promptStyle === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setPromptStyle(t.id)}
                    disabled={isGenerating}
                    className="px-3 py-1 rounded-lg text-xs font-medium transition-all disabled:opacity-40"
                    style={active ? {
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                      color: "oklch(0.88 0.12 285)",
                    } : {
                      background: "transparent",
                      border: "1px solid transparent",
                      color: "var(--c-55)",
                    }}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

          {/* Step cards — coloring keys off promptsPhase so the user sees
              the steps move from pending (gray) → running (purple) →
              done (green) alongside the Generate button below. */}
          <div className="space-y-2">
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
          </div>
          </div>

          {/* Idle / generating landing — Generate button replaces the
              tabs+beat list until the user explicitly kicks off the
              run. Once done, swap to the tabs/list and let them
              Regenerate via the button next to the Continue bar. */}
          {!isDone ? (
            <div className="px-5 sm:px-8 py-12 flex flex-col items-center justify-center gap-4">
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
            /* Tabs + content — pill tabs with count badges, beat list, all
               inside one white-bordered card. Mirrors the real step. */
            <div className="px-5 sm:px-8 pb-24">
              <div className="rounded-2xl overflow-hidden"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <div className="mx-5 sm:mx-8 mt-4 rounded-xl p-1 flex gap-1 w-fit"
                  style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
                  {([
                    { id: "image" as Tab, label: "Image Beats" },
                    { id: "video" as Tab, label: "Video Beats" },
                  ]).map((tab) => {
                    const active = activeTab === tab.id;
                    const count = DEMO_DATA.promptStepBeats.length;
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className="px-3 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5"
                        style={active ? {
                          background: "oklch(0.72 0.25 285 / 0.15)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                          color: "oklch(0.88 0.12 285)",
                        } : {
                          background: "transparent",
                          border: "1px solid transparent",
                          color: "var(--c-55)",
                        }}
                      >
                        {tab.label}
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] tabular-nums"
                          style={{
                            background: active ? "oklch(0.72 0.25 285 / 0.2)" : "var(--bg-panel)",
                            color: active ? "oklch(0.88 0.12 285)" : "var(--c-45)",
                          }}>
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="px-5 sm:px-8 pt-6 pb-6 space-y-3">
                  {DEMO_DATA.promptStepBeats.map((beat) => {
                    const key = `${beat.beat}-${activeTab}`;
                    const base = activeTab === "image" ? beat.imagePrompt : beat.videoPrompt;
                    const value = editedPrompts[key] ?? base;
                    const badge = activeTab === "image"
                      ? { bg: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" }
                      : { bg: "oklch(0.6 0.15 200 / 0.12)", color: "oklch(0.6 0.15 200)" };
                    return (
                      <div
                        key={beat.beat}
                        className="rounded-xl p-4 space-y-3 min-w-0"
                        style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0"
                            style={{ background: badge.bg, color: badge.color }}>
                            {beat.beat}
                          </span>
                          <p className="text-xs line-clamp-1" style={{ color: "var(--c-50)" }}>
                            {beat.imagePrompt}
                          </p>
                        </div>
                        <DemoEditablePrompt
                          value={value}
                          onSave={(v) => setEditedPrompts((prev) => ({ ...prev, [key]: v }))}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
        style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
        <div className="px-5 sm:px-8 flex gap-3">
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
