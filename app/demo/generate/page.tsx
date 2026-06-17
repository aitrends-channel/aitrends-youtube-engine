"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

// ── Fake model data ──────────────────────────────────────────────────────────

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

const FAKE_IMAGE_MODELS = [
  { id: "flux-kontext-pro",                    name: "Flux Kontext Pro",   description: "High quality context-aware generation", tags: ["High Quality"],          cost: "2 cr/img" },
  { id: "flux-kontext-max",                    name: "Flux Kontext Max",   description: "Maximum quality context generation",    tags: ["Max Quality"],           cost: "4 cr/img" },
  { id: "flux-2/pro-text-to-image",            name: "Flux 2 Pro",         description: "Fast, professional-grade output",        tags: ["Fast"],                  cost: "2 cr/img" },
  { id: "flux-2/flex-text-to-image",           name: "Flux 2 Flex",        description: "Flexible styles and compositions",       tags: ["Flexible"],              cost: "2 cr/img" },
  { id: "google/imagen4-ultra",                name: "Imagen 4 Ultra",     description: "Google ultra-high fidelity",             tags: ["Google", "Ultra"],       cost: "5 cr/img" },
  { id: "nano-banana-2",                       name: "Nano Banana 2",      description: "Up to 4K, wide ratio support",           tags: ["Google"],                cost: "2 cr/img" },
  { id: "nano-banana-pro",                     name: "Nano Banana Pro",    description: "Pro-grade 4K image output",              tags: ["Google", "Pro"],         cost: "3 cr/img" },
  { id: "bytedance/seedream-v4-text-to-image", name: "Seedream 4.0",       description: "ByteDance's latest image model",         tags: ["ByteDance", "Latest"],   cost: "3 cr/img" },
  { id: "grok-imagine/text-to-image",          name: "Grok Imagine",       description: "xAI's creative image generator",         tags: ["xAI"],                   cost: "3 cr/img" },
  { id: "z-image",                             name: "Z-Image",            description: "Stylized artistic output",               tags: ["Stylized"],              cost: "2 cr/img" },
];

const FAKE_IMAGE_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:2", "3:4", "2:3", "21:9"];

const FAKE_VIDEO_MODELS = [
  { id: "kling-3.0/video",             name: "Kling 3.0",       description: "Latest Kling, I2V + T2V",          tags: ["Latest", "I2V + T2V"],      cost: "12 cr/s" },
  { id: "kling-2.6/text-to-video",     name: "Kling 2.6 T2V",   description: "Text-to-video generation",          tags: ["Text-to-Video"],            cost: "8 cr/s"  },
  { id: "kling-2.6/image-to-video",    name: "Kling 2.6 I2V",   description: "Image-to-video animation",          tags: ["Image-to-Video"],           cost: "8 cr/s"  },
  { id: "wan/2-7-text-to-video",       name: "Wan 2.7 T2V",     description: "Fast text-to-video output",         tags: ["Text-to-Video"],            cost: "4 cr/s"  },
  { id: "wan/2-7-image-to-video",      name: "Wan 2.7 I2V",     description: "Fast image-to-video animation",     tags: ["Image-to-Video"],           cost: "4 cr/s"  },
  { id: "hailuo/02-text-to-video-pro", name: "Hailuo Pro",      description: "Pro text-to-video quality",         tags: ["Text-to-Video"],            cost: "10 cr/s" },
  { id: "grok-imagine/image-to-video", name: "Grok Imagine",    description: "xAI image-to-video model",          tags: ["Image-to-Video"],           cost: "8 cr/s"  },
  { id: "sora-2-image-to-video",       name: "Sora 2",          description: "OpenAI's image-to-video model",     tags: ["Image-to-Video"],           cost: "15 cr/s" },
  { id: "veo3",                        name: "Veo 3",           description: "Google's T2V + I2V flagship",        tags: ["T2V + I2V", "Google"],      cost: "18 cr/s" },
  { id: "veo3_fast",                   name: "Veo 3 Fast",      description: "Google Veo 3 at faster speed",      tags: ["T2V + I2V", "Google", "Fast"], cost: "10 cr/s" },
  { id: "runway",                      name: "Runway",          description: "Industry-standard video gen",        tags: ["T2V + I2V"],                cost: "8 cr/s"  },
  { id: "bytedance/seedance-2",        name: "Seedance 2",      description: "ByteDance I2V + T2V model",         tags: ["ByteDance", "I2V + T2V"],   cost: "6 cr/s"  },
];

