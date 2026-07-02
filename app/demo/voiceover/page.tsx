"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DemoStepCostCard } from "@/components/demo/DemoStepCostCard";
import { useDemoState } from "@/lib/demo-context";

// Curated voice library — same shape as the real workflow's voice
// picker. Only "Liam" is selectable in the demo so the user has a
// clearly-intended path through; the rest are dimmed but visible to
// signal the breadth of choices in the real product.
const FAKE_VOICES = [
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian",     tags: ["Male",   "Deep, Resonant"] },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura",     tags: ["Female", "Enthusiastic"] },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam",      tags: ["Male",   "Energetic"] },
  { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum",    tags: ["Male",   "Husky"] },
  { id: "EkK5I93UQWFDigLMpZcX", name: "James",     tags: ["Male",   "Bold, Engaging"] },
  { id: "Z3R5wn05IrDiVCyEkUrK", name: "Arabella",  tags: ["Female", "Mysterious"] },
  { id: "hpp4J3VqNfWAUOO0d1Us", name: "Bella",     tags: ["Female", "Warm, Professional"] },
  { id: "uYXf8XasLslADfZ2MB4u", name: "Hope",      tags: ["Female", "Bubbly, Energetic"] },
  { id: "gs0tAILXbY5DNrJrsM6F", name: "Jeff",      tags: ["Male",   "Classy, Strong"] },
  { id: "DTKMou8ccj1ZaWGBiotd", name: "Jamahal",   tags: ["Male",   "Vibrant, Natural"] },
  { id: "vBKc2FfBKJfcZNyEt1n6", name: "Finn",      tags: ["Male",   "Youthful, Eager"] },
  { id: "DYkrAHD8iwork3YSUBbs", name: "Tom",       tags: ["Male",   "Conversational"] },
  { id: "56AoDkrOh6qfVPDXZ7Pt", name: "Cassidy",   tags: ["Female", "Crisp, Direct"] },
  { id: "lcMyyd2HUfFzxdCaC4Ta", name: "Lucy",      tags: ["Female", "Fresh, Casual"] },
  { id: "6aDn1KB0hjpdcocrUkmq", name: "Tiffany",   tags: ["Female", "Natural, Welcoming"] },
  { id: "Sq93GQT4X1lKDXsQcixO", name: "Felix",     tags: ["Male",   "Warm, Positive"] },
  { id: "LruHrtVF6PSyGItzMNHS", name: "Benjamin",  tags: ["Male",   "Deep, Calming"] },
  { id: "1wGbFxmAM3Fgw63G1zZJ", name: "Allison",   tags: ["Female", "Calm, Soothing"] },
  { id: "MJ0RnG71ty4LH3dvNfSd", name: "Leon",      tags: ["Male",   "Soothing, Grounded"] },
  { id: "NNl6r8mD7vthiJatiJt1", name: "Bradford",  tags: ["Male",   "Expressive"] },
  { id: "Sm1seazb4gs7RSlUVw7c", name: "Anika",     tags: ["Female", "Animated, Friendly"] },
  { id: "5l5f8iK3YPeGga21rQIX", name: "Adeline",   tags: ["Female", "Conversational"] },
  { id: "aD6riP1btT197c6dACmy", name: "Rachel M",  tags: ["Female", "British, Radio"] },
  { id: "AeRdCCKzvd23BpJoofzx", name: "Nathaniel", tags: ["Male",   "British, Calm"] },
  { id: "BZgkqPqms7Kj9ulSkVzn", name: "Eve",       tags: ["Female", "Authentic, Happy"] },
  { id: "6F5Zhi321D3Oq7v1oNT4", name: "Hank",      tags: ["Male",   "Deep, Narrator"] },
  { id: "pPdl9cQBQq4p6mRkZy2Z", name: "Emma",      tags: ["Female", "Adorable, Upbeat"] },
  { id: "nzeAacJi50IvxcyDnMXa", name: "Marshal",   tags: ["Male",   "Friendly, Warm"] },
];

