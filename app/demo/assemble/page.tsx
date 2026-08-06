"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DemoStepCostCard } from "@/components/demo/DemoStepCostCard";
import { DemoStepBalanceCard } from "@/components/demo/DemoStepBalanceCard";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

// Lightweight twin of the main workflow's FullVoiceoverPreview. Holds
// the voiceover <audio controls> and (when a BGM is attached) a hidden
// sibling <audio> tag that gets started/paused/seeked in lockstep so
// the user actually hears the mix they're picking. The demo doesn't
// need the trim-silence concat pipeline — both cards just play the
// same canned mp3 — but the BGM mixing behavior IS real because that's
// what the user is auditioning.
// Assembled video player that layers two things on top of the canned
// MP4: the user's uploaded logo (positioned via the same logoX/logoY/
// logoSize fractions the placement preview surface uses) and a
// background-music <audio> that's started/paused/seeked in lockstep
// with the video. The browser doesn't let us re-encode here, so we
// simulate the final composite by overlaying HTML elements — close
// enough for a demo, and the user sees the exact placement + mix
// they configured.
function AssembledVideoPlayer({
  src,
  aspect,
  bgmUrl,
  bgmVolume,
  logoUrl,
  logoX,
  logoY,
  logoSize,
}: {
  src: string;
  aspect: string;
  bgmUrl: string | null;
  bgmVolume: number;
  logoUrl: string | null;
  logoX: number;
  logoY: number;
  logoSize: number;
}) {
  // Size the player box to the selected output aspect ratio and letterbox
  // the (16:9) source with object-contain so it's never distorted.
  const aspectCss = aspect === "9:16" ? "9 / 16" : aspect === "1:1" ? "1 / 1" : "16 / 9";
  const maxW = aspect === "9:16" ? "360px" : aspect === "1:1" ? "480px" : "100%";
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bgmRef = useRef<HTMLAudioElement | null>(null);

  // Lockstep play/pause/seek/end from the video onto the BGM audio.
  // Same approach the voiceover-preview cards use, scaled up to the
  // full assembled mp4.
  useEffect(() => {
    const v = videoRef.current;
    const b = bgmRef.current;
    if (!v || !b) return;
    const vid: HTMLVideoElement = v;
    const bgm: HTMLAudioElement = b;
    function onPlay() {
      try {
        bgm.currentTime = vid.currentTime;
        bgm.volume = Math.max(0, Math.min(1, bgmVolume));
        void bgm.play().catch(() => { /* autoplay blocks ok */ });
      } catch { /* ignore */ }
    }
    function onPause() { try { bgm.pause(); } catch { /* ignore */ } }
    function onSeeking() { try { bgm.currentTime = vid.currentTime; } catch { /* ignore */ } }
    function onEnded() {
      try { bgm.pause(); bgm.currentTime = 0; } catch { /* ignore */ }
    }
    vid.addEventListener("play", onPlay);
    vid.addEventListener("pause", onPause);
    vid.addEventListener("seeking", onSeeking);
    vid.addEventListener("ended", onEnded);
    return () => {
      vid.removeEventListener("play", onPlay);
      vid.removeEventListener("pause", onPause);
      vid.removeEventListener("seeking", onSeeking);
      vid.removeEventListener("ended", onEnded);
    };
  }, [bgmUrl, bgmVolume]);

  useEffect(() => {
    const b = bgmRef.current;
    if (b) b.volume = Math.max(0, Math.min(1, bgmVolume));
  }, [bgmVolume]);

  return (
    <div className="relative rounded-xl overflow-hidden mx-auto" style={{ background: "var(--bg-page-2)", aspectRatio: aspectCss, maxWidth: maxW }}>
      <video
        ref={videoRef}
        key={src}
        src={src}
        controls
        className="w-full h-full object-contain rounded-xl block"
      />
      {logoUrl && (
        <img
          src={logoUrl}
          alt="Logo overlay"
          className="absolute pointer-events-none select-none"
          style={{
            left: `${logoX * 100}%`,
            top: `${logoY * 100}%`,
            width: `${logoSize * 100}%`,
            filter: "drop-shadow(0 2px 6px oklch(0 0 0 / 0.5))",
          }}
        />
      )}
      {bgmUrl && (
        // Hidden audio mounts alongside the video; the lockstep effect
        // drives playback from the video's events. `loop=true` so a
        // short BGM clip fills the entire ~minute-long assembled video
        // without going silent partway through.
        <audio ref={bgmRef} src={bgmUrl} preload="auto" loop={true} />
      )}
    </div>
  );
}