const FAKE_VIDEO_RATIOS = ["16:9", "9:16", "1:1"];
const FAKE_DURATIONS = [{ label: "5s", value: 5 }, { label: "10s", value: 10 }];

// ── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center text-base"
        style={{ background: "oklch(0.72 0.25 285 / 0.1)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}>
        {icon}
      </div>
      <div>
        <p className="font-semibold text-sm">{title}</p>
        <p className="text-xs" style={{ color: "var(--c-45)" }}>{subtitle}</p>
      </div>
    </div>
  );
}

function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs" style={{ color: "var(--c-45)" }}>
        <span>{value} / {total}</span><span>{pct}%</span>
      </div>
      <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
        <div className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))" }} />
      </div>
    </div>
  );
}

function SkeletonTile() {
  return (
    <div className="absolute inset-0 shimmer" style={{ background: "var(--bg-progress)" }} />
  );
}

function ImageTile({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  // Reset when the source changes (e.g. regenerate)
  useEffect(() => { setLoaded(false); }, [src]);
  return (
    <>
      {!loaded && <SkeletonTile />}
      <img
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        className="w-full h-full object-cover"
        style={{ opacity: loaded ? 1 : 0 }}
      />
    </>
  );
}

function VideoTile({ src }: { src: string }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setLoaded(false); }, [src]);
  return (
    <>
      {!loaded && <SkeletonTile />}
      <video
        src={src}
        onLoadedData={() => setLoaded(true)}
        muted
        autoPlay
        loop
        playsInline
        className="w-full h-full object-cover"
        style={{ opacity: loaded ? 1 : 0 }}
      />
    </>
  );
}

