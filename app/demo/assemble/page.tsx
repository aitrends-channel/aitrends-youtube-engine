"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

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

export default function DemoAssemblePage() {
  const router = useRouter();
  const { state, update } = useDemoState();

  const {
    aspectRatio, voiceoverType,
    captionsEnabled, captionsStyle, captionsSize, captionsPosition, captionsLanguage,
    assemblePhase,
  } = state;

  const [assembleMsg, setAssembleMsg] = useState("");
  const [navigating, setNavigating] = useState(false);

  const totalBeats = DEMO_DATA.promptBeats.length;

  function assemble() {
    update({ assemblePhase: "assembling" });
    let i = 0;
    setAssembleMsg(ASSEMBLE_STEPS[0]);
    const id = setInterval(() => {
      i++;
      if (i < ASSEMBLE_STEPS.length) {
        setAssembleMsg(ASSEMBLE_STEPS[i]);
      } else {
        clearInterval(id);
        update({ assemblePhase: "done" });
        setAssembleMsg("");
      }
    }, 1000);
  }

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={6} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner />
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
                    <SelectButton key={r} active={aspectRatio === r} onClick={() => update({ aspectRatio: r })}>{r}</SelectButton>
                  ))}
                </div>
              </div>

              {/* Voiceover source */}
              <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--c-40)" }}>Voiceover Source</p>
                <div className="flex gap-2">
                  <button onClick={() => update({ voiceoverType: "original" })}
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
                  <button onClick={() => update({ voiceoverType: "trimmed" })} disabled
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
                  <button onClick={() => update({ captionsEnabled: !captionsEnabled })}
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
                          <button key={s.id} onClick={() => update({ captionsStyle: s.id })}
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
                            <button key={s.id} onClick={() => update({ captionsSize: s.id })}
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
                            <button key={p.id} onClick={() => update({ captionsPosition: p.id })}
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
                          <button key={lang.code} onClick={() => update({ captionsLanguage: lang.code })}
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
                    <video
                      src="/demo/assemble/Heclus demo video.mp4"
                      controls
                      className="w-full rounded-xl"
                      style={{ aspectRatio: "16/9", display: "block" }}
                    />
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
                      className="flex-1 py-2.5 rounded-xl text-xs font-medium transition-all hover:opacity-80"
                      style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}>
                      Reassemble
                    </button>
                    <a
                      href="/demo/assemble/Heclus demo video.mp4"
                      download="heclus-demo-video.mp4"
                      className="flex-1 py-2.5 rounded-xl text-xs font-medium text-center transition-all hover:opacity-80"
                      style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}>
                      Export
                    </a>
                    <button
                      onClick={() => { setNavigating(true); setTimeout(() => router.push("/demo/thumbnails"), 500); }}
                      disabled={navigating}
                      className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-center transition-all hover:opacity-90 disabled:opacity-60"
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                      {navigating ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Loading…
                        </span>
                      ) : "Continue"}
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


            </div>{/* end left column */}
          </div>
        </main>
      </div>
    </div>
  );
}