function VoiceoverPreviewCard({
  title,
  hint,
  src,
  selected,
  onSelect,
  bgmUrl,
  bgmName,
  bgmVolume,
}: {
  title: string;
  hint: string;
  src: string;
  selected: boolean;
  onSelect: () => void;
  bgmUrl: string | null;
  bgmName?: string;
  bgmVolume: number;
}) {
  const voiceRef = useRef<HTMLAudioElement | null>(null);
  const bgmRef = useRef<HTMLAudioElement | null>(null);
  // Per-card "play music with preview" toggle — matches the main
  // workflow's behavior. Lets the user A/B compare voice-only vs
  // voice+music between the Trimmed and Original previews from inside
  // the same card. Defaults on whenever BGM is attached.
  const [bgmPlayWithPreview, setBgmPlayWithPreview] = useState<boolean>(true);

  // Mirror play / pause / seek / ended from the native voiceover audio
  // onto the hidden BGM audio so the two streams stay locked. Browsers
  // may drift the two by a frame or two during sustained play; that's
  // inaudible against narration and matches the real workflow's
  // tolerance.
  useEffect(() => {
    const voice = voiceRef.current;
    const bgm = bgmRef.current;
    if (!voice || !bgm) return;
    const v: HTMLAudioElement = voice;
    const b: HTMLAudioElement = bgm;
    function onPlay() {
      // Honor the per-card toggle — when the user has muted music in
      // the preview, the voiceover plays solo even though the bgm
      // element is mounted for fast re-enable.
      if (!bgmPlayWithPreview || !bgmUrl) return;
      try {
        b.currentTime = v.currentTime;
        b.volume = Math.max(0, Math.min(1, bgmVolume));
        void b.play().catch(() => { /* autoplay blocks ok */ });
      } catch { /* ignore */ }
    }
    function onPause() { try { b.pause(); } catch { /* ignore */ } }
    function onSeeking() { try { b.currentTime = v.currentTime; } catch { /* ignore */ } }
    function onEnded() {
      try { b.pause(); b.currentTime = 0; } catch { /* ignore */ }
    }
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeking", onSeeking);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeking", onSeeking);
      v.removeEventListener("ended", onEnded);
    };
  }, [bgmUrl, bgmVolume, bgmPlayWithPreview]);

  // Keep BGM volume in sync with the parent slider in real time, even
  // mid-playback. If the toggle flips OFF mid-playback, pause + reset
  // the bgm immediately even though the voiceover keeps going.
  useEffect(() => {
    const b = bgmRef.current;
    if (!b) return;
    b.volume = Math.max(0, Math.min(1, bgmVolume));
    if (!bgmPlayWithPreview || !bgmUrl) {
      try { b.pause(); } catch { /* ignore */ }
      b.currentTime = 0;
    }
  }, [bgmVolume, bgmPlayWithPreview, bgmUrl]);

  return (
    <div
      role="button"
      onClick={onSelect}
      className="rounded-xl p-3 space-y-2 transition-all cursor-pointer"
      style={selected ? {
        background: "oklch(0.72 0.25 285 / 0.08)",
        border: "1px solid oklch(0.72 0.25 285 / 0.4)",
      } : {
        background: "var(--bg-input)",
        border: "1px solid var(--bd-7)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold" style={{ color: selected ? "var(--accent-purple-text)" : "var(--c-80)" }}>
          {title}
        </p>
        {selected && (
          <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full"
            style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)", border: "1px solid oklch(0.72 0.25 285 / 0.35)" }}>
            Selected
          </span>
        )}
      </div>
      <p className="text-[11px]" style={{ color: "var(--c-45)" }}>{hint}</p>
      <audio
        ref={voiceRef}
        controls
        src={src}
        className="w-full h-8"
        onClick={(e) => e.stopPropagation()}
      />
      {/* BGM chip + toggle — lives inside each preview card so the user
          can A/B compare voice-only vs voice+music per card. The audio
          element is `loop` so a short clip fills the entire voiceover
          duration; the voiceover's `ended` event still pauses it so it
          never plays past the narration. */}
      {bgmUrl && (
        <>
          <audio ref={bgmRef} src={bgmUrl} preload="auto" loop={true} />
          <div
            className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
            onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--bg-input)", border: "1px solid var(--bd-7)" }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span aria-hidden="true" style={{ color: "var(--brand-text)" }}>♫</span>
              <span className="text-[11px] truncate" style={{ color: "var(--c-65)" }}
                title={bgmName ?? "Background music"}>
                {bgmName ?? "Background music"}
              </span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); setBgmPlayWithPreview((vv) => !vv); }}
              aria-label={bgmPlayWithPreview ? "Disable music in preview" : "Enable music in preview"}
              title={bgmPlayWithPreview ? "Music plays with preview" : "Music muted in preview"}
              className="relative w-9 h-5 rounded-full transition-all shrink-0"
              style={{
                background: bgmPlayWithPreview ? "oklch(0.72 0.25 285)" : "var(--c-22)",
                border: "1px solid var(--bd-10)",
              }}
            >
              <span
                className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                style={{
                  background: "oklch(0.95 0 0)",
                  left: bgmPlayWithPreview ? "calc(100% - 1.125rem)" : "0.125rem",
                }}
              />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