function RatioButtons({ ratios, selected, onSelect }: { ratios: string[]; selected: string; onSelect: (r: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ratios.map((r) => (
        <button key={r} onClick={() => onSelect(r)}
          className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
          style={selected === r ? {
            background: "oklch(0.72 0.25 285 / 0.15)",
            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
            color: "oklch(0.88 0.12 285)",
          } : {
            background: "var(--bg-input)",
            border: "1px solid var(--bd-7)",
            color: "var(--c-50)",
          }}>
          {r}
        </button>
      ))}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function DemoGeneratePage() {
  const router = useRouter();
  const { state, update } = useDemoState();

  const [navigating, setNavigating] = useState(false);

  const {
    selectedVoice, ttsPhase,
    selectedImageModel, selectedImageRatio, imagesPhase, imagesProgress,
    selectedVideoModel, selectedVideoRatio, selectedDuration, videosPhase,
  } = state;

  const totalBeats = DEMO_DATA.promptBeats.length;

  function generateVoiceover() {
    update({ ttsPhase: "generating" });
    setTimeout(() => update({ ttsPhase: "done" }), 2500);
  }

  function generateImages() {
    update({ imagesPhase: "generating", imagesProgress: 0 });
    let count = 0;
    const id = setInterval(() => {
      count++;
      update({ imagesProgress: count });
      if (count >= totalBeats) {
        clearInterval(id);
        update({ imagesPhase: "done" });
      }
    }, 700);
  }

  function queueVideos() {
    update({ videosPhase: "queuing" });
    setTimeout(() => update({ videosPhase: "done" }), 2000);
  }

  const allDone = ttsPhase === "done" && imagesPhase === "done" && videosPhase === "done";

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={5} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 overflow-y-auto">
          {/* Header */}
          <div className="px-4 sm:px-8 py-4 sm:py-5"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
            <h1 className="font-bold text-lg">Generate Assets</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Select a model for each service, then generate your final content
            </p>
          </div>

          <div className="p-4 sm:p-8 pb-24 sm:pb-24 grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* ── Voiceover column ─────────────────────────────────────────── */}
            <div className="rounded-2xl flex flex-col overflow-hidden"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <div className="p-5" style={{ borderBottom: "1px solid var(--bd-6)" }}>
                <SectionHeader icon="♪" title="Voiceover" subtitle="Text-to-speech from your script" />
                <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
                  Select Voice
                </p>
                <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                  {FAKE_VOICES.map((v) => {
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

              <div className="p-5 mt-auto space-y-3">
                {ttsPhase === "done" ? (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Original</span>
                        <a href="/demo/voiceover/demo-voiceover_short.mp3" download="voiceover.mp3"
                          className="text-xs" style={{ color: "var(--c-45)" }}>↓ Download</a>
                      </div>
                      <audio controls src="/demo/voiceover/demo-voiceover_short.mp3" className="w-full h-8" />
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
                  <div className="space-y-2">
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
                  </div>
                )}
              </div>
            </div>

            {/* ── AI Images column ─────────────────────────────────────────── */}
            <div className="rounded-2xl flex flex-col overflow-hidden"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <div className="p-5" style={{ borderBottom: "1px solid var(--bd-6)" }}>
                <SectionHeader icon="◈" title="AI Images" subtitle={`${totalBeats} images from script beats`} />
                <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
                  Select Model
                </p>
                <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                  {FAKE_IMAGE_MODELS.map((m) => (
                    <button key={m.id} onClick={() => update({ selectedImageModel: m.id })}
                      className="w-full text-left p-3 rounded-xl transition-all"
                      style={selectedImageModel === m.id ? {
                        background: "oklch(0.72 0.25 285 / 0.1)",
                        border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                        color: "var(--c-90)",
                      } : {
                        background: "var(--bg-input)",
                        border: "1px solid var(--bd-7)",
                        color: "var(--c-60)",
                      }}>
                      <p className="font-medium text-xs">{m.name}</p>
                      {m.description && <p className="text-xs mt-0.5 opacity-60">{m.description}</p>}
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {m.tags.map((tag) => (
                          <span key={tag} className="px-1.5 py-0.5 rounded text-xs"
                            style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>{tag}</span>
                        ))}
                        <span className="px-1.5 py-0.5 rounded text-xs"
                          style={{ background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" }}>
                          {m.cost}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>

                <p className="text-xs font-semibold uppercase tracking-wider mt-4 mb-2" style={{ color: "var(--c-40)" }}>
                  Aspect Ratio
                </p>
                <RatioButtons ratios={FAKE_IMAGE_RATIOS} selected={selectedImageRatio} onSelect={(r) => update({ selectedImageRatio: r })} />
              </div>

              {/* Image beat grid */}
              {imagesPhase !== "idle" && (
                <div className="px-5 pt-4">
                  <ProgressBar value={imagesPhase === "done" ? totalBeats : imagesProgress} total={totalBeats} />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-3 max-h-72 overflow-y-auto">
                    {DEMO_DATA.promptBeats.map((beat, i) => {
                    const revealed = imagesPhase === "done" || i < imagesProgress;
                    return (
                      <div key={beat.beat}
                        className="relative aspect-video rounded-lg overflow-hidden flex items-center justify-center"
                        style={{ background: "var(--bg-progress)" }}>
                        {revealed ? (
                          <ImageTile src={beat.imageUrl} alt={`Beat ${beat.beat}`} />
                        ) : (
                          <span className="text-[9px] relative z-10" style={{ color: "var(--c-35)" }}>{beat.beat}</span>
                        )}
                      </div>
                    );
                  })}
                  </div>
                </div>
              )}

              <div className="p-5 mt-auto">
                <button
                  onClick={generateImages}
                  disabled={imagesPhase === "generating"}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  {imagesPhase === "generating" ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      {`Generating… ${imagesProgress}/${totalBeats}`}
                    </span>
                  ) : imagesPhase === "done"
                    ? `Regenerate All (${totalBeats})`
                    : `Generate ${totalBeats} Images`}
                </button>
              </div>
            </div>

            {/* ── AI Video Clips column ────────────────────────────────────── */}
            <div className="rounded-2xl flex flex-col overflow-hidden"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <div className="p-5" style={{ borderBottom: "1px solid var(--bd-6)" }}>
                <SectionHeader icon="⚡" title="AI Video Clips" subtitle={`${totalBeats} clips · 5–10s each`} />
                <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
                  Select Model
                </p>
                <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                  {FAKE_VIDEO_MODELS.map((m) => (
                    <button key={m.id} onClick={() => update({ selectedVideoModel: m.id })}
                      className="w-full text-left p-3 rounded-xl transition-all"
                      style={selectedVideoModel === m.id ? {
                        background: "oklch(0.72 0.25 285 / 0.1)",
                        border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                        color: "var(--c-90)",
                      } : {
                        background: "var(--bg-input)",
                        border: "1px solid var(--bd-7)",
                        color: "var(--c-60)",
                      }}>
                      <p className="font-medium text-xs">{m.name}</p>
                      {m.description && <p className="text-xs mt-0.5 opacity-60">{m.description}</p>}
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {m.tags.map((tag) => (
                          <span key={tag} className="px-1.5 py-0.5 rounded text-xs"
                            style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>{tag}</span>
                        ))}
                        <span className="px-1.5 py-0.5 rounded text-xs"
                          style={{ background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" }}>
                          {m.cost}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>

                <p className="text-xs font-semibold uppercase tracking-wider mt-4 mb-2" style={{ color: "var(--c-40)" }}>
                  Aspect Ratio
                </p>
                <RatioButtons ratios={FAKE_VIDEO_RATIOS} selected={selectedVideoRatio} onSelect={(r) => update({ selectedVideoRatio: r })} />

                <p className="text-xs font-semibold uppercase tracking-wider mt-3 mb-2" style={{ color: "var(--c-40)" }}>
                  Duration
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {FAKE_DURATIONS.map((d) => (
                    <button key={d.value} onClick={() => update({ selectedDuration: d.value })}
                      className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
                      style={selectedDuration === d.value ? {
                        background: "oklch(0.72 0.25 285 / 0.15)",
                        border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                        color: "oklch(0.88 0.12 285)",
                      } : {
                        background: "var(--bg-input)",
                        border: "1px solid var(--bd-7)",
                        color: "var(--c-50)",
                      }}>
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Video clip grid */}
              {videosPhase !== "idle" && (
                <div className="px-5 pt-4">
                  <ProgressBar value={videosPhase === "done" ? totalBeats : 0} total={totalBeats} />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-3 max-h-72 overflow-y-auto">
                    {DEMO_DATA.promptBeats.map((beat) => (
                      <div key={beat.beat}
                        className="relative aspect-video rounded-lg overflow-hidden flex items-center justify-center"
                        style={{ background: "var(--bg-progress)" }}>
                        {videosPhase === "done" ? (
                          <VideoTile src={beat.videoUrl} />
                        ) : (
                          <span className="text-[9px] px-1.5 py-0.5 rounded relative z-10"
                            style={{
                              background: "oklch(0.72 0.25 285 / 0.1)",
                              color: "oklch(0.72 0.25 285)",
                            }}>
                            queued
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="p-5 mt-auto space-y-3">
                {videosPhase !== "done" && (
                  <p className="text-xs" style={{ color: "var(--c-40)" }}>
                    Runs in background — clips appear as each job completes.
                  </p>
                )}
                {videosPhase === "done" && (
                  <ProgressBar value={totalBeats} total={totalBeats} />
                )}
                <button
                  onClick={queueVideos}
                  disabled={videosPhase === "queuing" || videosPhase === "done"}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  {videosPhase === "queuing" ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Queuing clips…
                    </span>
                  ) : videosPhase === "done" ? `${totalBeats} Clips Queued` : `Queue ${totalBeats} Video Clips`}
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>

      <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
        style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
        <div className="px-4 sm:px-8">
          <button
            onClick={() => { setNavigating(true); setTimeout(() => router.push("/demo/assemble"), 500); }}
            disabled={!allDone || navigating}
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
  );
}
