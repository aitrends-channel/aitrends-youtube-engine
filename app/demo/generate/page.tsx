"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { ImageIcon, Video, Eye, Pencil, Info, X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DemoStepCostCard } from "@/components/demo/DemoStepCostCard";
import { DemoStepBalanceCard } from "@/components/demo/DemoStepBalanceCard";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

// ── Fake model data ──────────────────────────────────────────────────────────

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

// Model-picker tab row — mirrors the real ModelPicker's All / Fastest /
// Cheapest / Free tabs. In the demo the ranking tabs all show the same
// list (no live speed/cost data), and Free swaps in the coming-soon card.
const MODEL_TABS = ["all", "fastest", "cheapest", "free"] as const;
type ModelTab = (typeof MODEL_TABS)[number];

function ModelTabs({ tab, onTab }: { tab: ModelTab; onTab: (t: ModelTab) => void }) {
  return (
    <div className="flex gap-1 mb-2 p-0.5 rounded-lg" style={{ background: "var(--bg-track)" }}>
      {MODEL_TABS.map((t) => (
        <button
          key={t}
          onClick={() => onTab(t)}
          className="flex-1 flex items-center justify-center px-2 py-1 rounded-md text-xs font-medium capitalize transition-all"
          style={t === "free" ? {
            // Free tab always wears the solid brand color as a promo.
            background: "var(--primary)",
            border: "1px solid var(--primary)",
            color: "var(--primary-foreground)",
          } : tab === t ? {
            background: "oklch(0.72 0.25 285 / 0.15)",
            color: "oklch(0.88 0.12 285)",
            boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.35)",
          } : { background: "transparent", color: "var(--c-55)" }}
        >
          {t === "free" ? (
            <span className="flex flex-col items-center leading-tight">
              <span>😄 Free</span>
              <span className="text-[9px] font-semibold normal-case">coming soon</span>
            </span>
          ) : t}
        </button>
      ))}
    </div>
  );
}

function ComingSoonCard() {
  return (
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
        production, reduce costs, and achieve more with less. Stay with us as we
        continue to grow into the one-stop solution you&apos;ve been looking for.
      </p>
    </div>
  );
}

type DemoBeat = (typeof DEMO_DATA.promptBeats)[number];

