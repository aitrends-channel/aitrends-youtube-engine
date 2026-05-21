"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";

const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
type AspectRatio = typeof ASPECT_RATIOS[number];

const RESOLUTION: Record<AspectRatio, string> = {
  "16:9": "1920 × 1080",
  "9:16": "1080 × 1920",
  "1:1":  "1080 × 1080",
};

const CAPTION_STYLES = [
  { id: "classic", label: "Classic", hint: "White, black outline" },
  { id: "bold",    label: "Bold",    hint: "Yellow, bold" },
  { id: "boxed",   label: "Boxed",   hint: "White on dark box" },
  { id: "minimal", label: "Minimal", hint: "White, thin outline" },
];

const CAPTION_SIZES     = [{ id: "small", label: "S" }, { id: "medium", label: "M" }, { id: "large", label: "L" }];
const CAPTION_POSITIONS = [{ id: "bottom", label: "Bottom" }, { id: "top", label: "Top" }];

const CAPTION_LANGUAGES = [
  { code: "source",     label: "Source language" },
  { code: "Spanish",    label: "Spanish" },
  { code: "French",     label: "French" },
  { code: "Portuguese", label: "Portuguese" },
  { code: "German",     label: "German" },
  { code: "Italian",    label: "Italian" },
  { code: "Japanese",   label: "Japanese" },
  { code: "Korean",     label: "Korean" },
  { code: "Chinese",    label: "Chinese" },
  { code: "Hindi",      label: "Hindi" },
  { code: "Arabic",     label: "Arabic" },
];

const ASSEMBLE_STEPS = [
  "Transcribing voiceover…",
  "Aligning clips to narration timing…",
  "Applying captions…",
  "Rendering final video…",
  "Uploading…",
];

const FAKE_IMAGE_MODELS = [
  { id: "i1", name: "FLUX 1.1 Pro",       tags: ["HD", "photorealistic"] },
  { id: "i2", name: "FLUX 1.1 Pro Ultra", tags: ["4K", "detail"] },
  { id: "i3", name: "FLUX Schnell",        tags: ["fast"] },
];

function SelectButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className="px-4 py-2 rounded-xl text-xs font-medium transition-all"
      style={active ? {
        background: "oklch(0.72 0.25 285 / 0.15)",
        border: "1px solid oklch(0.72 0.25 285 / 0.4)",
        color: "oklch(0.88 0.12 285)",
      } : {
        background: "var(--bg-input)",
        border: "1px solid var(--bd-7)",
        color: "var(--c-50)",
      }}>
      {children}
    </button>
  );
}

