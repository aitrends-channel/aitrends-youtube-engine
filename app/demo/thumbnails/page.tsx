"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DemoStepCostCard } from "@/components/demo/DemoStepCostCard";
import { DemoStepBalanceCard } from "@/components/demo/DemoStepBalanceCard";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

const FAKE_IMAGE_MODELS = [
  { id: "i1", name: "FLUX 1.1 Pro",       tags: ["HD", "photorealistic"] },
  { id: "i2", name: "FLUX 1.1 Pro Ultra", tags: ["4K", "detail"] },
  { id: "i3", name: "FLUX Schnell",        tags: ["fast"] },
];

function StepBadge({ status, num }: { status: "idle" | "running" | "done"; num: number }) {
  return (
    <div
      className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold mt-0.5"
      style={
        status === "done"    ? { background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.7 0.15 145)" } :
        status === "running" ? { background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" } :
        { background: "var(--bg-progress)", color: "var(--c-30)" }
      }
    >
      {status === "done" ? "✓" : status === "running"
        ? <span className="block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
        : num}
    </div>
  );
}

export default function DemoThumbnailsPage() {
  const router = useRouter();
  const { state, update } = useDemoState();
  const [navigating, setNavigating] = useState(false);

  const {
    conceptPhase, thumbImagePhase: imagePhase,
    thumbImageProgress: imageProgress, thumbOffset,
    selectedThumbModel: selectedModel, selectedThumbRatio: selectedRatio,
  } = state;

  const allThumbs   = DEMO_DATA.thumbnailConcepts;
  const hasConcepts = conceptPhase === "done";
  const hasImages   = imagePhase === "done";

  // Set a random initial offset once (only on first concept generation)
  const didInitOffset = useRef(false);

  const thumbs = [0, 1, 2].map((i) => allThumbs[(thumbOffset + i) % allThumbs.length]);

  function generateConcepts() {
    if (!didInitOffset.current) {
      didInitOffset.current = true;
      update({ conceptPhase: "running", thumbOffset: Math.floor(Math.random() * allThumbs.length) });
    } else {
      update({ conceptPhase: "running" });
    }
    setTimeout(() => update({ conceptPhase: "done" }), 2000);
  }

  function generateImages() {
    update({ thumbImagePhase: "running", thumbImageProgress: 0, thumbOffset: (thumbOffset + 1) % allThumbs.length });
    let count = 0;
    const id = setInterval(() => {
      count++;
      update({ thumbImageProgress: count });
      if (count >= thumbs.length) { clearInterval(id); update({ thumbImagePhase: "done" }); }
    }, 700);
  }

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={8} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 overflow-y-auto lg:px-[15px]">

          {/* Header */}
          <div
            className="py-4 sm:py-5"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}
          >
            <h1 className="font-bold text-lg">Thumbnail Generator</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              AI-powered thumbnail concepts and images matched to your channel style
            </p>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <DemoStepCostCard column="thumbnail" />
              <DemoStepBalanceCard />
            </div>
          </div>

          <div className="py-4 sm:py-8 pb-24 sm:pb-24 space-y-6">

            {/* Step 1 — Concepts */}
            <div
              className="rounded-xl p-4 flex gap-4"
              style={{
                background: "var(--bg-panel)",
                border: `1px solid ${hasConcepts ? "oklch(0.55 0.15 145 / 0.25)" : conceptPhase === "running" ? "oklch(0.72 0.25 285 / 0.25)" : "var(--bd-7)"}`,
              }}
            >
              <StepBadge status={hasConcepts ? "done" : conceptPhase === "running" ? "running" : "idle"} num={1} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold mb-0.5" style={{ color: "var(--c-85)" }}>Generate Concepts</p>
                <p className="text-xs mb-2" style={{ color: "var(--c-40)" }}>
                  3 thumbnail concepts with text overlays, visual style, and image generation prompts
                </p>
                {hasConcepts && <p className="text-xs" style={{ color: "oklch(0.6 0.15 145)" }}>{thumbs.length} concepts ready</p>}
              </div>
              <div className="shrink-0 flex items-start">
                <button
                  onClick={generateConcepts}
                  disabled={conceptPhase === "running"}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-30 transition-opacity"
                  style={hasConcepts
                    ? { background: "var(--bg-progress)", color: "var(--c-50)", border: "1px solid var(--bd-8)" }
                    : { background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  {conceptPhase === "running" ? "Running…" : hasConcepts ? "Regenerate" : "Generate"}
                </button>
              </div>
            </div>

            {/* Step 2 — Images */}
            <div
              className="rounded-xl overflow-hidden"
              style={{
                background: "var(--bg-panel)",
                border: `1px solid ${hasImages ? "oklch(0.55 0.15 145 / 0.25)" : imagePhase === "running" ? "oklch(0.72 0.25 285 / 0.25)" : "var(--bd-7)"}`,
                opacity: hasConcepts ? 1 : 0.4,
              }}
            >
              <div className="p-4 flex gap-4">
                <StepBadge status={hasImages ? "done" : imagePhase === "running" ? "running" : "idle"} num={2} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold mb-0.5" style={{ color: "var(--c-85)" }}>Generate Images</p>
                  <p className="text-xs mb-2" style={{ color: "var(--c-40)" }}>
                    Generate an AI image for each concept using the style prompt
                  </p>
                  {imagePhase === "running" && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
                        <div
                          className="h-full rounded-full transition-all"
                          // Cap mid-run progress at 99% so the bar
                          // never reads 100% before every thumbnail
                          // has actually landed. Once imagePhase flips
                          // to "done" the bar isn't rendered anyway
                          // (this whole block is gated on running),
                          // so users only ever see 100% via the
                          // "X images generated" success state below.
                          style={{
                            width: `${Math.min(99, Math.round((imageProgress / thumbs.length) * 100))}%`,
                            background: "oklch(0.72 0.25 285)",
                          }}
                        />
                      </div>
                      <span className="text-xs shrink-0" style={{ color: "var(--c-40)" }}>{imageProgress}/{thumbs.length}</span>
                    </div>
                  )}
                  {hasImages && <p className="text-xs" style={{ color: "oklch(0.6 0.15 145)" }}>{thumbs.length} images generated</p>}
                </div>
                <div className="shrink-0 flex items-start">
                  <button
                    onClick={generateImages}
                    disabled={!hasConcepts || imagePhase === "running"}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-30 transition-opacity"
                    style={hasImages
                      ? { background: "var(--bg-progress)", color: "var(--c-50)", border: "1px solid var(--bd-8)" }
                      : { background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                  >
                    {imagePhase === "running" ? "Running…" : hasImages ? "Regenerate" : "Generate"}
                  </button>
                </div>
              </div>

              {hasConcepts && imagePhase !== "running" && (
                <div className="px-4 pb-4 space-y-3" style={{ borderTop: "1px solid var(--bd-6)" }}>
                  <p className="text-xs font-semibold uppercase tracking-wider pt-3" style={{ color: "var(--c-40)" }}>Image Model</p>
                  <div className="grid grid-cols-2 gap-2">
                    {FAKE_IMAGE_MODELS.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => update({ selectedThumbModel: m.id })}
                        className="text-left px-3 py-2 rounded-lg text-xs transition-all"
                        style={selectedModel === m.id ? {
                          background: "oklch(0.72 0.25 285 / 0.1)", border: "1px solid oklch(0.72 0.25 285 / 0.3)", color: "var(--c-88)",
                        } : { background: "var(--bg-input)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}
                      >
                        <p className="font-medium">{m.name}</p>
                        {m.tags.map((t) => (
                          <span key={t} className="inline-block mt-1 px-1.5 py-0.5 rounded text-xs mr-1"
                            style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>{t}</span>
                        ))}
                      </button>
                    ))}
                  </div>
                  <div>
                    <p className="text-xs mb-1.5" style={{ color: "var(--c-40)" }}>Aspect Ratio</p>
                    <div className="flex gap-1.5">
                      {["16:9", "9:16", "1:1"].map((r) => (
                        <button
                          key={r}
                          onClick={() => update({ selectedThumbRatio: r })}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
                          style={selectedRatio === r ? {
                            background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                          } : { background: "var(--bg-control)", color: "var(--c-50)", border: "1px solid var(--bd-8)" }}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Thumbnail cards */}
            {hasConcepts && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {thumbs.map((t) => (
                  <div key={t.position} className="rounded-xl overflow-hidden"
                    style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                    <div className="aspect-video w-full relative" style={{ background: "var(--bg-card-subtle)" }}>
                      {hasImages || (imagePhase === "running" && imageProgress > t.position - 1) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={t.imageUrl} alt={t.title} className="w-full h-full object-cover" />
                      ) : imagePhase === "running" && imageProgress === t.position - 1 ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                          <span className="w-5 h-5 rounded-full border-2 border-current border-t-transparent animate-spin"
                            style={{ color: "oklch(0.72 0.25 285)" }} />
                          <p className="text-xs" style={{ color: "var(--c-45)" }}>Generating…</p>
                        </div>
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <p className="text-xs" style={{ color: "var(--c-30)" }}>No image yet</p>
                        </div>
                      )}
                      <div className="absolute top-2 left-2 w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold"
                        style={{ background: "var(--bg-overlay)", color: "oklch(0.58 0.28 300)" }}>
                        {t.position}
                      </div>
                      {(hasImages || (imagePhase === "running" && imageProgress > t.position - 1)) && (
                        <a
                          href={t.imageUrl}
                          download={`thumbnail-${t.position}.png`}
                          className="absolute top-2 right-2 w-7 h-7 rounded-md flex items-center justify-center transition-all hover:opacity-80"
                          style={{ background: "var(--bg-overlay)", color: "oklch(0.95 0 0)" }}
                        >
                          <Download size={14} />
                        </a>
                      )}
                    </div>
                    <div className="p-4 space-y-3">
                      <p className="font-semibold text-sm">{t.title}</p>
                      <div className="space-y-2.5">
                        {[
                          { label: "Visual Concept",  value: t.visualConcept },
                          { label: "Text Overlay",    value: t.textOverlay, highlight: true },
                          { label: "Emotion Trigger", value: t.emotionTrigger },
                          { label: "Style Prompt",    value: t.stylePrompt },
                        ].map(({ label, value, highlight }) => (
                          <div key={label}>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-0.5" style={{ color: "var(--c-40)" }}>{label}</p>
                            <p className="text-xs leading-relaxed" style={{ color: highlight ? "var(--c-82)" : "var(--c-50)" }}>{value}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}


          </div>
        </main>
      </div>

      {/* Fixed Done bar */}
      {hasImages && (
        <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
          <div>
            <button
              onClick={() => { setNavigating(true); router.push("/dashboard"); }}
              disabled={navigating}
              className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-80"
              style={{ background: "oklch(0.55 0.15 145)", color: "var(--bg-page-2)" }}
            >
              {navigating && <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />}
              {navigating ? "Redirecting…" : "Done"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