// Interactive beat tile — mirrors the real generate grid: beat-number badge,
// hover-prompt tooltip (desktop) / tap-to-view-prompt info button (touch), an
// Eye view affordance, and a click that opens the full preview dialog.
function BeatTile({
  beat, type, onOpen, onHover, onLeave, onTapInfo,
}: {
  beat: DemoBeat;
  type: "image" | "video";
  onOpen: () => void;
  onHover: (e: React.MouseEvent) => void;
  onLeave: () => void;
  onTapInfo: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="relative w-full aspect-video rounded-lg overflow-hidden group cursor-pointer"
      style={{ background: "var(--bg-progress)" }}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onOpen}
    >
      {/* Beat number badge — top-left of every tile. */}
      <span
        className="absolute top-1.5 left-1.5 z-10 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center text-[9px] font-semibold tabular-nums pointer-events-none"
        style={{ background: "oklch(0 0 0 / 0.6)", color: "white", border: "1px solid oklch(1 0 0 / 0.15)" }}
      >
        {beat.beat}
      </span>
      {/* Touch-only "view prompt" — desktop uses hover. */}
      <button
        type="button"
        onClick={onTapInfo}
        aria-label={`View prompt for beat ${beat.beat}`}
        className="touch-only absolute bottom-1.5 left-1.5 z-20 w-7 h-7 rounded-full items-center justify-center"
        style={{ background: "oklch(0 0 0 / 0.6)", color: "white", border: "1px solid oklch(1 0 0 / 0.15)" }}
      >
        <Info size={14} />
      </button>
      {type === "image"
        ? <ImageTile src={beat.imageUrl} alt={`Beat ${beat.beat}`} />
        : <VideoTile src={beat.videoUrl} />}
      {/* Eye — opens the full closable preview dialog. */}
      <button
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        title={`View ${type}`}
        aria-label={`View beat ${beat.beat}`}
        className="absolute top-1.5 right-1.5 z-10 w-7 h-7 rounded-full flex items-center justify-center transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:scale-110"
        style={{ background: "oklch(0 0 0 / 0.6)", color: "white", border: "1px solid oklch(1 0 0 / 0.15)" }}
      >
        <Eye size={12} strokeWidth={2.4} />
      </button>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function DemoGeneratePage() {
  const router = useRouter();
  const { state, update } = useDemoState();

  const [navigating, setNavigating] = useState(false);
  const [imageModelTab, setImageModelTab] = useState<ModelTab>("all");
  const [videoModelTab, setVideoModelTab] = useState<ModelTab>("all");
  // Images / Videos / Both column switcher — mirrors the real generate step.
  // "both" shows the two panels side by side; "image"/"video" show one.
  const [columnView, setColumnView] = useState<"image" | "video" | "both">("both");
  // "Both" is desktop-only — mobile shows one panel at a time (matches the
  // real generate step). On mobile a persisted "both" falls back to Images.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const effectiveView = isMobile && columnView === "both" ? "image" : columnView;

  // Beat preview dialog + hover-prompt tooltip — mirror the real step.
  const [previewBeat, setPreviewBeat] = useState<{ beat: DemoBeat; type: "image" | "video" } | null>(null);
  const [previewEditing, setPreviewEditing] = useState(false);
  const [previewShowPrompt, setPreviewShowPrompt] = useState(false);
  const [previewEditedPrompt, setPreviewEditedPrompt] = useState("");
  const [previewAspect, setPreviewAspect] = useState<number | null>(null);
  const [promptPopup, setPromptPopup] = useState<
    { beatNumber: number; text: string; left: number; top: number; width: number; above: boolean } | null
  >(null);

  // Pin the dialog to the media's real size so it hugs the media instead of
  // always opening at the full dialog width. Mirrors the real generate step.
  const previewMediaSize = useMemo<{ w: number; h: number } | null>(() => {
    if (!previewAspect || typeof window === "undefined") return null;
    const chrome = previewEditing ? 120 : previewShowPrompt ? 170 : 0;
    const maxW = window.innerWidth * 0.95;
    const maxH = Math.max(window.innerHeight * 0.85 - chrome, 240);
    const w = Math.round(Math.min(maxW, maxH * previewAspect));
    return { w, h: Math.round(w / previewAspect) };
  }, [previewAspect, previewEditing, previewShowPrompt]);

  function openPreview(beat: DemoBeat, type: "image" | "video") {
    // Seed the aspect synchronously from the grid-cached image so the dialog
    // is sized on the first render (no wide flash). Video follows its image.
    const probe = new Image();
    probe.src = beat.imageUrl;
    if (probe.complete && probe.naturalWidth) {
      setPreviewAspect(probe.naturalWidth / probe.naturalHeight);
    } else {
      setPreviewAspect(16 / 9);
    }
    setPreviewBeat({ beat, type });
    setPreviewEditing(false);
    setPreviewShowPrompt(false);
  }
  function closePreview() {
    setPreviewBeat(null);
    setPreviewEditing(false);
    setPreviewShowPrompt(false);
    setPreviewAspect(null);
  }
  function showBeatPrompt(e: React.MouseEvent, beatNumber: number, text: string) {
    if (typeof window !== "undefined" && window.matchMedia?.("(hover: none)").matches) return;
    const r = e.currentTarget.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
    const above = r.bottom > window.innerHeight * 0.62;
    setPromptPopup({ beatNumber, text, left, width, top: above ? r.top - 6 : r.bottom + 6, above });
  }
  function showBeatPromptTap(e: React.MouseEvent, beatNumber: number, text: string) {
    e.stopPropagation();
    const tile = ((e.currentTarget as HTMLElement).closest(".group") ?? e.currentTarget) as HTMLElement;
    const r = tile.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
    const above = r.bottom > window.innerHeight * 0.62;
    setPromptPopup({ beatNumber, text, left, width, top: above ? r.top - 6 : r.bottom + 6, above });
  }

  const {
    selectedImageModel, selectedImageRatio, imagesPhase, imagesProgress,
    selectedVideoModel, selectedDuration, videosPhase,
  } = state;

  const totalBeats = DEMO_DATA.promptBeats.length;

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

  // Voiceover moved out into its own /demo/voiceover step. allDone now
  // gates Continue purely on what this page actually controls — images
  // and videos.
  const allDone = imagesPhase === "done" && videosPhase === "done";

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={6} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 overflow-y-auto lg:px-[15px]">
          {/* Header */}
          <div className="py-4 sm:py-5"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
            <h1 className="font-bold text-lg">Generate Assets</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Select a model for each service, then generate your final content
            </p>
            <div className="mt-3 flex items-center gap-2">
              <DemoStepCostCard column="generate" />
              <DemoStepBalanceCard />
            </div>
          </div>

          {/* Images / Videos / Both switcher — a persistent tab bar above the
              two panels. Images & Videos show one panel; Both shows the pair. */}
          <div className="pt-3 pb-3" style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)" }}>
            <div className="flex items-center gap-1 rounded-xl p-1" style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
              {([
                { key: "image", label: "Images", icon: <ImageIcon size={15} /> },
                { key: "video", label: "Videos", icon: <Video size={15} /> },
                // "Both" is desktop-only.
                ...(!isMobile ? [{
                  key: "both", label: "Both", icon: (
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                      <rect x="2" y="2.5" width="5" height="11" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
                      <rect x="9" y="2.5" width="5" height="11" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
                    </svg>
                  ),
                }] : []),
              ] as const).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setColumnView(t.key as "image" | "video" | "both")}
                  aria-pressed={effectiveView === t.key}
                  className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5"
                  style={effectiveView === t.key
                    ? { background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)" }
                    : { color: "var(--c-55)" }}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className={`py-4 sm:py-8 pb-24 sm:pb-24 grid gap-6 ${effectiveView === "both" ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"}`}>

            {/* ── AI Images column ─────────────────────────────────────────── */}
            {(effectiveView === "both" || effectiveView === "image") && (
            <div className="rounded-2xl flex flex-col overflow-hidden"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              <div className="p-5" style={{ borderBottom: "1px solid var(--bd-6)" }}>
                <SectionHeader icon="◈" title="AI Images" subtitle={`${totalBeats} images from script beats`} />
                <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
                  Select Model
                </p>
                <ModelTabs tab={imageModelTab} onTab={setImageModelTab} />
                {imageModelTab === "free" ? <ComingSoonCard /> : (<>
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

                {/* Invisible spacer — mirrors the Duration section in the
                    Video Clips column so both card headers end up the
                    same height and their beat grids line up horizontally. */}
                <div aria-hidden className="invisible">
                  <p className="text-xs font-semibold uppercase tracking-wider mt-3 mb-2">Duration</p>
                  <div className="flex flex-wrap gap-1.5">
                    <button className="px-2.5 py-1 rounded-lg text-xs font-medium">placeholder</button>
                  </div>
                </div>
                </>)}
              </div>

              {/* Image beat grid */}
              {imagesPhase !== "idle" && (
                <div className="px-5 pt-4">
                  <ProgressBar value={imagesPhase === "done" ? totalBeats : imagesProgress} total={totalBeats} />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-3 max-h-72 overflow-y-auto">
                    {DEMO_DATA.promptBeats.map((beat) => (
                      imagesPhase === "done" ? (
                        <BeatTile
                          key={beat.beat}
                          beat={beat}
                          type="image"
                          onOpen={() => openPreview(beat, "image")}
                          onHover={(e) => showBeatPrompt(e, beat.beat, beat.imagePrompt)}
                          onLeave={() => setPromptPopup(null)}
                          onTapInfo={(e) => showBeatPromptTap(e, beat.beat, beat.imagePrompt)}
                        />
                      ) : (
                        <div key={beat.beat}
                          className="relative aspect-video rounded-lg overflow-hidden flex items-center justify-center"
                          style={{ background: "var(--bg-progress)" }}>
                          <span className="text-[9px] px-1.5 py-0.5 rounded relative z-10"
                            style={{
                              background: "oklch(0.72 0.25 285 / 0.1)",
                              color: "oklch(0.72 0.25 285)",
                            }}>
                            generating
                          </span>
                        </div>
                      )
                    ))}
                  </div>
                </div>
              )}

              <div className="p-5 mt-auto space-y-3">
                {/* Invisible mirror of the videos column's status line so
                    the two Generate buttons sit at the same Y. */}
                <p aria-hidden className="invisible text-xs">
                  Runs in background — clips appear as each job completes.
                </p>
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
            )}

            {/* ── AI Video Clips column ────────────────────────────────────── */}
            {(effectiveView === "both" || effectiveView === "video") && (
            <div className="rounded-2xl flex flex-col overflow-hidden"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              <div className="p-5" style={{ borderBottom: "1px solid var(--bd-6)" }}>
                <SectionHeader icon="⚡" title="AI Video Clips" subtitle={`${totalBeats} clips · 5–10s each`} />
                <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
                  Select Model
                </p>
                <ModelTabs tab={videoModelTab} onTab={setVideoModelTab} />
                {videoModelTab === "free" ? <ComingSoonCard /> : (<>
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

                {/* No aspect-ratio selector for video — the clip inherits the
                    source image's ratio. Invisible spacer mirrors the image
                    column's Aspect Ratio so both card headers stay aligned. */}
                <div aria-hidden className="invisible">
                  <p className="text-xs font-semibold uppercase tracking-wider mt-4 mb-2">Aspect Ratio</p>
                  <RatioButtons ratios={FAKE_IMAGE_RATIOS} selected="" onSelect={() => {}} />
                </div>

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
                </>)}
              </div>

              {/* Video clip grid */}
              {videosPhase !== "idle" && (
                <div className="px-5 pt-4">
                  <ProgressBar value={videosPhase === "done" ? totalBeats : 0} total={totalBeats} />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-3 max-h-72 overflow-y-auto">
                    {DEMO_DATA.promptBeats.map((beat) => (
                      videosPhase === "done" ? (
                        <BeatTile
                          key={beat.beat}
                          beat={beat}
                          type="video"
                          onOpen={() => openPreview(beat, "video")}
                          onHover={(e) => showBeatPrompt(e, beat.beat, beat.videoPrompt)}
                          onLeave={() => setPromptPopup(null)}
                          onTapInfo={(e) => showBeatPromptTap(e, beat.beat, beat.videoPrompt)}
                        />
                      ) : (
                        <div key={beat.beat}
                          className="relative aspect-video rounded-lg overflow-hidden flex items-center justify-center"
                          style={{ background: "var(--bg-progress)" }}>
                          <span className="text-[9px] px-1.5 py-0.5 rounded relative z-10"
                            style={{
                              background: "oklch(0.72 0.25 285 / 0.1)",
                              color: "oklch(0.72 0.25 285)",
                            }}>
                            queued
                          </span>
                        </div>
                      )
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
            )}
          </div>
        </main>
      </div>

      <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
        style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
        <div>
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

      {/* Hover-prompt tooltip — a single fixed element positioned from the
          hovered tile so it escapes the beat grid's overflow clipping. */}
      {promptPopup && (
        <div className="touch-only fixed inset-0 z-[399]" onClick={() => setPromptPopup(null)} aria-hidden />
      )}
      {promptPopup && (
        <div
          className="fixed z-[400] rounded-lg shadow-xl pointer-events-none"
          style={{
            left: promptPopup.left,
            top: promptPopup.top,
            width: promptPopup.width,
            transform: promptPopup.above ? "translateY(-100%)" : undefined,
            background: "white",
            padding: "7px",
            border: "1px solid oklch(0 0 0 / 0.08)",
          }}
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-1 text-zinc-500">
            Beat {promptPopup.beatNumber}
          </p>
          <p
            className="text-xs leading-snug text-zinc-800"
            style={{ display: "-webkit-box", WebkitLineClamp: 6, WebkitBoxOrient: "vertical", overflow: "hidden" }}
          >
            {promptPopup.text}
          </p>
        </div>
      )}

      {/* Beat preview dialog — view the asset large, toggle its prompt, or
          edit prompt + model/variant. Mirrors the real generate step; edits
          are cosmetic in the demo. */}
      <Dialog open={!!previewBeat} onOpenChange={(open) => { if (!open) closePreview(); }}>
        <DialogContent
          className="p-0 overflow-x-hidden overflow-y-auto"
          showCloseButton={false}
          style={{
            background: "white",
            display: "flex",
            flexDirection: "column",
            // Pin to the media's computed width so the dialog hugs it. In
            // edit/show-prompt modes enforce a 400px minimum so the panel
            // stays readable for tall media. maxWidth clamps on narrow screens.
            width: previewMediaSize
              ? (previewEditing || previewShowPrompt ? Math.max(previewMediaSize.w, 400) : previewMediaSize.w)
              : undefined,
            maxWidth: "95vw",
            maxHeight: "95vh",
          }}
        >
          {previewBeat && (
            <>
              {/* Action cluster */}
              <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
                {!previewEditing && (
                  <>
                    <button
                      onClick={() => setPreviewShowPrompt((v) => !v)}
                      aria-pressed={previewShowPrompt}
                      className="h-9 px-3 rounded-full flex items-center justify-center text-xs font-medium transition-all hover:scale-105"
                      style={{ background: previewShowPrompt ? "oklch(0.72 0.25 285 / 0.85)" : "oklch(0 0 0 / 0.65)", color: "white", border: "1px solid oklch(1 0 0 / 0.2)" }}
                    >
                      {previewShowPrompt ? "Hide prompt" : "Show prompt"}
                    </button>
                    <button
                      onClick={() => {
                        setPreviewEditedPrompt((previewBeat.type === "image" ? previewBeat.beat.imagePrompt : previewBeat.beat.videoPrompt) ?? "");
                        setPreviewEditing(true);
                      }}
                      title="Edit prompt"
                      aria-label="Edit prompt"
                      className="w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110"
                      style={{ background: "oklch(0 0 0 / 0.65)", color: "white", border: "1px solid oklch(1 0 0 / 0.2)" }}
                    >
                      <Pencil size={16} strokeWidth={2.4} />
                    </button>
                  </>
                )}
                <button
                  onClick={closePreview}
                  title="Close preview"
                  aria-label="Close preview"
                  className="w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110"
                  style={{ background: "oklch(0 0 0 / 0.65)", color: "white", border: "1px solid oklch(1 0 0 / 0.2)" }}
                >
                  <X size={18} strokeWidth={2.4} />
                </button>
              </div>
              {/* Beat number badge */}
              <span
                className="absolute top-3 left-3 z-20 min-w-[28px] h-7 px-2 rounded-full flex items-center justify-center text-xs font-semibold tabular-nums pointer-events-none"
                style={{ background: "oklch(0 0 0 / 0.65)", color: "white", border: "1px solid oklch(1 0 0 / 0.2)" }}
              >
                {previewBeat.beat.beat}
              </span>

              {/* Media — sized to previewMediaSize so the dialog hugs it.
                  onLoad refines the aspect to the exact ratio. */}
              {previewBeat.type === "image" ? (
                <img
                  src={previewBeat.beat.imageUrl}
                  alt={`Beat ${previewBeat.beat.beat}`}
                  onLoad={(e) => setPreviewAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
                  className="block mx-auto"
                  style={{ width: previewMediaSize?.w, height: previewMediaSize?.h, maxWidth: "95vw", maxHeight: "85vh" }}
                />
              ) : (
                <video
                  key={previewBeat.beat.videoUrl}
                  src={previewBeat.beat.videoUrl}
                  onLoadedMetadata={(e) => setPreviewAspect(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
                  className="block mx-auto"
                  style={{ width: previewMediaSize?.w, height: previewMediaSize?.h, maxWidth: "95vw", maxHeight: "85vh" }}
                  autoPlay
                  loop
                  playsInline
                  controls
                />
              )}

              {/* Read-only prompt */}
              {previewShowPrompt && !previewEditing && (
                <div className="px-4 py-3">
                  <p className="text-xs font-semibold mb-1" style={{ color: "oklch(0.35 0 0)" }}>
                    {previewBeat.type === "image" ? "Image prompt" : "Video prompt"} — beat {previewBeat.beat.beat}
                  </p>
                  <p className="text-xs leading-relaxed" style={{ color: "oklch(0.45 0 0)" }}>
                    {(previewBeat.type === "image" ? previewBeat.beat.imagePrompt : previewBeat.beat.videoPrompt) || "—"}
                  </p>
                </div>
              )}

              {/* Edit mode */}
              {previewEditing && (
                <div className="px-4 py-3 space-y-3">
                  <p className="text-xs font-semibold" style={{ color: "oklch(0.35 0 0)" }}>
                    {previewBeat.type === "image" ? "Image prompt" : "Video prompt"} — beat {previewBeat.beat.beat}
                  </p>
                  <textarea
                    value={previewEditedPrompt}
                    onChange={(e) => setPreviewEditedPrompt(e.target.value)}
                    rows={5}
                    className="w-full rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-800 text-xs leading-relaxed p-3 outline-none focus:border-zinc-400 resize-y"
                    placeholder="Describe what this beat should look like…"
                  />
                  <div className="flex gap-3">
                    <div className="flex-1 min-w-0">
                      <label className="block text-xs font-semibold mb-1" style={{ color: "oklch(0.35 0 0)" }}>Model</label>
                      <select
                        value={(previewBeat.type === "image" ? selectedImageModel : selectedVideoModel) ?? ""}
                        onChange={(e) => update(previewBeat.type === "image" ? { selectedImageModel: e.target.value } : { selectedVideoModel: e.target.value })}
                        className="w-full rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-800 text-xs p-2.5 outline-none focus:border-zinc-400"
                      >
                        {(previewBeat.type === "image" ? FAKE_IMAGE_MODELS : FAKE_VIDEO_MODELS).map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex-1 min-w-0">
                      <label className="block text-xs font-semibold mb-1" style={{ color: "oklch(0.35 0 0)" }}>
                        {previewBeat.type === "image" ? "Resolution" : "Duration"}
                      </label>
                      {previewBeat.type === "image" ? (
                        <select className="w-full rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-800 text-xs p-2.5 outline-none focus:border-zinc-400" defaultValue="1K">
                          {["1K", "2K", "4K"].map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      ) : (
                        <select
                          value={String(selectedDuration)}
                          onChange={(e) => update({ selectedDuration: Number(e.target.value) })}
                          className="w-full rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-800 text-xs p-2.5 outline-none focus:border-zinc-400"
                        >
                          {FAKE_DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setPreviewEditing(false)}
                      className="px-4 py-2 rounded-lg text-sm font-medium border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => setPreviewEditing(false)}
                      className="px-4 py-2 rounded-lg text-sm font-semibold text-white"
                      style={{ background: "oklch(0.72 0.25 285)" }}
                    >
                      Save &amp; regenerate
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