type AspectRatio = typeof ASPECT_RATIOS[number];

// Same set the main workflow exposes. Aspect ratio decides which edge
// becomes width vs height (horizontal uses long×short, vertical flips
// it, square doubles up the short edge), so the Output card's dims
// label updates as the user toggles either control.
const RESOLUTION_PRESETS = ["720p", "1080p", "1440p", "2160p"] as const;
type ResolutionPreset = typeof RESOLUTION_PRESETS[number];

const RESOLUTION_EDGES: Record<ResolutionPreset, { long: number; short: number }> = {
  "720p":  { long: 1280, short: 720 },
  "1080p": { long: 1920, short: 1080 },
  "1440p": { long: 2560, short: 1440 },
  "2160p": { long: 3840, short: 2160 },
};

function dimsFor(aspect: AspectRatio, preset: ResolutionPreset): string {
  const { long, short } = RESOLUTION_EDGES[preset];
  if (aspect === "9:16") return `${short} × ${long}`;
  if (aspect === "1:1")  return `${short} × ${short}`;
  return `${long} × ${short}`;
}

const ASSEMBLE_STEPS = [
  "Transcribing voiceover…",
  "Aligning clips to narration timing…",
  "Applying captions…",
  "Rendering final video…",
  "Uploading…",
];

function SelectButton({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="px-4 py-2 rounded-xl text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40"
      style={active ? {
        background: "oklch(0.72 0.25 285 / 0.15)",
        border: "1px solid oklch(0.72 0.25 285 / 0.4)",
        color: "var(--accent-purple-text)",
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
    assemblePhase,
  } = state;

  const [assembleMsg, setAssembleMsg] = useState("");
  const [navigating, setNavigating] = useState(false);
  // Resolution lives locally — it's cosmetic only and the demo never
  // actually renders at the chosen dims.
  const [selectedResolution, setSelectedResolution] = useState<ResolutionPreset>("1080p");
  // BGM + logo persist via demo state (sessionStorage-backed) so
  // they survive a navigate-away-and-back. Files are stored as data
  // URLs because blob: URLs die with the page lifetime — a data URL
  // string round-trips through sessionStorage just fine. The reader
  // is async, so we set a transient "reading" flag while it works.
  const {
    bgmName, bgmSizeMb, bgmDataUrl, bgmVolume,
    logoName, logoSizeKb, logoDataUrl, logoSize, logoX, logoY,
  } = state;
  const bgmInputRef = useRef<HTMLInputElement | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const [bgmReading, setBgmReading] = useState(false);
  const [logoReading, setLogoReading] = useState(false);

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  async function onPickBgm(file: File) {
    setBgmReading(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      update({
        bgmName: file.name,
        bgmSizeMb: file.size / (1024 * 1024),
        bgmDataUrl: dataUrl,
      });
    } finally {
      setBgmReading(false);
    }
  }

  async function onPickLogo(file: File) {
    setLogoReading(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      update({
        logoName: file.name,
        logoSizeKb: file.size / 1024,
        logoDataUrl: dataUrl,
      });
    } finally {
      setLogoReading(false);
    }
  }

  function clearBgm() {
    update({ bgmName: null, bgmSizeMb: null, bgmDataUrl: null });
  }
  function clearLogo() {
    update({ logoName: null, logoSizeKb: null, logoDataUrl: null });
  }

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
      <DemoNav currentStep={7} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 overflow-y-auto lg:px-[15px]">

          {/* Header */}
          <div className="px-5 sm:px-8 lg:px-[60px] py-4 sm:py-5"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
            <h1 className="font-bold text-lg">Assemble Final Video</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Transcribes your voiceover to align each clip to the exact narration timing
            </p>
            <div className="mt-3 flex items-center gap-2">
              <DemoStepCostCard column="assemble" />
              <DemoStepBalanceCard />
            </div>
          </div>

          <div className="px-5 sm:px-8 lg:px-[60px] py-4 sm:py-8 pb-24 sm:pb-24">
            <div className="flex-1 min-w-0 space-y-6">

              {/* Status cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-4 rounded-2xl" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Voiceover</p>
                  <p className="mt-2 text-sm font-medium"
                    style={{ color: voiceoverType === "trimmed" ? "oklch(0.7 0.15 145)" : "var(--brand-text)" }}>
                    {voiceoverType === "trimmed" ? "Trimmed ✓" : "Original"}
                  </p>
                </div>
                <div className="p-4 rounded-2xl" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Video Clips</p>
                  <p className="mt-2 text-sm font-medium" style={{ color: "var(--brand-text)" }}>
                    {totalBeats} / {totalBeats}
                  </p>
                </div>
                <div className="p-4 rounded-2xl space-y-2" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Output</p>
                  <p className="text-sm font-medium" style={{ color: "var(--c-65)" }}>{dimsFor(aspectRatio, selectedResolution)}</p>
                  <div className="grid grid-cols-4 gap-1.5">
                    {RESOLUTION_PRESETS.map((p) => (
                      <button
                        key={p}
                        onClick={() => setSelectedResolution(p)}
                        disabled={assemblePhase === "assembling"}
                        title={`Render at ${dimsFor(aspectRatio, p)}`}
                        className="w-full py-1 rounded-md text-[10px] font-semibold transition-all disabled:opacity-40 inline-flex items-center justify-center gap-1"
                        style={selectedResolution === p ? {
                          background: "oklch(0.72 0.25 285 / 0.18)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.45)",
                          color: "var(--accent-purple-text)",
                        } : {
                          background: "var(--bg-input)",
                          border: "1px solid var(--bd-card)",
                          color: "var(--c-50)",
                        }}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Aspect ratio — demo is locked to 16:9. The vertical
                  and square buttons render for visual completeness but
                  are non-interactive so users can see the option exists
                  without being able to break the demo's canned
                  assets (which were all rendered at 16:9). */}
              <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--c-40)" }}>Output Aspect Ratio</p>
                <div className="flex gap-2">
                  {ASPECT_RATIOS.map((r) => {
                    const locked = r !== "16:9";
                    return (
                      <SelectButton
                        key={r}
                        active={aspectRatio === r}
                        disabled={locked}
                        onClick={() => { if (!locked) update({ aspectRatio: r }); }}
                      >
                        {r}
                      </SelectButton>
                    );
                  })}
                </div>
              </div>

              {/* Background music — compact single-bar picker mirrors
                  the main workflow's BGM control. In the demo the file
                  picker is presentational (the volume slider IS live,
                  the file input is wired but doesn't actually upload). */}
              <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5 flex-wrap"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <span aria-hidden="true" className="text-base shrink-0" style={{ color: "var(--brand-text)" }}>♫</span>
                {!bgmDataUrl ? (
                  <>
                    <p className="text-sm font-semibold flex-1">Background music</p>
                    <button
                      onClick={() => bgmInputRef.current?.click()}
                      disabled={assemblePhase === "assembling" || bgmReading}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all shrink-0"
                      style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                    >
                      {bgmReading ? "Reading…" : "Choose file"}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                        Background music
                      </p>
                      <p className="text-xs font-medium truncate" style={{ color: "var(--c-80)" }} title={bgmName ?? ""}>
                        {bgmName ?? "Saved track"}
                      </p>
                      <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
                        {bgmSizeMb != null ? `${bgmSizeMb.toFixed(1)} MB · Uploaded` : "Uploaded"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>Vol</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={bgmVolume}
                        onChange={(e) => update({ bgmVolume: parseFloat(e.target.value) })}
                        disabled={assemblePhase === "assembling"}
                        aria-label="Background music volume"
                        className="w-24 sm:w-32"
                      />
                      <span className="text-[11px] font-mono tabular-nums w-9 text-right" style={{ color: "var(--c-60)" }}>
                        {Math.round(bgmVolume * 100)}%
                      </span>
                    </div>
                    <button
                      onClick={clearBgm}
                      disabled={assemblePhase === "assembling"}
                      title="Remove background music"
                      className="w-7 h-7 rounded-lg flex items-center justify-center transition-opacity hover:opacity-90 disabled:opacity-40 shrink-0"
                      style={{ background: "transparent", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                    >
                      ×
                    </button>
                  </>
                )}
                <input
                  ref={bgmInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onPickBgm(f);
                    if (bgmInputRef.current) bgmInputRef.current.value = "";
                  }}
                />
              </div>

              {/* Channel logo — compact bar (file picker + size slider
                  + × clear) mirrors the main workflow's logo control.
                  Demo skips the draggable preview surface since the
                  composite never actually renders against video; the
                  goal here is to surface the option, not produce
                  pixel-perfect placement. */}
              <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5 flex-wrap"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <span aria-hidden="true" className="text-base shrink-0" style={{ color: "var(--brand-text)" }}>◈</span>
                {!logoDataUrl ? (
                  <>
                    <p className="text-sm font-semibold flex-1">Channel logo</p>
                    <button
                      onClick={() => logoInputRef.current?.click()}
                      disabled={assemblePhase === "assembling" || logoReading}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all shrink-0"
                      style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                    >
                      {logoReading ? "Reading…" : "Choose file"}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                        Channel logo
                      </p>
                      <p className="text-xs font-medium truncate" style={{ color: "var(--c-80)" }} title={logoName ?? ""}>
                        {logoName ?? "Saved logo"}
                      </p>
                      <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
                        {logoSizeKb != null ? `${logoSizeKb.toFixed(0)} KB · Uploaded` : "Uploaded"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>Size</span>
                      <input
                        type="range"
                        min={0.03}
                        max={0.4}
                        step={0.01}
                        value={logoSize}
                        onChange={(e) => update({ logoSize: parseFloat(e.target.value) })}
                        disabled={assemblePhase === "assembling"}
                        aria-label="Logo size"
                        className="w-24 sm:w-32"
                      />
                      <span className="text-[11px] font-mono tabular-nums w-9 text-right" style={{ color: "var(--c-60)" }}>
                        {Math.round(logoSize * 100)}%
                      </span>
                    </div>
                    <button
                      onClick={clearLogo}
                      disabled={assemblePhase === "assembling"}
                      title="Remove channel logo"
                      className="w-7 h-7 rounded-lg flex items-center justify-center transition-opacity hover:opacity-90 disabled:opacity-40 shrink-0"
                      style={{ background: "transparent", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                    >
                      ×
                    </button>
                  </>
                )}
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onPickLogo(f);
                    if (logoInputRef.current) logoInputRef.current.value = "";
                  }}
                />
              </div>

              {/* Logo placement preview — mirrors the main workflow: a
                  dark output canvas at the current aspect ratio, the logo
                  draggable to position, and a bottom-right handle to
                  resize. Position + size are 0-1 fractions matching how the
                  worker interprets logoX / logoY / logoSize. */}
              {logoDataUrl && (() => {
                const aspectCss = aspectRatio === "9:16" ? "9 / 16" : aspectRatio === "1:1" ? "1 / 1" : "16 / 9";
                function onDragLogo(e: React.PointerEvent<HTMLImageElement>) {
                  e.preventDefault();
                  e.stopPropagation();
                  const surface = e.currentTarget.parentElement?.parentElement as HTMLElement | null;
                  if (!surface) return;
                  const img = e.currentTarget;
                  img.setPointerCapture(e.pointerId);
                  const startBox = surface.getBoundingClientRect();
                  const offsetX = e.clientX - img.getBoundingClientRect().left;
                  const offsetY = e.clientY - img.getBoundingClientRect().top;
                  function move(ev: PointerEvent) {
                    const localX = ev.clientX - startBox.left - offsetX;
                    const localY = ev.clientY - startBox.top - offsetY;
                    const maxX = 1 - logoSize;
                    const approxLogoHpct = img.offsetHeight / startBox.height;
                    const maxY = Math.max(0, 1 - approxLogoHpct);
                    const nextX = Math.max(0, Math.min(maxX, localX / startBox.width));
                    const nextY = Math.max(0, Math.min(maxY, localY / startBox.height));
                    update({ logoX: nextX, logoY: nextY });
                  }
                  function up(ev: PointerEvent) {
                    img.releasePointerCapture(ev.pointerId);
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  }
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }
                function onResizeLogo(e: React.PointerEvent<HTMLSpanElement>) {
                  e.preventDefault();
                  e.stopPropagation();
                  const handle = e.currentTarget;
                  const surface = handle.parentElement?.parentElement as HTMLElement | null;
                  if (!surface) return;
                  handle.setPointerCapture(e.pointerId);
                  const startBox = surface.getBoundingClientRect();
                  const logoLeftPx = startBox.left + logoX * startBox.width;
                  function move(ev: PointerEvent) {
                    const newWidthPx = Math.max(0, ev.clientX - logoLeftPx);
                    const newSize = Math.max(0.03, Math.min(0.4, newWidthPx / startBox.width));
                    const maxSize = Math.max(0.03, 1 - logoX);
                    update({ logoSize: Math.min(newSize, maxSize) });
                  }
                  function up(ev: PointerEvent) {
                    handle.releasePointerCapture(ev.pointerId);
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  }
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }
                const dragging = assemblePhase === "assembling";
                return (
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                      Drag to position · drag corner to resize
                    </p>
                    <div
                      className="relative w-full rounded-lg overflow-hidden select-none"
                      style={{
                        aspectRatio: aspectCss,
                        maxWidth: "320px",
                        background: "linear-gradient(135deg, oklch(0.16 0 0), oklch(0.22 0 0))",
                        border: "1px solid var(--bd-card)",
                      }}
                    >
                      <div
                        className="absolute group"
                        style={{ left: `${logoX * 100}%`, top: `${logoY * 100}%`, width: `${logoSize * 100}%` }}
                      >
                        <img
                          src={logoDataUrl}
                          alt={logoName ?? "Channel logo"}
                          draggable={false}
                          onPointerDown={dragging ? undefined : onDragLogo}
                          className="touch-none block w-full h-auto"
                          style={{ cursor: dragging ? "default" : "grab", opacity: 0.95, filter: "drop-shadow(0 2px 8px oklch(0 0 0 / 0.5))" }}
                        />
                        {!dragging && (
                          <span
                            onPointerDown={onResizeLogo}
                            aria-label="Resize logo"
                            title="Drag to resize"
                            className="absolute touch-none flex items-center justify-center"
                            style={{
                              right: "-6px",
                              bottom: "-6px",
                              width: "14px",
                              height: "14px",
                              borderRadius: "9999px",
                              background: "oklch(0.72 0.25 285)",
                              border: "2px solid #ffffff",
                              cursor: "nwse-resize",
                              boxShadow: "0 0 0 1px oklch(0.4 0.15 285)",
                            }}
                          />
                        )}
                      </div>
                    </div>
                    <p className="text-[10px] font-mono tabular-nums" style={{ color: "var(--c-40)" }}>
                      x: {Math.round(logoX * 100)}% · y: {Math.round(logoY * 100)}% · size: {Math.round(logoSize * 100)}%
                    </p>
                  </div>
                );
              })()}

              {/* Voiceover source — side-by-side preview cards mirror
                  the main workflow's FullVoiceoverPreview pair. Sits after
                  the logo control to match the main workflow's order. */}
              <div className="rounded-2xl p-5 space-y-3" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Voiceover Source</p>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {([
                    { id: "trimmed",  title: "Trimmed voiceover",  hint: "Silence between beats removed — tighter pacing",   src: "/demo/voiceover/voiceover.mp3" },
                    { id: "original", title: "Original voiceover", hint: "Full TTS output with natural pauses left intact", src: "/demo/voiceover/voiceover.mp3" },
                  ] as const).map((v) => (
                    <VoiceoverPreviewCard
                      key={v.id}
                      title={v.title}
                      hint={v.hint}
                      src={v.src}
                      selected={voiceoverType === v.id}
                      onSelect={() => update({ voiceoverType: v.id })}
                      bgmUrl={bgmDataUrl}
                      bgmName={bgmName ?? undefined}
                      bgmVolume={bgmVolume}
                    />
                  ))}
                </div>
              </div>

              {/* Captions — surface only. Disabled in the demo; the
                  toggle is a visual placeholder so the layout matches
                  the real workflow and the user sees the option exists,
                  but flipping it wouldn't do anything so it's locked. */}
              <div className="rounded-2xl p-5 opacity-60" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">Captions</p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>Not available in the demo</p>
                  </div>
                  <button
                    disabled
                    aria-disabled
                    title="Not available in the demo"
                    className="relative w-11 h-6 rounded-full shrink-0 cursor-not-allowed"
                    style={{ background: "var(--c-22)", border: "1px solid var(--bd-10)" }}
                  >
                    <span
                      className="absolute top-0.5 w-5 h-5 rounded-full"
                      style={{ background: "oklch(0.95 0 0)", left: "0.125rem" }}
                    />
                  </button>
                </div>
              </div>

              {/* Assembly controls */}
              <div className="rounded-2xl p-5 space-y-4" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                {assemblePhase === "done" && (
                  <AssembledVideoPlayer
                    src={"/demo/assemble/assemble.mp4"}
                    aspect={aspectRatio}
                    bgmUrl={bgmDataUrl}
                    bgmVolume={bgmVolume}
                    logoUrl={logoDataUrl}
                    logoX={logoX}
                    logoY={logoY}
                    logoSize={logoSize}
                  />
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
                    <button
                      disabled
                      aria-disabled
                      title="Export is disabled in the demo"
                      className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-center transition-all cursor-not-allowed"
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)", opacity: 1 }}>
                      ↓ Export
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

        {/* Fixed Continue bar — only after assembly completes so the
            user can't advance to thumbnails before they've actually
            produced an assembled video. Matches the demo's other steps. */}
        {assemblePhase === "done" && (
          <div
            className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
            style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}
          >
            {/* Mirror the content insets (main's lg:px-[15px] + the body's
                px-5 sm:px-8 lg:px-[60px]) so the button matches card width. */}
            <div className="lg:px-[15px]">
            <div className="px-5 sm:px-8 lg:px-[60px]">
              <button
                onClick={() => { setNavigating(true); setTimeout(() => router.push("/demo/thumbnails"), 500); }}
                disabled={navigating}
                className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-60"
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
        )}
      </div>
    </div>
  );
}