export default function DemoVoiceoverPage() {
  const router = useRouter();
  const { state, update } = useDemoState();
  const { selectedVoice, ttsPhase } = state;
  const [navigating, setNavigating] = useState(false);
  // Force the <audio> element to re-fetch its source when the phase
  // flips into "done" after Generate/Regen. Chrome renders the controls
  // but leaves the media unloaded — timer stuck at --:-- and pressing
  // play does nothing — unless we (a) mount the element fresh via a
  // changing key, and (b) call .load() from a callback ref the moment
  // the element attaches to the DOM. The earlier useEffect-only fix
  // raced with mount and sometimes ran with a null ref.
  const [audioReloadTick, setAudioReloadTick] = useState(0);
  useEffect(() => {
    if (ttsPhase === "done") setAudioReloadTick((t) => t + 1);
  }, [ttsPhase]);
  const attachAudio = (el: HTMLAudioElement | null) => {
    if (el) el.load();
  };
  // Voices have gender as their first tag ("Male" or "Female"). The
  // tab state lives locally — picking a gender just filters the visible
  // grid, it doesn't alter selectedVoice, so a user can pick Liam under
  // Male and then peek at Female without losing their selection.
  const [voiceTab, setVoiceTab] = useState<"male" | "female">("male");
  const filteredVoices = FAKE_VOICES.filter((v) =>
    voiceTab === "male" ? v.tags[0] === "Male" : v.tags[0] === "Female"
  );

  function generateVoiceover() {
    update({ ttsPhase: "generating" });
    setTimeout(() => update({ ttsPhase: "done" }), 2500);
  }

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={5} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 overflow-y-auto">
          {/* Header */}
          <div
            className="py-4 sm:py-5"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}
          >
            <h1 className="font-bold text-lg">Voiceover</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Pick a voice and generate the narration for your script
            </p>
            <div className="mt-3">
              <DemoStepCostCard column="voiceover" />
            </div>
          </div>

          <div className="py-4 sm:py-8 pb-24 space-y-6">

            {/* Voice picker */}
            <div className="rounded-2xl p-5 space-y-4"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <div>
                <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
                    Select Voice
                  </p>
                  {/* Gender tabs — purely a filter on the visible grid;
                      selectedVoice persists across switches so the user
                      doesn't lose a pick when peeking at the other tab. */}
                  <div className="inline-flex p-0.5 rounded-lg" style={{ background: "var(--bg-track)" }}>
                    {(["male", "female"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setVoiceTab(tab)}
                        className="px-3 py-1 rounded-md text-xs font-medium capitalize transition-all"
                        style={voiceTab === tab ? {
                          background: "oklch(0.72 0.25 285 / 0.15)",
                          color: "oklch(0.88 0.12 285)",
                          boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.35)",
                        } : { background: "transparent", color: "var(--c-55)" }}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-96 overflow-y-auto pr-1">
                  {filteredVoices.map((v) => {
                    // Same demo gating as the original generate-page
                    // voiceover column — only Liam is interactive so
                    // the demo has one clearly-intended path through.
                    const isSelectable = v.name === "Liam";
                    const isSelected = selectedVoice === v.id;
                    return (
                      <div
                        key={v.id}
                        role={isSelectable ? "button" : undefined}
                        onClick={isSelectable ? () => update({ selectedVoice: v.id }) : undefined}
                        className="p-3 rounded-xl transition-all select-none"
                        style={{
                          cursor: isSelectable ? "pointer" : "default",
                          opacity: isSelectable ? 1 : 0.35,
                          ...(isSelected ? {
                            background: "oklch(0.72 0.25 285 / 0.1)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                            color: "var(--c-90)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-7)",
                            color: "var(--c-60)",
                          }),
                        }}
                      >
                        <p className="font-medium text-xs">{v.name}</p>
                        <div className="flex gap-1 mt-1.5 flex-wrap">
                          {v.tags.map((tag) => (
                            <span key={tag} className="px-1.5 py-0.5 rounded text-xs"
                              style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Generate / Result panel */}
            <div className="rounded-2xl p-5 space-y-3"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              {ttsPhase === "done" ? (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Original</span>
                      <a href="/demo/voiceover/voiceover.mp3" download="voiceover.mp3"
                        className="text-xs" style={{ color: "var(--c-45)" }}>↓ Download</a>
                    </div>
                    <audio
                      key={audioReloadTick}
                      ref={attachAudio}
                      controls
                      src="/demo/voiceover/voiceover.mp3"
                      preload="auto"
                      className="w-full h-8"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button disabled
                      className="flex-1 py-2 rounded-lg text-xs font-medium opacity-40"
                      style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}>
                      Trim Pauses
                    </button>
                    <button onClick={generateVoiceover}
                      className="px-3 py-2 rounded-lg text-xs"
                      style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}>
                      Regen
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={generateVoiceover}
                  disabled={ttsPhase === "generating"}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  {ttsPhase === "generating" ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Generating voiceover…
                    </span>
                  ) : "Generate Voiceover"}
                </button>
              )}
            </div>
          </div>
        </main>

        {/* Fixed Continue bar */}
        <div
          className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}
        >
          <div>
            <button
              onClick={() => { setNavigating(true); setTimeout(() => router.push("/demo/generate"), 500); }}
              disabled={ttsPhase !== "done" || navigating}
              className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
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
    </div>
  );
}