function StepBadge({ status, num }: { status: "idle" | "running" | "done" | "error"; num: number }) {
  return (
    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold mt-0.5"
      style={
        status === "done"    ? { background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.7 0.15 145)" } :
        status === "running" ? { background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" } :
        { background: "var(--bg-progress)", color: "var(--c-30)" }
      }>
      {status === "done" ? "✓" : status === "running"
        ? <span className="block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
        : num}
    </div>
  );
}

export default function DemoAssemblePage() {
  const router = useRouter();

  // Assembly settings
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [voiceoverType, setVoiceoverType] = useState<"original" | "trimmed">("original");
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captionsStyle, setCaptionsStyle]     = useState("classic");
  const [captionsSize, setCaptionsSize]       = useState("medium");
  const [captionsPosition, setCaptionsPosition] = useState("bottom");
  const [captionsLanguage, setCaptionsLanguage] = useState("source");

  // Assembly state
  const [assemblePhase, setAssemblePhase] = useState<"idle" | "assembling" | "done">("idle");
  const [assembleMsg, setAssembleMsg]     = useState("");

  // Thumbnail state
  const [conceptPhase, setConceptPhase]   = useState<"idle" | "running" | "done">("idle");
  const [imagePhase, setImagePhase]       = useState<"idle" | "running" | "done">("idle");
  const [imageProgress, setImageProgress] = useState(0);
  const [selectedModel, setSelectedModel] = useState("i1");
  const [selectedRatio, setSelectedRatio] = useState("16:9");

  // Next video
  const [nextTopic, setNextTopic] = useState("");

  const totalBeats = DEMO_DATA.promptBeats.length;
  const thumbs     = DEMO_DATA.thumbnailConcepts;

  function assemble() {
    setAssemblePhase("assembling");
    let i = 0;
    setAssembleMsg(ASSEMBLE_STEPS[0]);
    const id = setInterval(() => {
      i++;
      if (i < ASSEMBLE_STEPS.length) {
        setAssembleMsg(ASSEMBLE_STEPS[i]);
      } else {
        clearInterval(id);
        setAssemblePhase("done");
        setAssembleMsg("");
      }
    }, 1000);
  }

  function generateConcepts() {
    setConceptPhase("running");
    setTimeout(() => setConceptPhase("done"), 2000);
  }

  function generateImages() {
    setImagePhase("running");
    setImageProgress(0);
    let count = 0;
    const id = setInterval(() => {
      count++;
      setImageProgress(count);
      if (count >= thumbs.length) { clearInterval(id); setImagePhase("done"); }
    }, 700);
  }

  const hasConcepts = conceptPhase === "done";
  const hasImages   = imagePhase === "done";

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={6} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner onSubscribe={() => router.push("/dashboard")} />
        <main className="flex-1 overflow-y-auto">

          {/* Header */}
          <div className="px-8 py-5"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
            <h1 className="font-bold text-lg">Assemble Final Video</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Transcribes your voiceover to align each clip to the exact narration timing
            </p>
          </div>

          <div className="p-8 flex gap-6 items-start">
            <div className="flex-1 min-w-0 max-w-2xl space-y-6">

              {/* Status cards */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Voiceover", value: "Original", color: "oklch(0.72 0.25 285)" },
                  { label: "Video Clips", value: `${totalBeats} / ${totalBeats}`, color: "oklch(0.72 0.25 285)" },
                  { label: "Output", value: RESOLUTION[aspectRatio], color: "var(--c-65)" },
                ].map(({ label, value, color }) => (
                  <div key={label} className="p-4 rounded-2xl" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                    <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>{label}</p>
                    <p className="mt-2 text-sm font-medium" style={{ color }}>{value}</p>
                  </div>
                ))}
              </div>

              {/* Aspect ratio */}
              <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--c-40)" }}>Output Aspect Ratio</p>
                <div className="flex gap-2">
                  {ASPECT_RATIOS.map((r) => (
                    <SelectButton key={r} active={aspectRatio === r} onClick={() => setAspectRatio(r)}>{r}</SelectButton>
                  ))}
                </div>
              </div>

              {/* Voiceover source */}
              <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--c-40)" }}>Voiceover Source</p>
                <div className="flex gap-2">
                  <button onClick={() => setVoiceoverType("original")}
                    className="flex-1 py-2 rounded-xl text-xs font-medium transition-all"
                    style={voiceoverType === "original" ? {
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                      color: "oklch(0.88 0.12 285)",
                    } : {
                      background: "var(--bg-input)", border: "1px solid var(--bd-7)", color: "var(--c-50)",
                    }}>
                    Original
                  </button>
                  <button onClick={() => setVoiceoverType("trimmed")} disabled
                    className="flex-1 py-2 rounded-xl text-xs font-medium opacity-35"
                    style={{ background: "var(--bg-input)", border: "1px solid var(--bd-7)", color: "var(--c-30)" }}>
                    Trimmed — unavailable
                  </button>
                </div>
              </div>

              {/* Captions */}
              <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <p className="text-sm font-semibold">Captions</p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>Burned into the video — always visible</p>
                  </div>
                  <button onClick={() => setCaptionsEnabled((v) => !v)}
                    className="relative w-11 h-6 rounded-full transition-all shrink-0"
                    style={{ background: captionsEnabled ? "oklch(0.72 0.25 285)" : "var(--c-22)", border: "1px solid var(--bd-10)" }}>
                    <span className="absolute top-0.5 w-5 h-5 rounded-full transition-all"
                      style={{ background: "oklch(0.95 0 0)", left: captionsEnabled ? "calc(100% - 1.375rem)" : "0.125rem" }} />
                  </button>
                </div>

                {captionsEnabled && (
                  <div className="space-y-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Style</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {CAPTION_STYLES.map((s) => (
                          <button key={s.id} onClick={() => setCaptionsStyle(s.id)}
                            className="py-2 px-3 rounded-xl text-left transition-all"
                            style={captionsStyle === s.id ? {
                              background: "oklch(0.72 0.25 285 / 0.15)", border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                            } : { background: "var(--bg-input)", border: "1px solid var(--bd-7)" }}>
                            <p className="text-xs font-medium" style={{ color: captionsStyle === s.id ? "oklch(0.88 0.12 285)" : "var(--c-60)" }}>{s.label}</p>
                            <p className="text-xs mt-0.5" style={{ color: "var(--c-38)" }}>{s.hint}</p>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex gap-4">
                      <div className="flex-1">
                        <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Size</p>
                        <div className="flex gap-1.5">
                          {CAPTION_SIZES.map((s) => (
                            <button key={s.id} onClick={() => setCaptionsSize(s.id)}
                              className="flex-1 py-1.5 rounded-xl text-xs font-semibold transition-all"
                              style={captionsSize === s.id ? {
                                background: "oklch(0.72 0.25 285 / 0.15)", border: "1px solid oklch(0.72 0.25 285 / 0.4)", color: "oklch(0.88 0.12 285)",
                              } : { background: "var(--bg-input)", border: "1px solid var(--bd-7)", color: "var(--c-50)" }}>
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex-1">
                        <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Position</p>
                        <div className="flex gap-1.5">
                          {CAPTION_POSITIONS.map((p) => (
                            <button key={p.id} onClick={() => setCaptionsPosition(p.id)}
                              className="flex-1 py-1.5 rounded-xl text-xs font-medium transition-all"
                              style={captionsPosition === p.id ? {
                                background: "oklch(0.72 0.25 285 / 0.15)", border: "1px solid oklch(0.72 0.25 285 / 0.4)", color: "oklch(0.88 0.12 285)",
                              } : { background: "var(--bg-input)", border: "1px solid var(--bd-7)", color: "var(--c-50)" }}>
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Language</p>
                      <div className="flex flex-wrap gap-1.5">
                        {CAPTION_LANGUAGES.map((lang) => (
                          <button key={lang.code} onClick={() => setCaptionsLanguage(lang.code)}
                            className="px-3 py-1.5 rounded-xl text-xs font-medium transition-all"
                            style={captionsLanguage === lang.code ? {
                              background: "oklch(0.72 0.25 285 / 0.15)", border: "1px solid oklch(0.72 0.25 285 / 0.4)", color: "oklch(0.88 0.12 285)",
                            } : { background: "var(--bg-input)", border: "1px solid var(--bd-7)", color: "var(--c-50)" }}>
                            {lang.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Assembly controls */}
              <div className="rounded-2xl p-5 space-y-4" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                {assemblePhase === "done" && (
                  <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
                    <video src={DEMO_DATA.promptBeats[0].videoUrl} controls muted loop
                      className="w-full rounded-xl" style={{ aspectRatio: "16/9", display: "block" }} />
                  </div>
                )}

                {assemblePhase === "assembling" && (
                  <div className="space-y-3">
                    <p className="text-xs text-center" style={{ color: "var(--c-55)" }}>{assembleMsg}</p>
                    <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                      <div className="h-full rounded-full animate-pulse"
                        style={{ width: "60%", background: "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))" }} />
                    </div>
                    <p className="text-xs text-center" style={{ color: "var(--c-35)" }}>Progress updates every ~5 seconds…</p>
                  </div>
                )}

                {assemblePhase === "done" ? (
                  <div className="flex gap-2">
                    <button onClick={assemble}
                      className="flex-1 py-2.5 rounded-xl text-xs font-medium transition-all"
                      style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}>
                      Reassemble
                    </button>
                    <button
                      onClick={() => router.push("/demo/finish")}
                      className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-center transition-all hover:opacity-90"
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                      Continue →
                    </button>
                  </div>
                ) : (
                  <button onClick={assemble} disabled={assemblePhase === "assembling"}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                    {assemblePhase === "assembling" ? "Assembling…" : "Assemble Final Video"}
                  </button>
                )}
              </div>

              {/* ── Thumbnails ── */}
              <div className="space-y-4">
                <div className="flex items-center gap-3 pt-2">
                  <div className="flex-1 h-px" style={{ background: "var(--bd-7)" }} />
                  <p className="text-xs font-semibold uppercase tracking-wider px-2" style={{ color: "var(--c-40)" }}>Thumbnails</p>
                  <div className="flex-1 h-px" style={{ background: "var(--bd-7)" }} />
                </div>

                {/* Thumbnail cards */}
                {hasConcepts && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {thumbs.map((t) => (
                      <div key={t.position} className="rounded-xl overflow-hidden"
                        style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                        <div className="aspect-video w-full relative" style={{ background: "var(--bg-card-subtle)" }}>
                          {hasImages || (imagePhase === "running" && imageProgress > t.position - 1) ? (
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
                        </div>
                        <div className="p-4 space-y-3">
                          <p className="font-semibold text-sm">{t.title}</p>
                          <div className="space-y-2.5">
                            {[
                              { label: "Visual Concept", value: t.visualConcept },
                              { label: "Text Overlay",   value: t.textOverlay, highlight: true },
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

                {/* Step 1 — Concepts */}
                <div className="rounded-xl p-4 flex gap-4"
                  style={{
                    background: "var(--bg-panel)",
                    border: `1px solid ${hasConcepts ? "oklch(0.55 0.15 145 / 0.25)" : conceptPhase === "running" ? "oklch(0.72 0.25 285 / 0.25)" : "var(--bd-7)"}`,
                  }}>
                  <StepBadge status={hasConcepts ? "done" : conceptPhase === "running" ? "running" : "idle"} num={1} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold mb-0.5" style={{ color: "var(--c-85)" }}>Generate Concepts</p>
                    <p className="text-xs mb-2" style={{ color: "var(--c-40)" }}>
                      3 thumbnail concepts with text overlays, visual style, and image generation prompts
                    </p>
                    {hasConcepts && <p className="text-xs" style={{ color: "oklch(0.6 0.15 145)" }}>{thumbs.length} concepts ready</p>}
                  </div>
                  <div className="shrink-0 flex items-start">
                    <button onClick={generateConcepts} disabled={conceptPhase === "running"}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-30 transition-opacity"
                      style={hasConcepts
                        ? { background: "var(--bg-progress)", color: "var(--c-50)", border: "1px solid var(--bd-8)" }
                        : { background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                      {conceptPhase === "running" ? "Running…" : hasConcepts ? "Regenerate" : "Generate"}
                    </button>
                  </div>
                </div>

                {/* Step 2 — Images */}
                <div className="rounded-xl overflow-hidden"
                  style={{
                    background: "var(--bg-panel)",
                    border: `1px solid ${hasImages ? "oklch(0.55 0.15 145 / 0.25)" : imagePhase === "running" ? "oklch(0.72 0.25 285 / 0.25)" : "var(--bd-7)"}`,
                    opacity: hasConcepts ? 1 : 0.4,
                  }}>
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
                            <div className="h-full rounded-full transition-all"
                              style={{ width: `${Math.round((imageProgress / thumbs.length) * 100)}%`, background: "oklch(0.72 0.25 285)" }} />
                          </div>
                          <span className="text-xs shrink-0" style={{ color: "var(--c-40)" }}>{imageProgress}/{thumbs.length}</span>
                        </div>
                      )}
                      {hasImages && <p className="text-xs" style={{ color: "oklch(0.6 0.15 145)" }}>{thumbs.length} images generated</p>}
                    </div>
                    <div className="shrink-0 flex items-start">
                      <button onClick={generateImages} disabled={!hasConcepts || imagePhase === "running"}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-30 transition-opacity"
                        style={hasImages
                          ? { background: "var(--bg-progress)", color: "var(--c-50)", border: "1px solid var(--bd-8)" }
                          : { background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                        {imagePhase === "running" ? "Running…" : hasImages ? "Regenerate" : "Generate"}
                      </button>
                    </div>
                  </div>

                  {hasConcepts && imagePhase !== "running" && (
                    <div className="px-4 pb-4 space-y-3" style={{ borderTop: "1px solid var(--bd-6)" }}>
                      <p className="text-xs font-semibold uppercase tracking-wider pt-3" style={{ color: "var(--c-40)" }}>Image Model</p>
                      <div className="grid grid-cols-2 gap-2">
                        {FAKE_IMAGE_MODELS.map((m) => (
                          <button key={m.id} onClick={() => setSelectedModel(m.id)}
                            className="text-left px-3 py-2 rounded-lg text-xs transition-all"
                            style={selectedModel === m.id ? {
                              background: "oklch(0.72 0.25 285 / 0.1)", border: "1px solid oklch(0.72 0.25 285 / 0.3)", color: "var(--c-88)",
                            } : { background: "var(--bg-input)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}>
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
                            <button key={r} onClick={() => setSelectedRatio(r)}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
                              style={selectedRatio === r ? {
                                background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                              } : { background: "var(--bg-control)", color: "var(--c-50)", border: "1px solid var(--bd-8)" }}>
                              {r}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

            </div>{/* end left column */}

            {/* ── Right sidebar: Next Video ── */}
            <div className="w-80 shrink-0 sticky top-8">
              <div className="rounded-2xl p-5 space-y-4" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <div>
                  <p className="text-sm font-semibold">Start Your Next Video</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                    Same channel — pick a topic and jump straight to the script
                  </p>
                </div>

                <div className="space-y-1 max-h-52 overflow-y-auto pr-0.5">
                  {DEMO_DATA.videoIdeas.slice(1).map((idea, i) => (
                    <button key={i} onClick={() => setNextTopic(idea)}
                      className="w-full text-left px-3 py-2.5 rounded-xl text-xs transition-all"
                      style={nextTopic === idea ? {
                        background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.35)", color: "var(--c-90)",
                      } : { background: "var(--bg-input)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}>
                      <span className="font-mono text-[9px] mr-2" style={{ color: "oklch(0.72 0.25 285 / 0.5)" }}>
                        {String(i + 2).padStart(2, "0")}
                      </span>
                      {idea}
                    </button>
                  ))}
                </div>

                <input
                  type="text"
                  value={nextTopic}
                  onChange={(e) => setNextTopic(e.target.value)}
                  placeholder="Or type a custom topic…"
                  className="w-full px-3 py-2.5 rounded-xl text-sm outline-none transition-all"
                  style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
                />

                <div className="flex flex-col gap-2">
                  <button onClick={() => router.push("/dashboard")}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                    Subscribe to Start Next Video →
                  </button>
                </div>
              </div>
            </div>

          </div>
        </main>
      </div>
    </div>
  );
}
