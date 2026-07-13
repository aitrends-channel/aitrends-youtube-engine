"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DemoStepCostCard } from "@/components/demo/DemoStepCostCard";
import { DemoStepBalanceCard } from "@/components/demo/DemoStepBalanceCard";
import { useDemoState } from "@/lib/demo-context";

type VoiceTab = "female" | "male" | "free";

// Curated voice library — same shape as the real workflow's voice picker.
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

type Voice = (typeof FAKE_VOICES)[number];

// Voice card — mirrors the real step's VoiceOption (name + tags, subtle
// default border, violet highlight when selected).
function VoiceOption({ voice, selected, onSelect }: { voice: Voice; selected: boolean; onSelect: () => void }) {
  return (
    <div
      role="button"
      onClick={onSelect}
      className="cursor-pointer p-3 rounded-xl transition-all select-none"
      style={selected ? {
        background: "oklch(0.72 0.25 285 / 0.1)",
        border: "1px solid oklch(0.72 0.25 285 / 0.3)",
        color: "var(--c-90)",
      } : {
        background: "var(--bg-input)",
        border: "1px solid var(--bd-7)",
        color: "var(--c-60)",
      }}
    >
      <div className="flex items-center gap-2">
        <p className="font-medium text-xs flex-1 truncate">{voice.name}</p>
        {/* Preview play — present to mirror the real step but disabled in the
            demo (no preview audio to stream here). */}
        <button
          type="button"
          disabled
          onClick={(e) => e.stopPropagation()}
          title="Voice preview is available in the full app"
          aria-label="Preview voice"
          className="w-6 h-6 rounded flex items-center justify-center shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: "oklch(0.2 0 0)", color: "var(--c-45)", border: "1px solid var(--bd-10)" }}
        >
          <svg width="7" height="9" viewBox="0 0 7 9" fill="currentColor">
            <path d="M0 0.5L7 4.5L0 8.5V0.5Z" />
          </svg>
        </button>
      </div>
      <div className="flex gap-1 mt-1.5 flex-wrap">
        {voice.tags.map((tag) => (
          <span key={tag} className="px-1.5 py-0.5 rounded text-xs"
            style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function DemoVoiceoverPage() {
  const router = useRouter();
  const { state, update } = useDemoState();
  const { selectedVoice, ttsPhase } = state;
  const [navigating, setNavigating] = useState(false);

  // Force the <audio> element to re-fetch its source when the phase flips
  // into "done" after Generate/Regen (Chrome leaves the media unloaded
  // otherwise). Mount fresh via a changing key + .load() on attach.
  const [audioReloadTick, setAudioReloadTick] = useState(0);
  useEffect(() => {
    if (ttsPhase === "done") setAudioReloadTick((t) => t + 1);
  }, [ttsPhase]);
  const attachAudio = (el: HTMLAudioElement | null) => { if (el) el.load(); };

  // Gender / Free tabs — the tab is just a filter on the visible grid;
  // selectedVoice persists across switches. Defaults to female to match
  // the real step (the currently-selected Liam sits under Male).
  const [voiceTab, setVoiceTab] = useState<VoiceTab>("female");
  const [voiceSearch, setVoiceSearch] = useState("");

  const filteredVoices = FAKE_VOICES.filter((v) => {
    if (voiceTab === "free") return false;
    const gender = v.tags[0];
    if (voiceTab === "male" ? gender !== "Male" : gender !== "Female") return false;
    const q = voiceSearch.trim().toLowerCase();
    if (!q) return true;
    return v.name.toLowerCase().includes(q) || v.tags.some((t) => t.toLowerCase().includes(q));
  });

  const selectedVoiceModel = FAKE_VOICES.find((v) => v.id === selectedVoice) ?? null;

  function generateVoiceover() {
    if (!selectedVoice) return;
    update({ ttsPhase: "generating" });
    setTimeout(() => update({ ttsPhase: "done" }), 2500);
  }

  const isGenerating = ttsPhase === "generating";
  const isDone = ttsPhase === "done";

  return (
    <div className="flex h-screen overflow-x-hidden" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={5} />
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 overflow-y-auto lg:px-[15px]">
          {/* Header */}
          <div
            className="px-5 sm:px-8 py-4 sm:py-5"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}
          >
            <h1 className="font-bold text-base sm:text-lg">Voiceover</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Pick a voice and generate the narration for your script
            </p>
            <div className="mt-3 flex items-center gap-2">
              <DemoStepCostCard column="voiceover" />
              <DemoStepBalanceCard />
            </div>
          </div>

          <div className="px-5 py-4 sm:p-8 pb-24 mb-[70px] space-y-6">

            {/* Voice picker */}
            <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
                  Voice
                </p>
                {voiceTab !== "free" && (
                  <span className="text-[11px] font-mono tabular-nums" style={{ color: "var(--c-45)" }}>
                    {FAKE_VOICES.length} voices · {filteredVoices.length} {voiceTab}
                  </span>
                )}
              </div>

              {/* Gender / Free tabs */}
              <div className="flex gap-1 mb-2">
                {(["female", "male", "free"] as VoiceTab[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => { setVoiceTab(tab); setVoiceSearch(""); }}
                    disabled={isGenerating}
                    className="flex-1 px-2 py-1.5 rounded-lg text-xs font-medium capitalize transition-all disabled:opacity-40"
                    style={tab === "free" ? {
                      background: "var(--primary)",
                      border: "1px solid var(--primary)",
                      color: "var(--primary-foreground)",
                    } : voiceTab === tab ? {
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                      color: "oklch(0.88 0.12 285)",
                    } : {
                      background: "var(--bg-input)",
                      border: "1px solid var(--bd-card)",
                      color: "var(--c-50)",
                    }}
                  >
                    {tab === "free" ? (
                      <span className="flex flex-col items-center leading-tight">
                        <span>😄 Free</span>
                        <span className="text-[9px] font-semibold normal-case">coming soon</span>
                      </span>
                    ) : tab}
                  </button>
                ))}
              </div>

              {voiceTab === "free" ? (
                <div className="rounded-xl px-4 py-8 text-center"
                  style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}>
                  <p className="text-base font-bold" style={{ color: "var(--primary)" }}>
                    Great Good News!
                  </p>
                  <p className="text-sm font-medium mt-2" style={{ color: "var(--c-70)" }}>
                    Thank you for choosing us and for being part of our journey.
                  </p>
                  <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--c-45)" }}>
                    We&apos;re building free resources to help you streamline your
                    production, reduce costs, and achieve more with less. Stay with
                    us as we continue to grow into the one-stop solution you&apos;ve
                    been looking for.
                  </p>
                </div>
              ) : (
                <>
                  {/* Search — full width, filters the active tab by name/tag. */}
                  <input
                    type="search"
                    value={voiceSearch}
                    onChange={(e) => setVoiceSearch(e.target.value)}
                    placeholder={`Search ${voiceTab} voices…`}
                    aria-label="Search voices"
                    className="w-full px-2.5 py-1.5 rounded-lg text-xs outline-none transition-colors mb-3 text-zinc-900 placeholder:text-black"
                    style={{ background: "#ecf0f1", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                  />
                  {voiceSearch.trim() && filteredVoices.length === 0 && (
                    <p className="text-xs text-center py-4" style={{ color: "var(--c-40)" }}>
                      No voices match &ldquo;{voiceSearch.trim()}&rdquo;
                    </p>
                  )}
                  <div className="scroll-themed grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
                    {filteredVoices.length === 0 && !voiceSearch.trim() && (
                      <p className="text-xs px-1" style={{ color: "var(--c-40)" }}>No {voiceTab} voices available</p>
                    )}
                    {filteredVoices.map((v) => (
                      <VoiceOption
                        key={v.id}
                        voice={v}
                        selected={selectedVoice === v.id}
                        onSelect={() => update({ selectedVoice: v.id })}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Generation / result panel */}
            <div className="rounded-2xl p-5 space-y-3" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              {/* Selected-voice banner — mirrors the real bulk panel so the
                  user always sees which voice the narration will use. */}
              <div className="rounded-xl px-3 py-2.5 flex items-center gap-2 text-xs"
                style={{ background: "oklch(0.72 0.25 285 / 0.08)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}>
                <span style={{ color: "var(--c-45)" }}>Voice:</span>
                {selectedVoiceModel ? (
                  <span className="font-semibold" style={{ color: "oklch(0.88 0.12 285)" }}>
                    {selectedVoiceModel.name} · {selectedVoiceModel.tags[0].toLowerCase()}
                  </span>
                ) : (
                  <span style={{ color: "var(--c-45)" }}>none selected</span>
                )}
              </div>

              {isDone ? (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Narration</span>
                      <a href="/demo/voiceover/voiceover.mp3" download="voiceover.mp3"
                        className="text-xs" style={{ color: "var(--c-45)" }}>↓ Export MP3</a>
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
                      Regenerate
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={generateVoiceover}
                  disabled={isGenerating || !selectedVoice}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  {isGenerating ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Generating voiceover…
                    </span>
                  ) : !selectedVoice ? "Select a voice first" : "Generate Voiceover"}
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
          <div className="lg:px-[15px]">
          <div className="px-5 sm:px-8">
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
    </div>
  );
}
