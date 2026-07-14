"use client";

import { useState, use, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
// FreeResourcesButton is temporarily hidden — see comment near
// StepBalanceCard below. Keep the import commented so ESLint's
// no-unused-imports rule stays happy while the JSX usage is out.
// import { FreeResourcesButton } from "@/components/wizard/FreeResourcesButton";
import { useKieActivityStore } from "@/store/kieActivityStore";
import { useProject } from "@/hooks/useProject";
import { RotateCcw, RefreshCw, ChevronsRight, Wand2, Pencil, Video, ImageIcon, ChevronDown, ChevronUp, Eye, X, Upload, Info } from "lucide-react";
import { ImageSparkle } from "@/components/icons/ImageSparkle";
import { StepCostCard } from "@/components/StepCostCard";
import { StepBalanceCard } from "@/components/StepBalanceCard";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ModelPicker } from "@/components/ModelPicker";
import useSWR from "swr";
import type { KieModel, Beat } from "@/lib/types";
import type { ApiStatusResult } from "@/app/api/api-status/route";
import { getModelConfig } from "@/lib/kie/imageModels";
import { getVideoModelConfig } from "@/lib/kie/videoModels";
import { removeLongPauses, encodeMp3 } from "@/lib/audio/silenceRemover";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) return r.json().catch(() => ({})).then((e: { error?: string }) => { throw new Error(e.error ?? `Failed to load (${r.status})`); });
    return r.json().catch(() => ({}));
  });

// Lightweight uniform-grid virtualizer. The generate step can hold 400-700+
// beat tiles; mounting them all (each video tile also spins up an
// IntersectionObserver) makes the page slow to load and janky to scroll.
// This mounts only the rows near the viewport and reserves the rest with two
// full-width spacer rows so the scrollbar length and scroll position stay
// correct. Works in both scroll modes the grid uses:
//   • >=640px: the grid itself scrolls (overflow-y-auto + max-h)
//   • <640px:  no inner scroll — the page scrolls and the grid grows
// Tile height comes from the grid's content width and the tiles' fixed 16:9
// aspect, so it's exact without needing any tile on-screen to measure.
const GRID_GAP = 6; // matches gap-1.5
const GRID_OVERSCAN = 4; // extra rows rendered above/below the viewport
function useGridVirtualizer(count: number, externalRef: { current: HTMLDivElement | null }) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number | null>(null);
  const [metrics, setMetrics] = useState({ cols: 2, rowH: 0 });
  // Seed a small first batch so the grid isn't blank for the frame before
  // measurement runs; recompute corrects it immediately after mount.
  const [range, setRange] = useState({ start: 0, end: 40, topPad: 0, bottomPad: 0 });

  const measure = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const cols = window.matchMedia("(min-width: 640px)").matches ? 4 : 2;
    const contentW = el.clientWidth - 4; // pr-1
    const tileW = (contentW - (cols - 1) * GRID_GAP) / cols;
    const rowH = Math.max(1, Math.round((tileW * 9) / 16) + GRID_GAP);
    // Keep content-visibility's reserved size exact for the rendered tiles.
    el.style.setProperty("--tile-h", `${rowH - GRID_GAP}px`);
    setMetrics((m) => (m.cols === cols && m.rowH === rowH ? m : { cols, rowH }));
  }, []);

  const recompute = useCallback(() => {
    const el = elRef.current;
    const { cols, rowH } = metrics;
    if (!el || rowH <= 0) return;
    const rows = Math.ceil(count / cols);
    const cs = getComputedStyle(el);
    const innerScroll =
      (cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1;
    let viewTop: number;
    let viewBottom: number;
    if (innerScroll) {
      viewTop = el.scrollTop;
      viewBottom = el.scrollTop + el.clientHeight;
    } else {
      const rect = el.getBoundingClientRect();
      viewTop = Math.max(0, -rect.top);
      viewBottom = Math.max(0, window.innerHeight - rect.top);
    }
    const startRow = Math.max(0, Math.floor(viewTop / rowH) - GRID_OVERSCAN);
    const endRow = Math.min(rows, Math.ceil(viewBottom / rowH) + GRID_OVERSCAN);
    const start = startRow * cols;
    const end = Math.min(count, endRow * cols);
    const topPad = Math.max(0, startRow * rowH - GRID_GAP);
    const bottomPad = Math.max(0, (rows - endRow) * rowH);
    setRange((p) =>
      p.start === start && p.end === end && p.topPad === topPad && p.bottomPad === bottomPad
        ? p
        : { start, end, topPad, bottomPad },
    );
  }, [count, metrics]);

  const schedule = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      recompute();
    });
  }, [recompute]);

  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      elRef.current = node;
      externalRef.current = node;
      roRef.current?.disconnect();
      if (!node) return;
      roRef.current = new ResizeObserver(() => {
        measure();
        schedule();
      });
      roRef.current.observe(node);
      measure();
      schedule();
    },
    [externalRef, measure, schedule],
  );

  // Recompute when metrics/count change and on any scroll (capture:true also
  // catches scroll from the inner grid / outer wrapper, which don't bubble).
  useEffect(() => {
    schedule();
  }, [schedule, metrics, count]);
  useEffect(() => {
    const onScroll = () => schedule();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [schedule]);

  return { setRef, ...range };
}

function isCreditError(raw: string | undefined | null): boolean {
  const msg = (raw ?? "").toLowerCase();
  // Keep the matcher tight — "quota exceeded" was catching KIE's
  // rate-limit errors (per-minute / per-day model caps) and telling
  // users their wallet was empty when it wasn't. Balance issues are
  // "insufficient credits/balance/fund", "out of credit", "no credit",
  // or the server route surfacing an HTTP 402 (translated to a 402
  // response the client detects separately).
  return msg.includes("credits insufficient")
    || msg.includes("insufficient credits")
    || (msg.includes("insufficient") && (msg.includes("balance") || msg.includes("credit") || msg.includes("fund")))
    || msg.includes("credits remaining")
    || msg.includes("credit balance");
}

// True when the error string indicates "this model can't accept your
// request" rather than a transient blip. When this fires, retrying
// the same model is hopeless — the only fix is switching models —
// so we sweep any other queued/rendering beats to failed instead of
// letting them burn through one by one.
function isModelTerminalError(raw: string | undefined | null): boolean {
  const msg = (raw ?? "").toLowerCase();
  return msg.includes("this field is required")
    || msg.includes("invalid model")
    || msg.includes("rejected the request")
    || msg.includes("temporarily paused")
    || msg.includes("video quality cannot be empty")
    || msg.includes("video model rejected");
}

function friendlyError(raw: string | undefined | null): string {
  const msg = (raw ?? "").toLowerCase();
  if (msg.includes("credits insufficient") || msg.includes("insufficient credits") || (msg.includes("insufficient") && (msg.includes("balance") || msg.includes("credit") || msg.includes("fund"))))
    return "Insufficient KIE credits — top up your account at kie.ai";
  if (msg.includes("credits remaining") || msg.includes("credit balance"))
    return "Insufficient KIE credits — top up your account at kie.ai";
  if (msg.includes("quota_exceeded") || msg.includes("quota exceeded"))
    return "KIE rate limit reached — wait a minute and try again, or switch to a different model";
  if (msg.includes("invalid_api_key") || msg.includes("invalid api key") || msg.includes("unauthorized") || (msg.includes("api key") && msg.includes("invalid")))
    return "API key is invalid — go to Settings to update it";
  if (msg.includes("api key") && (msg.includes("missing") || msg.includes("not set") || msg.includes("required")))
    return "API key not set — go to Settings to add it";
  if (msg.includes("internal error") || msg.includes("internal server error") || msg.includes("fail code 500"))
    return "The selected model is temporarily unavailable — try a different one";
  if (msg.includes("temporarily paused") || msg.includes("interface is paused") || msg.includes("model is paused") || msg.includes("paused by kie"))
    return "KIE has temporarily paused this model — try a different one";
  if (msg.includes("this field is required"))
    return "Video model rejected the request — try a different video model";
  if (msg.includes("timed out") || msg.includes("timeout"))
    return "Still generating — this can take longer than usual on some models. Refresh the page to check status; the job will finish on KIE in the background.";
  if (msg.includes("no task id") || msg.includes("no taskid"))
    return "Failed to queue task — the model may be unavailable, try another";
  // KIE / Veo safety filters flag anything the model interprets as a
  // reference to a real person, brand, copyrighted character, or
  // sensitive content. It's a per-beat problem — the same model with
  // a different prompt usually works — so we route the user to
  // rephrasing rather than to changing the model.
  if (msg.includes("safety filter") || msg.includes("safety_filter")
    || msg.includes("prominent public figure")
    || msg.includes("content policy") || msg.includes("policy violation")
    || msg.includes("blocked by moderation") || msg.includes("moderated"))
    return "Content policy block — the prompt references something the model refuses to render (real person, brand, or restricted topic). Rephrase this beat's prompt in Prompt Studio, then retry.";
  if (msg.includes("nsfw") || msg.includes("unsafe content") || msg.includes("adult content"))
    return "Content policy block — the prompt was flagged as unsafe. Rephrase this beat's prompt in Prompt Studio, then retry.";
  if (msg.includes("no url") || msg.includes("no image url") || msg.includes("completed but no url"))
    return "Image was generated but could not be retrieved — try again";
  if (msg.includes("rate limit") || msg.includes("too many requests"))
    return "Too many requests — wait a moment and try again";
  if (raw && raw.length > 0) return raw;
  return "Something went wrong — please try again";
}

interface PageProps {
  params: { projectId: string };
}

function VoiceOption({ model, selected, onSelect, isPlaying, onPlayToggle }: {
  model: KieModel; selected: boolean; onSelect: () => void;
  isPlaying: boolean; onPlayToggle: (id: string | null) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!isPlaying && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
  }, [isPlaying]);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  function togglePreview(e: React.MouseEvent) {
    e.stopPropagation();
    if (!model.previewUrl) return;
    if (isPlaying) {
      onPlayToggle(null);
    } else {
      onSelect(); // previewing a voice should also select it
      const audio = new Audio(model.previewUrl);
      audioRef.current = audio;
      audio.onended = () => onPlayToggle(null);
      audio.onerror = () => onPlayToggle(null);
      audio.play().catch(() => onPlayToggle(null));
      onPlayToggle(model.id);
    }
  }

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
        border: "1px solid var(--bd-card)",
        color: "var(--c-60)",
      }}
    >
      <div className="flex items-center gap-2">
        <p className="font-medium text-xs flex-1 truncate">{model.name}</p>
        {model.previewUrl && (
          <button
            onClick={togglePreview}
            title={isPlaying ? "Stop preview" : "Preview voice"}
            className="w-6 h-6 rounded flex items-center justify-center shrink-0 transition-colors"
            style={{
              background: isPlaying ? "oklch(0.72 0.25 285 / 0.15)" : "oklch(0.2 0 0)",
              color: isPlaying ? "oklch(0.72 0.25 285)" : "var(--c-45)",
              border: "1px solid var(--bd-10)",
            }}
          >
            {isPlaying ? (
              <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
                <rect x="0.5" y="0" width="2.5" height="8" rx="0.5" />
                <rect x="5" y="0" width="2.5" height="8" rx="0.5" />
              </svg>
            ) : (
              <svg width="7" height="9" viewBox="0 0 7 9" fill="currentColor">
                <path d="M0 0.5L7 4.5L0 8.5V0.5Z" />
              </svg>
            )}
          </button>
        )}
      </div>
      {model.tags && model.tags.length > 0 && (
        <div className="flex gap-1 mt-1.5 flex-wrap">
          {model.tags.map((tag) => (
            <span key={tag} className="px-1.5 py-0.5 rounded text-xs"
              style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
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

// Per-track overflow menu shown next to each voiceover's audio player.
// Browser-native audio controls have their own ⋮ dropdown (with their
// own download / playback rate / picture-in-picture entries) that we
// can't customize — this is a parallel menu under our control with
// Download (a real download link) and Delete (opens the confirmation
// dialog at the page level). Click-outside dismisses; Escape closes.
function VoiceoverTrackMenu({
  url,
  downloadName,
  onRequestDelete,
}: {
  url: string;
  downloadName: string;
  onRequestDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Track options"
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-7 h-7 rounded-lg flex items-center justify-center text-base leading-none hover:opacity-90 transition-opacity"
        style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[160px] rounded-xl p-1 shadow-lg"
          style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}
        >
          <a
            href={url}
            download={downloadName}
            onClick={() => setOpen(false)}
            role="menuitem"
            className="block w-full text-left px-3 py-2 rounded-lg text-xs hover:opacity-90 transition-opacity"
            style={{ color: "var(--c-60)" }}
          >
            ↓ Download
          </a>
          <button
            type="button"
            onClick={() => { setOpen(false); onRequestDelete(); }}
            role="menuitem"
            className="block w-full text-left px-3 py-2 rounded-lg text-xs hover:opacity-90 transition-opacity"
            style={{ color: "oklch(0.7 0.22 25)" }}
          >
            🗑 Delete voiceover
          </button>
        </div>
      )}
    </div>
  );
}

// Auto-pause off-screen video tiles. With 100+ beats the grid used
// to autoplay every video at once — even muted, each one keeps the
// compositor decoding frames and scrolling becomes janky on weaker
// machines. IntersectionObserver here pauses any tile outside the
// viewport (with a small rootMargin so videos that are about to
// scroll in start playing slightly early). When the tile leaves,
// pause + currentTime=0 so it visibly resets — feels intentional,
// not buggy.
function LazyVideoTile(props: React.VideoHTMLAttributes<HTMLVideoElement>) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const visibleRef = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => {
        visibleRef.current = entry.isIntersecting;
        if (entry.isIntersecting) {
          // play() returns a promise that rejects on rapid mount/
          // unmount cycles or autoplay-blocked browsers. Swallow.
          el.play().catch(() => {});
        } else {
          try { el.pause(); el.currentTime = 0; } catch { /* ignore */ }
        }
      },
      { rootMargin: "200px", threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // Changing a <video>'s src attribute does NOT reload the media on its
  // own — the HTML spec requires an explicit load(). Without this, a
  // regenerated clip keeps showing the previous video because React
  // only swaps the attribute on the already-mounted element (the DB has
  // the new URL, but the tile never re-fetches). Reload whenever src
  // changes, then resume playback if the tile is currently in view.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.load();
    if (visibleRef.current) el.play().catch(() => {});
  }, [props.src]);
  // Default to NOT autoplaying — the IO toggles play() once mounted.
  // preload="metadata" keeps the poster frame populated so the tile
  // doesn't flash empty on first paint.
  return <video ref={ref} {...props} autoPlay={false} preload="metadata" />;
}

function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs" style={{ color: "var(--c-45)" }}>
        <span>{value} / {total}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
        <div className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))" }} />
      </div>
    </div>
  );
}

export default function GeneratePage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project, mutate } = useProject(projectId);

  const { data: ttsModels, error: ttsError } = useSWR<KieModel[]>("/api/kie/models?type=tts", fetcher);
  const { data: imageModels } = useSWR<KieModel[]>("/api/kie/models?type=image", fetcher);
  const { data: videoModels } = useSWR<KieModel[]>("/api/kie/models?type=video", fetcher);
  // KIE balance for the proactive credit display + warning banner.
  // Refreshes every 30s so the number stays roughly current without
  // hammering the credit endpoint.
  const { data: apiStatus, mutate: mutateApiStatus } = useSWR<ApiStatusResult>(
    "/api/api-status",
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 30_000 }
  );

  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [selectedTtsModel, setSelectedTtsModel] = useState<string | null>(null);
  const [selectedImageModel, setSelectedImageModel] = useState<string | null>(null);
  const [selectedAspectRatio, setSelectedAspectRatio] = useState("16:9");
  const [selectedResolution, setSelectedResolution] = useState<string | null>(null);
  const [selectedVideoModel, setSelectedVideoModel] = useState<string | null>(null);
  const [selectedVideoAspectRatio, setSelectedVideoAspectRatio] = useState("16:9");
  const [selectedDuration, setSelectedDuration] = useState<string | number | null>(null);
  const [selectedVideoResolution, setSelectedVideoResolution] = useState<string | null>(null);
  // Guarded resolution value to send with any video POST. Drops the
  // picker's selection if it isn't in the CURRENT model's resolutions
  // list — closes the race where a user rapid-clicks Regen between
  // switching models and the resolution-reset effect firing, which
  // would otherwise ship the old model's tier to the new model and
  // KIE would silently default to the cheapest supported value.
  const safeVideoResolution = (() => {
    if (!selectedVideoModel || !selectedVideoResolution) return null;
    const cfg = getVideoModelConfig(selectedVideoModel);
    if (!cfg.resolutions?.includes(selectedVideoResolution)) return null;
    return selectedVideoResolution;
  })();
  const [voiceTab, setVoiceTab] = useState<"female" | "male">("female");

  const initialTtsSelected = useRef(false);

  const [navigating, setNavigating] = useState(false);
  // The bottom-bar "skip warnings" drawer stays hidden until the user
  // first clicks Continue while beats are still ungenerated. That first
  // click slides the drawer up instead of navigating; the label then
  // flips to "Continue anyway" so a second click actually advances.
  const [warningsRevealed, setWarningsRevealed] = useState(false);
  // Per-panel dismissal of the "script edited — beats are stale" banner.
  // Reset whenever staleness clears so a fresh edit re-shows the banner.
  const [staleImageDismissed, setStaleImageDismissed] = useState(false);
  const [staleVideoDismissed, setStaleVideoDismissed] = useState(false);
  // Per-panel dismissal of the generation-failure banners. Cleared by the
  // reset helpers at the start of every new run, so a fresh failure always
  // re-surfaces the banner even if the user dismissed the previous one.
  const [imageErrorDismissed, setImageErrorDismissed] = useState(false);
  const [videoErrorDismissed, setVideoErrorDismissed] = useState(false);
  const [generatingTts, setGeneratingTts] = useState(false);
  const [ttsProgress, setTtsProgress] = useState<{ current: number; total: number } | null>(null);
  const [ttsStatusMsg, setTtsStatusMsg] = useState<string>("");
  const [removingPauses, setRemovingPauses] = useState(false);
  const [removePausesStatus, setRemovePausesStatus] = useState("");
  const [generatingImages, setGeneratingImages] = useState(false);
  const [stoppingImages, setStoppingImages] = useState(false);
  // The latest error message from the current image-gen run. We
  // overwrite this on every new failure so the banner only ever
  // shows ONE error — whichever was most recent. Cleared at the
  // start of every new run.
  const [imageRunError, setImageRunError] = useState<string | null>(null);
  // Same shape for the video side. Captures any action-level failure
  // (queue rejection, resume failure, single-regen rejection, etc.)
  // so the section banner above the Queue button is the single home
  // for video-failure context — no more toasts that scroll off-screen.
  const [videoRunError, setVideoRunError] = useState<string | null>(null);
  // When set, a modal alerts the user that a video can't be made because
  // the beat(s) have no source image. Holds the message body.
  const [noImageAlert, setNoImageAlert] = useState<string | null>(null);

  // Layout: "double" = image + video panels side by side (default);
  // "single" = one panel at a time (images first → Continue → video).
  const [columnView, setColumnView] = useState<"single" | "double">("double");
  const [singleStep, setSingleStep] = useState<"image" | "video">("image");
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("generate:columnView") : null;
    if (saved === "single" || saved === "double") setColumnView(saved);
  }, []);
  function chooseColumnView(v: "single" | "double") {
    setColumnView(v);
    try { window.localStorage.setItem("generate:columnView", v); } catch { /* ignore */ }
  }
  // On mobile we FORCE single-panel: rendering both panels' beat grids
  // (hundreds of tiles each) at once froze the page and made scrolling
  // painful. The toggle is also hidden on mobile. Desktop keeps the
  // user's chosen view.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const effectiveView: "single" | "double" = isMobile ? "single" : columnView;
  // Refs to scroll the error banners into view once they appear so
  // the user actually sees the failure summary instead of having to
  // scan the page for it.
  const imageErrorBannerRef = useRef<HTMLDivElement | null>(null);
  // Image + video grid scroll containers — used by the scroll-to-bottom
  // affordance so users jump straight to whatever just queued / finished
  // without having to drag the thumb through a long list of beats.
  const imageGridRef = useRef<HTMLDivElement | null>(null);
  const videoGridRef = useRef<HTMLDivElement | null>(null);
  const videoErrorBannerRef = useRef<HTMLDivElement | null>(null);
  // Latch the "was visible" state so we only scroll-into-view once per
  // banner appearance (not on every re-render while it's open).
  const imageBannerShown = useRef(false);
  const videoBannerShown = useRef(false);

  // Wipe accumulated error UI state before any new user-initiated
  // generation action. Without this, stale errors from a previous
  // attempt linger on the banner even after the user has picked a
  // different model and clicked Generate / Queue / Regenerate —
  // making it look like the new action already failed.
  function resetImageErrorBanner() {
    setImageRunError(null);
    setImageErrorDismissed(false);
    imageBannerShown.current = false;
  }
  function resetVideoErrorBannerLocal() {
    // Local-only reset: clears React state for the banner without
    // touching the DB. Used by single-beat actions (regen), where
    // we don't want to wipe other failed beats' video_error / status
    // just because the user retried one of them. The acted-on beat
    // gets its own video_error cleared by the queue route's UPDATE.
    setVideoRunError(null);
    setVideoErrorDismissed(false);
    videoBannerShown.current = false;
  }

  function resetVideoErrorBanner() {
    setVideoRunError(null);
    setVideoErrorDismissed(false);
    videoBannerShown.current = false;
    // Project-wide reset: clears video_error on every beat and flips
    // failed beats' status back to null so the banner fully resets.
    // Use this only for bulk actions (queue / resume) where the user
    // is sweeping across multiple beats and a clean slate is what
    // they want. After the route resolves, re-mutate SWR so the UI
    // redraws — without this the banner would linger for up to the
    // SWR refresh interval.
    void (async () => {
      try {
        await fetch("/api/generate/videos/clear-errors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        });
        await mutate();
      } catch { /* best-effort — banner UI already cleared via state */ }
    })();
  }
  // Latched flag: true after the user clicks Stop, false while a new
  // run is starting. Lets us suppress the "X images didn't generate"
  // partial-completion warning when the gap is intentional rather
  // than a model failure.
  const [userStoppedImages, setUserStoppedImages] = useState(false);
  // AbortController for the image generation loop. Halts submission
  // between batches (preventing further KIE charges on unsubmitted
  // beats) and stops the local poll loop. Already-submitted beats keep
  // running on KIE; their results land via the page-resume effect, the
  // cron, or the webhook — no work or money is lost.
  const imagesAbortRef = useRef<AbortController | null>(null);
  const [queuingVideos, setQueuingVideos] = useState(false);
  const [pausingVideos, setPausingVideos] = useState(false);
  const [resumingVideos, setResumingVideos] = useState(false);
  const [imagesProgress, setImagesProgress] = useState(0);
  // Pending URLs are only set during active generation; otherwise fall back to DB values via project
  const [pendingTtsUrl, setPendingTtsUrl] = useState<string | null>(null);
  const [pendingTtsCleanedUrl, setPendingTtsCleanedUrl] = useState<string | null>(null);
  const [cleanedUrlInvalidated, setCleanedUrlInvalidated] = useState(false);
  // Delete-voiceover flow. Click the trash icon → confirm dialog →
  // server PATCH clears the project's tts_url / tts_cleaned_url /
  // tts_script_hash / tts_voice_id and removes the R2 objects. Local
  // pending* state is reset alongside so the audio elements unmount
  // without waiting for the SWR refetch.
  const [deleteVoiceoverConfirmOpen, setDeleteVoiceoverConfirmOpen] = useState(false);
  // Regenerate All confirms before firing because it wipes every
  // existing image on the project — paid work the user might lose
  // by mis-clicking the secondary button.
  const [regenerateAllConfirmOpen, setRegenerateAllConfirmOpen] = useState(false);
  // Submitting flags for modal action buttons. Each holds the modal
  // open with a visible spinner while the click handler is in flight —
  // long-running image / regen work continues in the background after
  // the modal closes, but the brief in-modal feedback confirms the
  // click before dismissing. Matches the project's modal-loading rule.
  const [regenerateAllSubmitting, setRegenerateAllSubmitting] = useState(false);
  const [deletingVoiceover, setDeletingVoiceover] = useState(false);

  // Per-beat video regenerate flow. The icon overlay on each generated
  // video clip opens this modal with the beat number stashed; confirming
  // hits /api/generate/videos for just that one beat. The route already
  // nulls video_url/video_status/video_job_id/video_error when it accepts
  // a new submission, so we don't need a separate clear pass first — the
  // old R2 file becomes an orphan (next regen overwrites its key with a
  // fresh upload, so disk usage stays bounded).
  // Per-beat regen tracker instead of a single boolean mutex — lets
  // the user click Regenerate on multiple beats without waiting for
  // any one to finish. Each entry is a beat number currently mid-POST;
  // the tile spinner and disabled state derive from set membership so
  // only the beats being regenerated show the busy state, not the
  // whole grid.
  const [regeneratingBeats, setRegeneratingBeats] = useState<Set<number>>(new Set());
  // Optimistically flip the given beats to "queued" in the SWR cache so
  // a generate / regenerate / retry click reflects in the UI instantly,
  // instead of waiting for the POST round-trip and the next poll tick.
  // It also makes hasActiveGeneration() true immediately, so useProject
  // switches to the fast GEN_MS poll right away. The subsequent mutate()
  // (on success or failure) reconciles the cache with server truth —
  // which reverts this if the request failed.
  function optimisticQueueVideos(beatNumbers: Set<number>) {
    void mutate(
      (current?: { beats?: Beat[] } & Record<string, unknown>) => {
        if (!current?.beats) return current;
        return {
          ...current,
          beats: current.beats.map((b) =>
            beatNumbers.has(b.beatNumber)
              ? { ...b, videoStatus: "queued" as const, videoError: undefined }
              : b,
          ),
        };
      },
      { revalidate: false },
    );
  }

  // Single-beat video regen — fires immediately from the per-tile
  // overlay button. The previous version routed through a confirm
  // modal; we dropped the modal so the overlay click is the action.
  async function regenerateVideoBeat(beatNumber: number, promptOverride?: string) {
    // SINGLE-BEAT path: clear ONLY the React banner state. Do not
    // touch the DB sweep — other failed beats should keep their
    // error context until the user explicitly retries them too.
    resetVideoErrorBannerLocal();
    const beat = beats.find((b) => b.beatNumber === beatNumber);
    if (!beat || !beat.videoPrompt) {
      setVideoRunError("Cannot generate — this beat has no video prompt yet.");
      return;
    }
    // Every video model is image-to-video: no source image, nothing to
    // animate. Block the action and alert the user to make the image first.
    if (!beat.imageUrl) {
      setNoImageAlert(`Beat ${beatNumber} doesn't have an image yet. Every video is generated from a beat's image, so you'll need to generate this beat's image first — then you can create its video.`);
      return;
    }
    if (!selectedVideoModel) {
      setVideoRunError("Pick a video model first.");
      return;
    }
    // Add this beat's number to the in-flight set so only its own
    // tile disables/spins during the POST — leaves every other tile
    // clickable so the user can fire off more beats in parallel.
    setRegeneratingBeats((prev) => {
      const next = new Set(prev);
      next.add(beat.beatNumber);
      return next;
    });
    // Instant UI feedback — flip this beat to "queued" before the POST.
    optimisticQueueVideos(new Set([beat.beatNumber]));
    try {
      const res = await fetch("/api/generate/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          beats: [{ beatNumber: beat.beatNumber, videoPrompt: promptOverride?.trim() || beat.videoPrompt, imageUrl: beat.imageUrl }],
          modelId: selectedVideoModel,
          aspectRatio: selectedVideoAspectRatio,
          ...(selectedDuration !== null ? { duration: selectedDuration } : {}),
          ...(safeVideoResolution ? { resolution: safeVideoResolution } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { submitted?: number; failures?: { beatNumber: number; error: string }[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
      if (data.failures?.length) {
        setVideoRunError(friendlyError(data.failures[0].error));
      } else {
        toast.success(`Beat ${beat.beatNumber} re-queued`);
        setVideosSubmitted(true);
      }
      // Reconcile with server truth (queued/submitting, or reverts the
      // optimistic flip if the submit was rejected per-beat).
      await mutate();
    } catch (err) {
      setVideoRunError(friendlyError(err instanceof Error ? err.message : null));
      await mutate(); // revert the optimistic flip on failure
    } finally {
      setRegeneratingBeats((prev) => {
        const next = new Set(prev);
        next.delete(beat.beatNumber);
        return next;
      });
    }
  }

  // Track which beat is in the middle of a cancel request so the tile
  // can disable its Stop button between click and DB commit — prevents
  // a double-tap from firing two POSTs.
  const [stoppingBeat, setStoppingBeat] = useState<number | null>(null);
  async function stopVideoBeat(beatNumber: number) {
    if (stoppingBeat !== null) return;
    setStoppingBeat(beatNumber);
    try {
      const res = await fetch("/api/generate/videos/cancel-beat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, beatNumber }),
      });
      const data = await res.json().catch(() => ({})) as { cancelled?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Cancel failed (HTTP ${res.status})`);
      if ((data.cancelled ?? 0) === 0) {
        // Beat already landed in a terminal state between the tile
        // render and this click. Treat as success — the user got the
        // outcome they wanted, just via a different path.
        toast.info(`Beat ${beatNumber} already finished before it could be stopped`);
      } else {
        toast.success(`Beat ${beatNumber} stopped`);
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to stop beat");
    } finally {
      setStoppingBeat(null);
    }
  }

  async function deleteVoiceover() {
    setDeletingVoiceover(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_voiceover: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to delete voiceover");
      }
      setPendingTtsUrl(null);
      setPendingTtsCleanedUrl(null);
      setCleanedUrlInvalidated(true);
      setDeleteVoiceoverConfirmOpen(false);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete voiceover");
    } finally {
      setDeletingVoiceover(false);
    }
  }
  const [videosSubmitted, setVideosSubmitted] = useState(false);
  const [regenBeats, setRegenBeats] = useState<Set<number>>(new Set());
  const [clearingImages, setClearingImages] = useState(false);
  // Sticky "KIE has no credits" banner. Set when any submission fails
  // with an insufficient-credit error and cleared on the next
  // successful submit or balance refresh. We can't rely on the toast
  // alone because it disappears in 4s — the user can miss it on a
  // long-running job.
  const [outOfCredits, setOutOfCredits] = useState(false);
  // Full closable preview: tile click or the eye button opens a
  // centered modal showing the asset. Prompt text stays hidden until
  // the user enters edit mode (pencil in the dialog), which shrinks
  // the media and reveals an editable prompt + Save & regenerate.
  // (Replaced the old desktop floating hover preview.)
  const [previewBeat, setPreviewBeat] = useState<{ beat: Beat; type: "image" | "video" } | null>(null);
  const [previewEditing, setPreviewEditing] = useState(false);
  const [previewEditedPrompt, setPreviewEditedPrompt] = useState("");
  const [previewSubmitting, setPreviewSubmitting] = useState(false);
  // Read-only prompt visibility toggle ("Show prompt") — independent
  // of edit mode, which has its own editable textarea.
  const [previewShowPrompt, setPreviewShowPrompt] = useState(false);
  // Hover prompt popup — a single, GLOBAL fixed-position card (rendered
  // once at the page root) rather than a per-tile element, so it escapes
  // the beat grids' overflow-y-auto clipping. Positioned from the hovered
  // tile's viewport rect; flips above the tile when it's low in the
  // viewport so it never runs off the bottom edge.
  const [promptPopup, setPromptPopup] = useState<
    { beatNumber: number; text: string; left: number; top: number; width: number; above: boolean } | null
  >(null);
  function showBeatPrompt(e: React.MouseEvent, beatNumber: number, text?: string | null) {
    if (!text) return;
    // Touch devices fire mouseenter on tap, which would pop this hover
    // tooltip over the preview dialog the same tap opens. The preview
    // already shows the prompt, so skip the tooltip when there's no hover.
    if (typeof window !== "undefined" && window.matchMedia?.("(hover: none)").matches) return;
    const r = e.currentTarget.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
    const above = r.bottom > window.innerHeight * 0.62;
    setPromptPopup({ beatNumber, text, left, width, top: above ? r.top - 6 : r.bottom + 6, above });
  }
  // Touch equivalent of the hover tooltip: the per-tile info button taps
  // this to show the prompt (positioned over the tile), dismissed by the
  // backdrop tap. stopPropagation keeps the tile's own tap (preview/menu)
  // from firing.
  function showBeatPromptTap(e: React.MouseEvent, beatNumber: number, text?: string | null) {
    e.stopPropagation();
    if (!text) {
      toast("No prompt for this beat yet.");
      return;
    }
    const tile = ((e.currentTarget as HTMLElement).closest(".cv-tile") ?? e.currentTarget) as HTMLElement;
    const r = tile.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
    const above = r.bottom > window.innerHeight * 0.62;
    setPromptPopup({ beatNumber, text, left, width, top: above ? r.top - 6 : r.bottom + 6, above });
  }

  // Generate/Upload menu for a beat that has no asset yet. Rendered as a
  // single global fixed element (like the prompt popup) positioned over
  // the clicked tile, so it isn't clipped by the grids' overflow.
  const [assetMenu, setAssetMenu] = useState<{ beatNumber: number; type: "image" | "video"; actionLabel: string; left: number; top: number } | null>(null);
  const [uploadingBeat, setUploadingBeat] = useState<number | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadRef = useRef<{ beatNumber: number; type: "image" | "video" } | null>(null);

  // The first menu option adapts to the beat's state: fresh → Generate,
  // already has an asset → Regenerate, failed → Retry (paused video →
  // Resume). Upload is always the second option.
  function beatActionLabel(b: Beat, type: "image" | "video"): string {
    if (type === "image") return b.imageUrl ? "Regenerate" : b.imageStatus === "failed" ? "Retry" : "Generate";
    return b.videoUrl ? "Regenerate" : b.videoStatus === "failed" ? "Retry" : b.videoStatus === "paused" ? "Resume" : "Generate";
  }
  function openAssetMenu(e: React.MouseEvent, beat: Beat, type: "image" | "video") {
    const r = e.currentTarget.getBoundingClientRect();
    setPromptPopup(null);
    setAssetMenu({ beatNumber: beat.beatNumber, type, actionLabel: beatActionLabel(beat, type), left: r.left + r.width / 2, top: r.top + r.height / 2 });
  }

  // Kick off a device file picker for the beat; the actual upload runs in
  // onUploadFileChange once a file is chosen.
  function triggerBeatUpload(beatNumber: number, type: "image" | "video") {
    pendingUploadRef.current = { beatNumber, type };
    setAssetMenu(null);
    const input = uploadInputRef.current;
    if (input) {
      input.accept = type === "image" ? "image/*" : "video/*";
      input.value = "";
      input.click();
    }
  }

  async function onUploadFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const pending = pendingUploadRef.current;
    pendingUploadRef.current = null;
    if (!file || !pending) return;
    const { beatNumber, type } = pending;
    setUploadingBeat(beatNumber);
    try {
      let publicUrl: string;
      if (type === "image") {
        // Images go through a same-origin server upload (no browser→R2
        // PUT), so a missing R2 CORS policy can't break it with "Failed
        // to fetch". Images are small enough for the platform body cap.
        const fd = new FormData();
        fd.append("file", file);
        fd.append("projectId", projectId);
        fd.append("folder", "beat-uploads/images");
        const upRes = await fetch(`/api/upload/direct`, { method: "POST", body: fd });
        const ud = await upRes.json().catch(() => ({})) as { url?: string; error?: string };
        if (!upRes.ok || !ud.url) throw new Error(ud.error ?? "Could not upload the image");
        publicUrl = ud.url;
      } else {
        // Large video files use a presigned direct-PUT to R2 to bypass
        // the platform request-body cap (requires bucket CORS).
        const presignRes = await fetch(`/api/upload/presign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId,
            folder: "beat-uploads/videos",
            filename: file.name,
            contentType: file.type,
          }),
        });
        const pd = await presignRes.json().catch(() => ({})) as { uploadUrl?: string; publicUrl?: string; error?: string };
        if (!presignRes.ok || !pd.uploadUrl || !pd.publicUrl) throw new Error(pd.error ?? "Could not prepare the upload");

        const putRes = await fetch(pd.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
        if (!putRes.ok) throw new Error(`Upload to storage failed (HTTP ${putRes.status})`);
        publicUrl = pd.publicUrl;
      }

      // Point the beat row at the uploaded asset.
      const setRes = await fetch(`/api/projects/${projectId}/beats/set-asset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beatNumber, type, url: publicUrl }),
      });
      const sd = await setRes.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!setRes.ok) throw new Error(sd.error ?? "Failed to save the uploaded asset");

      await mutate();
      // If this upload was launched from the open preview, close it so the
      // freshly-uploaded asset (mutate has landed) is what the tile shows.
      if (previewBeat && previewBeat.beat.beatNumber === beatNumber) {
        setPreviewEditing(false);
        setPreviewBeat(null);
        setPreviewAspect(null);
      }
      if (type === "image") {
        // Derive this beat's image + video prompts FROM the uploaded
        // image (Claude vision) so the prompts match the picture instead
        // of the stale script-derived text. Best-effort — the upload
        // already succeeded; a prompt-gen failure just leaves the old
        // prompts in place.
        const genToastId = toast.loading(`Analyzing beat ${beatNumber}'s image…`);
        try {
          const pr = await fetch(`/api/generate/prompts-from-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId, beatNumber, imageUrl: publicUrl }),
          });
          const pd = await pr.json().catch(() => ({})) as { ok?: boolean; error?: string };
          if (!pr.ok) throw new Error(pd.error ?? "Prompt generation failed");
          await mutate();
          toast.success(`Beat ${beatNumber} image uploaded — prompts updated`, { id: genToastId });
        } catch (e) {
          toast.error(`Beat ${beatNumber} image uploaded, but prompt generation failed — ${e instanceof Error ? e.message : "try again"}.`, { id: genToastId });
        }
      } else {
        toast.success(`Beat ${beatNumber} ${type} uploaded`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingBeat(null);
    }
  }
  // True while the currently-previewed beat is uploading — used to blank
  // the preview body and show an "Uploading…" state instead.
  const isUploadingPreview = previewBeat != null && uploadingBeat === previewBeat.beat.beatNumber;
  // Intrinsic aspect ratio (w/h) of the previewed media, read from the
  // element on load. The dialog can't hug the media off CSS alone: a
  // `fit-content` box measures the media's *intrinsic* width, not its
  // height-constrained display width, so tall/oversized assets leave
  // white side gaps. Instead we detect the real ratio and compute an
  // explicit pixel box that fits the viewport at that exact ratio.
  const [previewAspect, setPreviewAspect] = useState<number | null>(null);
  // Re-render trigger for viewport resizes so the memoized size below
  // recomputes against the new window dimensions.
  const [viewportTick, setViewportTick] = useState(0);
  useEffect(() => {
    const onResize = () => setViewportTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Computed synchronously during render (not in an effect) so switching
  // modes — e.g. entering edit — sizes the media in the SAME frame the
  // editor appears. An effect would paint one frame with the old (larger)
  // size beside the new editor before correcting, which read as a flash.
  const previewMediaSize = useMemo<{ w: number; h: number } | null>(() => {
    if (!previewAspect || typeof window === "undefined") return null;
    // Reserve for the panel below the media. In edit mode the media is
    // kept large (only a small reserve) and the taller editor simply
    // scrolls into view below it. Show-prompt keeps a light reserve;
    // plain view uses none.
    const chrome = previewEditing ? 120 : previewShowPrompt ? 170 : 0;
    // These caps MUST match the media element's own style caps
    // (maxWidth 95vw / maxHeight 85vh). If they diverge, a height-bound
    // box gets a width sized for one height but clamped to another — the
    // element ends up wider than the media's aspect ratio, and a <video>
    // letterboxes to fit, showing white bars beside the frame.
    const maxW = window.innerWidth * 0.95;
    const maxH = Math.max(window.innerHeight * 0.85 - chrome, 240);
    const w = Math.round(Math.min(maxW, maxH * previewAspect));
    return { w, h: Math.round(w / previewAspect) };
    // viewportTick forces recompute on resize.
  }, [previewAspect, previewEditing, previewShowPrompt, viewportTick]);

  // Open the preview, seeding the media aspect ratio SYNCHRONOUSLY from
  // the grid-cached source image. Because the grid already loaded these
  // images, `new Image()` on the same URL reports `complete` with real
  // dimensions immediately — so previewMediaSize is non-null on the very
  // first render and there's no null-aspect frame to flash. For video we
  // seed from the same source image (the clip follows its ratio); the
  // <video> then refines to the exact ratio via onLoadedMetadata.
  function openPreview(beat: Beat, type: "image" | "video") {
    const src = beat.imageUrl;
    if (src) {
      const probe = new Image();
      probe.src = src;
      if (probe.complete && probe.naturalWidth) {
        setPreviewAspect(probe.naturalWidth / probe.naturalHeight);
      }
    }
    setPreviewBeat({ beat, type });
  }

  const beats: Beat[] = project?.beats ?? [];
  // Beats that have a video prompt — the video grid renders only these.
  const videoBeatList = useMemo(() => beats.filter((b) => b.videoPrompt), [beats]);
  // Virtualize both grids so only the tiles near the viewport are mounted.
  const imgGrid = useGridVirtualizer(beats.length, imageGridRef);
  const vidGrid = useGridVirtualizer(videoBeatList.length, videoGridRef);
  // Latest beats, readable inside interval callbacks without making the
  // beats array a dependency (which would re-subscribe the interval on
  // every poll/mutate).
  const beatsRef = useRef<Beat[]>(beats);
  beatsRef.current = beats;
  // True while any image beat is still being produced by KIE (submitted,
  // no URL yet). Drives the continuous reconciliation poller below.
  const hasInflightImages = beats.some(
    (b) => b.imageStatus === "generating" && b.imageTaskId && !b.imageUrl
  );
  const script: string = project?.script ?? "";
  const totalBeats = beats.length;
  const generatedImages = beats.filter((b) => b.imageUrl).length;
  const generatedVideos = beats.filter((b) => b.videoUrl).length;
  const videoBeats = videoBeatList.length;
  // Re-hide the skip-warnings drawer whenever generation progress moves,
  // so a fresh Continue click is required to reveal it again (and the
  // label resets to "Continue" rather than staying "Continue anyway").
  useEffect(() => { setWarningsRevealed(false); }, [generatedImages, generatedVideos, totalBeats, videoBeats]);
  // A beat that holds a videoUrl is logically done, even if a stale
  // "failed" status is still on the row from an earlier retry — the
  // worker doesn't clear video_url when writing a failure, so we have
  // to gate failure on "no URL produced" here.
  const failedVideos = beats.filter((b) => b.videoPrompt && b.videoStatus === "failed" && !b.videoUrl).length;
  const pendingVideos = beats.filter((b) => b.videoPrompt && !b.videoUrl).length;
  // Beats that are actually queue-able right now: have a video prompt,
  // have a source image (image-to-video models need it), and no clip
  // yet. We let users queue partials as images trickle in, so this is
  // usually smaller than pendingVideos in the middle of an image run.
  const pendingVideosWithImages = beats.filter((b) => b.videoPrompt && b.imageUrl && !b.videoUrl).length;
  const queuedVideos = beats.filter((b) => b.videoStatus === "queued").length;
  const pausedVideos = beats.filter((b) => b.videoStatus === "paused").length;
  // Video clips need an image to motion-render off of. Previously this
  // gated on every beat having an image, so users had to wait for the
  // whole image batch to finish before they could start any video
  // work. Now we unlock as soon as at least one image is done — the
  // queue handler only submits beats that have an image, so partials
  // are safe.
  const imagesReady = generatedImages > 0;
  const videosBlockedByImages = !imagesReady;
  const videoBlockReason = videosBlockedByImages
    ? `Waiting on first image — ${generatedImages}/${totalBeats} done`
    : undefined;

  // Derive display URLs from DB data; use pending state only during active operations
  const ttsUrl = generatingTts ? null : (pendingTtsUrl ?? project?.tts_url ?? null);
  const ttsCleanedUrl = removingPauses || cleanedUrlInvalidated ? null : (pendingTtsCleanedUrl ?? project?.tts_cleaned_url ?? null);

  // Hash the current script in the browser so we can compare it against
  // the hash stored when this voiceover was generated. If they differ,
  // the saved tts_url is narration for an older version of the script
  // and the user should be warned before they continue.
  const [currentScriptHash, setCurrentScriptHash] = useState<string | null>(null);
  useEffect(() => {
    if (!script) { setCurrentScriptHash(null); return; }
    let cancelled = false;
    (async () => {
      const buf = new TextEncoder().encode(script);
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (!cancelled) setCurrentScriptHash(hex);
    })();
    return () => { cancelled = true; };
  }, [script]);
  const ttsStale = !!ttsUrl
    && !generatingTts
    && !!project?.tts_script_hash
    && !!currentScriptHash
    && project.tts_script_hash !== currentScriptHash;

  // Beats are the parent of the image/video assets shown below. If the
  // script changed after the prompts step ran, both the images and the
  // motion clips were generated against an out-of-date beat list and
  // need to be regenerated upstream (Prompt Studio → Regenerate) before
  // images/videos can match the current script again.
  const videosInFlight = queuingVideos
    || beats.some((b) => b.videoStatus === "queued" || b.videoStatus === "submitting" || b.videoStatus === "rendering");
  const beatsStale = beats.length > 0
    && !generatingImages
    && !videosInFlight
    && !!project?.prompts_script_hash
    && !!currentScriptHash
    && project.prompts_script_hash !== currentScriptHash;

  // Once the beats are no longer stale (user regenerated), forget any
  // dismissal so the next edit surfaces the banner again.
  useEffect(() => {
    if (!beatsStale) { setStaleImageDismissed(false); setStaleVideoDismissed(false); }
  }, [beatsStale]);

  useEffect(() => {
    if (!generatingImages && project?.images_progress) setImagesProgress(project.images_progress);
  }, [project?.images_progress, generatingImages]);

  // Auto-clear the sticky out-of-credits banner once the refreshed
  // balance shows positive credits again. Avoids needing the user to
  // dismiss it manually after they top up.
  useEffect(() => {
    const c = apiStatus?.kie?.credits;
    if (outOfCredits && typeof c === "number" && c > 0) setOutOfCredits(false);
  }, [apiStatus?.kie?.credits, outOfCredits]);

  // Continuous reconciliation poller for in-flight image beats. Runs
  // whenever ANY beat is still being produced by KIE (imageStatus
  // "generating", has a taskId, no URL yet) and the active generateImages()
  // loop isn't already polling. Mirrors the video poller (setInterval) —
  // it keeps hitting the image poll endpoint (which pulls the KIE result
  // into the DB) and mutate()s until every beat resolves.
  //
  // This replaces the old one-shot resume effect, which polled at most once
  // per page mount for ~6 min. That left a bug where a slow KIE image
  // (finishing after the window) never got reconciled: the client had
  // stopped polling, so the beat stayed "generating" in the UI forever even
  // though KIE had succeeded. Gating on the boolean (not the beats array)
  // keeps the interval stable across mutate()s — it only tears down when the
  // last in-flight beat resolves.
  useEffect(() => {
    if (!hasInflightImages) return;
    if (generatingImages) return; // active loop is already polling these
    let cancelled = false;
    const poll = async () => {
      const targets = beatsRef.current.filter(
        (b) => b.imageStatus === "generating" && b.imageTaskId && !b.imageUrl
      );
      if (targets.length === 0) return;
      await Promise.allSettled(
        targets.map((b) =>
          fetch("/api/generate/images/poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId,
              beatNumber: b.beatNumber,
              taskId: b.imageTaskId,
              modelId: b.imageModelId ?? selectedImageModel ?? "",
            }),
          }).catch(() => {})
        )
      );
      if (!cancelled) await mutate();
    };
    void poll();
    const id = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [hasInflightImages, generatingImages, projectId, mutate, selectedImageModel]);

  // Crash recovery for the "queued" image indicator: queued is a purely
  // client-driven transient (stamped at bulk-run start, upgraded to
  // "generating" per submit, cleared in the run's finally). If the tab
  // died mid-run, leftover queued beats would spin forever — so on first
  // project load with no active run, sweep them back to NULL. One-shot:
  // a legitimately active run in another tab re-stamps "generating" on
  // its own submits, so the worst case here is a briefly hidden badge.
  const sweptStaleQueued = useRef(false);
  useEffect(() => {
    if (sweptStaleQueued.current || !project?.beats || generatingImages) return;
    sweptStaleQueued.current = true;
    if (!beats.some((b) => b.imageStatus === "queued")) return;
    void fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear_queued_images: true }),
    }).then(() => mutate()).catch(() => {});
  }, [project?.beats, generatingImages, beats, projectId, mutate]);

  useEffect(() => {
    if (ttsModels?.length && !initialTtsSelected.current) {
      initialTtsSelected.current = true;
      setSelectedTtsModel(ttsModels[0].id);
    }
  }, [ttsModels]);
  // When the user switches the Male/Female tab and the currently-selected
  // voice is in the other gender, snap selection to the first voice of the
  // visible tab so they don't end up generating with a voice they can't see.
  useEffect(() => {
    if (!ttsModels) return;
    const currentInTab = ttsModels.some((m) => m.id === selectedTtsModel && m.tags?.[0]?.toLowerCase() === voiceTab);
    if (currentInTab) return;
    const firstInTab = ttsModels.find((m) => m.tags?.[0]?.toLowerCase() === voiceTab);
    if (firstInTab) setSelectedTtsModel(firstInTab.id);
  }, [voiceTab, ttsModels]); // eslint-disable-line react-hooks/exhaustive-deps
  // Initial image-model pick: prefer the user's last selection from
  // localStorage (across projects, across refreshes) when it's still
  // in the currently-available model list, otherwise fall through to
  // the first model. Never writes to the project row — the model only
  // makes it to the DB at queue/submission time, so each user's local
  // preference stays scoped to their browser.
  useEffect(() => {
    if (!imageModels?.length || selectedImageModel) return;
    let preferred: string | null = null;
    if (typeof window !== "undefined") {
      try {
        const saved = window.localStorage.getItem("heclus-preferred-image-model");
        if (saved && imageModels.some((m) => m.id === saved)) preferred = saved;
      } catch { /* localStorage disabled — fall through to first model */ }
    }
    setSelectedImageModel(preferred ?? imageModels[0].id);
  }, [imageModels]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist subsequent image-model changes to localStorage so the
  // next mount of this page (any project, same browser) picks back
  // up where the user left off. No DB write involved — this is
  // pure browser-local UX state.
  useEffect(() => {
    if (!selectedImageModel || typeof window === "undefined") return;
    try { window.localStorage.setItem("heclus-preferred-image-model", selectedImageModel); } catch { /* ignore */ }
  }, [selectedImageModel]);

  useEffect(() => {
    if (!selectedImageModel) return;
    const config = getModelConfig(selectedImageModel);
    if (!config.aspectRatios.includes(selectedAspectRatio)) {
      setSelectedAspectRatio(config.aspectRatios[0]);
    }
    if (!config.resolutions) {
      setSelectedResolution(null);
    } else if (!selectedResolution || !config.resolutions.includes(selectedResolution)) {
      setSelectedResolution(config.resolutions[0]);
    }
  }, [selectedImageModel]); // eslint-disable-line react-hooks/exhaustive-deps
  // Same persistence pattern as image model — prefer last pick from
  // localStorage when still valid, else first available. Selection
  // never updates the project DB on its own; it only writes when the
  // user actually queues a video gen.
  useEffect(() => {
    if (!videoModels?.length || selectedVideoModel) return;
    let preferred: string | null = null;
    if (typeof window !== "undefined") {
      try {
        const saved = window.localStorage.getItem("heclus-preferred-video-model");
        if (saved && videoModels.some((m) => m.id === saved)) preferred = saved;
      } catch { /* ignore */ }
    }
    setSelectedVideoModel(preferred ?? videoModels[0].id);
  }, [videoModels]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedVideoModel || typeof window === "undefined") return;
    try { window.localStorage.setItem("heclus-preferred-video-model", selectedVideoModel); } catch { /* ignore */ }
  }, [selectedVideoModel]);

  // Scroll the image error banner into view the first render it
  // becomes visible. Latched via imageBannerShown.current so the
  // scroll only happens once per appearance — not on every state
  // change while the banner is up.
  useEffect(() => {
    const banner = imageErrorBannerRef.current;
    if (banner && !imageBannerShown.current) {
      imageBannerShown.current = true;
      banner.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (!banner) {
      imageBannerShown.current = false;
    }
  });

  useEffect(() => {
    const banner = videoErrorBannerRef.current;
    if (banner && !videoBannerShown.current) {
      videoBannerShown.current = true;
      banner.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (!banner) {
      videoBannerShown.current = false;
    }
  });

  useEffect(() => {
    if (!selectedVideoModel) return;
    const config = getVideoModelConfig(selectedVideoModel);
    if (config.durations.length === 0) {
      setSelectedDuration(null);
    } else {
      setSelectedDuration(config.durations[0].value);
    }
    // Aspect ratio is NOT model-driven for video — the clip inherits the
    // source image's ratio (kept in sync below), so we don't reset it to
    // the model's first supported value here.
    // Reset resolution when the new model doesn't offer it, or the
    // previously-picked value isn't valid for this model. Otherwise
    // default to the first supported value so the user always ships
    // with a resolution rather than KIE's silent default.
    if (!config.resolutions || config.resolutions.length === 0) {
      setSelectedVideoResolution(null);
    } else if (!selectedVideoResolution || !config.resolutions.includes(selectedVideoResolution)) {
      setSelectedVideoResolution(config.resolutions[0]);
    }
  }, [selectedVideoModel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the video aspect ratio locked to the image aspect ratio — a clip
  // animates the beat's image, so it must ship the same ratio the image
  // was generated with. The video ModelPicker shows this read-only.
  useEffect(() => {
    setSelectedVideoAspectRatio(selectedAspectRatio);
  }, [selectedAspectRatio]);

  const hasActiveVideos = beats.some((b) =>
    b.videoStatus === "queued" || b.videoStatus === "submitting" || b.videoStatus === "rendering");
  const hasActiveImages = generatingImages
    || beats.some((b) => (b.imageStatus === "generating" || b.imageStatus === "queued") && !b.imageUrl);

  useEffect(() => {
    if (hasActiveVideos && !videosSubmitted) setVideosSubmitted(true);
  }, [hasActiveVideos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register / release the balance-poll gate. hasActivity across the
  // app stays true as long as any of: the user's current image run,
  // a beat still marked "generating" from a resume, or any video beat
  // in an active DB state (queued/submitting/rendering). Balance
  // components subscribe to the store and pause their /api/api-status
  // polling — which hits KIE and ElevenLabs — while the store is empty.
  const markActive = useKieActivityStore((s) => s.markActive);
  const markIdle = useKieActivityStore((s) => s.markIdle);
  useEffect(() => {
    const active = hasActiveVideos || hasActiveImages;
    if (active) markActive("generate");
    else markIdle("generate");
    return () => markIdle("generate");
  }, [hasActiveVideos, hasActiveImages, markActive, markIdle]);

  useEffect(() => {
    if (!videosSubmitted) return;
    let lastError: string | null = null;
    let cancelDispatched = false;
    const poll = async () => {
      const res = await fetch(`/api/generate/videos/poll?projectId=${projectId}`);
      const data = await res.json().catch(() => ({})) as { pending?: number; firstError?: string | null };
      if (data.firstError && data.firstError !== lastError) {
        lastError = data.firstError;
        // Push into the section banner — single source of truth for
        // video failure context, no more disappearing toasts.
        setVideoRunError(friendlyError(data.firstError));
        // Terminal "the model rejected this" errors will keep failing
        // for every remaining queued/rendering beat with the same
        // model. Sweep them all to failed in one shot so the worker
        // stops burning attempts and the UI's "Rendering" badge
        // doesn't linger on beats that are guaranteed to fail next.
        if (!cancelDispatched && isModelTerminalError(data.firstError)) {
          cancelDispatched = true;
          try {
            await fetch("/api/generate/videos/cancel-pending", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectId, errorMessage: data.firstError }),
            });
          } catch { /* best-effort — next poll will reflect whatever state we land in */ }
        }
      }
      await mutate();
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [videosSubmitted, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function generateVoiceover(voiceId = selectedTtsModel) {
    if (!voiceId) return;
    // Force a fresh fetch to ensure we have the latest script, not a stale SWR cache
    const fresh = await mutate();
    const latestScript = fresh?.script ?? script;
    if (!latestScript) return;
    setGeneratingTts(true);
    setPendingTtsUrl(null);
    setPendingTtsCleanedUrl(null);
    setCleanedUrlInvalidated(true);
    setTtsProgress(null);
    setTtsStatusMsg("Starting...");
    try {
      const res = await fetch("/api/generate/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, script: latestScript, voiceId }),
      });
      if (!res.ok || !res.body) throw new Error("Failed to start TTS");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Track whether the stream sent a terminal event. Without this,
      // a function timeout that drops the connection mid-stream looks
      // like a silent success — reader exits, no toast, no result.
      let receivedTerminal = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: { type?: string; current?: number; total?: number; message?: string; url?: string };
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue; // skip partial / malformed chunk
          }
          if (event.type === "progress") {
            setTtsProgress({ current: event.current ?? 0, total: event.total ?? 1 });
            setTtsStatusMsg(`Generating part ${(event.current ?? 0) + 1} of ${event.total ?? 1}...`);
          } else if (event.type === "status") {
            setTtsStatusMsg(event.message ?? "");
          } else if (event.type === "done") {
            receivedTerminal = true;
            if (event.url) setPendingTtsUrl(event.url);
            toast.success("Voiceover generated!");
          } else if (event.type === "error") {
            receivedTerminal = true;
            throw new Error(event.message ?? "Voiceover generation failed");
          }
        }
      }
      if (!receivedTerminal) {
        throw new Error("Voiceover generation ended unexpectedly — the connection closed before completing. Try again.");
      }
    } catch (err) {
      toast.error(friendlyError(err instanceof Error ? err.message : null));
    } finally {
      setGeneratingTts(false);
      setTtsProgress(null);
      setTtsStatusMsg("");
    }
  }

  async function removePauses() {
    if (!ttsUrl || removingPauses) return;
    setRemovingPauses(true);
    setPendingTtsCleanedUrl(null);
    setRemovePausesStatus("Fetching audio...");
    try {
      const res = await fetch(ttsUrl);
      if (!res.ok) throw new Error("Failed to fetch audio");
      const audioBytes = await res.arrayBuffer();

      setRemovePausesStatus("Decoding audio...");
      const ctx = new AudioContext();
      const audioBuffer = await ctx.decodeAudioData(audioBytes);
      ctx.close();

      setRemovePausesStatus("Removing pauses...");
      const { channels, sampleRate, originalDuration, newDuration } = await removeLongPauses(audioBuffer);

      setRemovePausesStatus("Encoding audio...");
      const mp3Bytes = await encodeMp3(channels, sampleRate);

      setRemovePausesStatus("Preparing upload...");
      // Two-step upload: get a presigned R2 URL, PUT the MP3 directly to
      // R2 (bypasses Vercel's 4.5MB function body limit), then ping the
      // route to update the DB row. Required for long voiceovers.
      const presignRes = await fetch(`/api/generate/tts/clean?projectId=${projectId}`, { method: "POST" });
      if (!presignRes.ok) {
        const err = await presignRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to prepare upload");
      }
      const { uploadUrl, publicUrl: uploadedUrl } = await presignRes.json() as { uploadUrl: string; publicUrl: string };

      setRemovePausesStatus("Uploading...");
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        body: mp3Bytes,
        headers: { "Content-Type": "audio/mpeg" },
      });
      if (!putRes.ok) throw new Error(`Upload failed (HTTP ${putRes.status})`);

      setRemovePausesStatus("Saving...");
      const finalizeRes = await fetch(`/api/generate/tts/clean?projectId=${projectId}&finalize=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicUrl: uploadedUrl }),
      });
      if (!finalizeRes.ok) {
        const err = await finalizeRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to save trimmed audio");
      }
      const { url } = await finalizeRes.json().catch(() => ({})) as { url?: string };
      if (!url) throw new Error("Upload succeeded but no URL returned");
      setPendingTtsCleanedUrl(url);
      setCleanedUrlInvalidated(false);
      const savedSec = Math.round(originalDuration - newDuration);
      toast.success(savedSec > 0 ? `Removed ${savedSec}s of silence` : "No long pauses found");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove pauses");
    } finally {
      setRemovingPauses(false);
      setRemovePausesStatus("");
    }
  }

  async function generateImages(opts: { mode?: "all" | "remaining" } = {}) {
    if (!selectedImageModel || !beats.length) return;

    // Determine which beats to process:
    // - "remaining" (default when some imageUrls exist): only beats
    //   without an imageUrl. Failed/missing ones get retried; already-
    //   successful images stay intact, user doesn't re-pay for them.
    // - "all" (regenerate): wipe existing images first, then process
    //   every beat. Used when all images succeeded and user wants a
    //   fresh take.
    const targetBeats = opts.mode === "all"
      ? beats
      : beats.filter((b) => !b.imageUrl);

    if (targetBeats.length === 0) return;

    const shouldClear = opts.mode === "all" && generatedImages > 0;

    setGeneratingImages(true);
    setImagesProgress(0);
    // Fresh run — clear the latched "user stopped" flag so the
    // partial-completion warning can fire if this run genuinely
    // ends with failures.
    setUserStoppedImages(false);
    // Fresh run — wipe accumulated errors so the banner only ever
    // reflects this attempt's failures, not stale ones from a
    // previous attempt with a different model.
    resetImageErrorBanner();
    if (shouldClear) setClearingImages(true);
    imagesAbortRef.current = new AbortController();
    const abortSignal = imagesAbortRef.current.signal;
    let successCount = 0;
    try {
      if (shouldClear) {
        await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear_images: true }),
        });
        setClearingImages(false);
      }

      // Flip the ENTIRE target set to "queued" before submission starts —
      // optimistically in the SWR cache (instant), and in the DB (so the
      // ~1.5s poll doesn't revert beats whose submit hasn't landed yet).
      // Beats are submitted in small batches below; without this, only
      // the current batch showed any in-flight indicator while the rest
      // of the run's beats sat looking idle. Each submit upgrades its
      // beat to "generating"; whatever is still "queued" when the run
      // ends is reset by the finally-block cleanup.
      const targetNumbers = new Set(targetBeats.map((b) => b.beatNumber));
      void mutate(
        (current?: { beats?: Beat[] } & Record<string, unknown>) => {
          if (!current?.beats) return current;
          return {
            ...current,
            beats: current.beats.map((b) =>
              targetNumbers.has(b.beatNumber) ? { ...b, imageStatus: "queued" } : b,
            ),
          };
        },
        { revalidate: false },
      );
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue_images: [...targetNumbers] }),
      }).catch(() => { /* indicator-only — submission proceeds regardless */ });

      // Submit beats in batches. KIE's "call frequency too high" 429
      // can fire on sustained submission even at moderate rates, so we
      // keep the batch conservative (4+1500ms = ~2.7 req/s baseline)
      // AND retry per-beat on 429 with backoff. The retry honors
      // Retry-After when present; otherwise it doubles 1s → 2s → 4s.
      // Real (non-rate-limit) errors throw immediately.
      const SUBMIT_BATCH = 4;
      const pending: { beatNumber: number; taskId: string }[] = [];
      let firstSubmitError: string | null = null;

      async function submitOne(beat: Beat): Promise<{ beatNumber: number; taskId: string }> {
        const MAX_RETRIES = 4;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          const res = await fetch("/api/generate/images/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId,
              beatNumber: beat.beatNumber,
              imagePrompt: beat.imagePrompt,
              modelId: selectedImageModel,
              aspectRatio: selectedAspectRatio,
              ...(selectedResolution ? { resolution: selectedResolution } : {}),
            }),
          });
          if (res.status === 429 && attempt < MAX_RETRIES) {
            const retryAfter = res.headers.get("Retry-After");
            const waitMs = retryAfter && Number.isFinite(Number(retryAfter))
              ? Number(retryAfter) * 1000
              : Math.min(8000, 1000 * 2 ** attempt);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          const data = await res.json().catch(() => ({})) as { taskId?: string; error?: string };
          if (!res.ok || !data.taskId) {
            const errMsg = data.error ?? `HTTP ${res.status}`;
            // Surface KIE credit exhaustion as sticky UI state, not just
            // a transient toast. We also kick the balance fetch so the
            // displayed balance updates without waiting for the 30s
            // refresh interval.
            if (isCreditError(errMsg)) {
              setOutOfCredits(true);
              mutateApiStatus();
            }
            throw new Error(errMsg);
          }
          return { beatNumber: beat.beatNumber, taskId: data.taskId };
        }
        throw new Error(`Rate limited after ${MAX_RETRIES + 1} attempts`);
      }

      for (let i = 0; i < targetBeats.length; i += SUBMIT_BATCH) {
        // Stop check between batches — every unsubmitted beat from
        // here on saves a KIE credit. The four in this iteration are
        // already mid-fetch and will resolve; that's the smallest
        // possible "leak" given the in-flight nature.
        if (abortSignal.aborted) break;
        const batch = targetBeats.slice(i, i + SUBMIT_BATCH);
        const batchResults = await Promise.allSettled(batch.map(submitOne));
        for (const r of batchResults) {
          if (r.status === "fulfilled") pending.push(r.value);
          else {
            const reason = r.reason instanceof Error ? r.reason.message : "Unknown error";
            if (!firstSubmitError) firstSubmitError = reason;
            // Overwrite the banner with the latest error so the user
            // always sees the most recent failure rather than a
            // growing list.
            setImageRunError(friendlyError(reason));
          }
        }
        if (i + SUBMIT_BATCH < targetBeats.length) await new Promise((r) => setTimeout(r, 1500));
      }

      // User stopped before any task submitted — nothing to poll, no
      // error to surface (Stop is an intentional, expected action).
      if (abortSignal.aborted && pending.length === 0) {
        toast.info("Stopped — no images were submitted");
        return;
      }
      if (pending.length === 0) {
        throw new Error(firstSubmitError ?? "unknown error");
      }
      // Partial-submit failures used to fire a yellow toast that
      // duplicated the section banner; the banner now lists every
      // distinct error inline, so the toast is just visual clutter.

      // Poll all pending tasks in parallel every 3s until all complete
      const remaining = [...pending];
      let firstPollError: string | null = null;
      // ~6 min max. GPT Image 2 and other slow models can legitimately
      // take 3–5 min per image on KIE. The old ~2.5 min ceiling was
      // firing "timed out" while KIE was still producing the image,
      // which then landed successfully on the next page mount via the
      // resume-effect above — confusing for the user. Higher ceiling
      // keeps the poll going until KIE actually completes.
      const MAX_POLLS = 120;
      for (let attempt = 0; attempt < MAX_POLLS && remaining.length > 0; attempt++) {
        // Stop also exits the poll loop — the in-flight KIE jobs are
        // already paid for and the cron / webhook / page-resume effect
        // will finish them server-side, so we're not losing work.
        if (abortSignal.aborted) break;
        await new Promise((r) => setTimeout(r, 3000));

        const pollResults = await Promise.allSettled(
          remaining.map(async ({ beatNumber, taskId }) => {
            const res = await fetch("/api/generate/images/poll", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectId, beatNumber, taskId, modelId: selectedImageModel }),
            });
            const data = await res.json().catch(() => ({})) as { status?: string; error?: string };
            const status = !res.ok ? "error" : (data.status ?? "pending");
            return { beatNumber, taskId, status, error: data.error };
          })
        );

        const toRemove: number[] = [];
        for (let i = 0; i < pollResults.length; i++) {
          if (pollResults[i].status === "fulfilled") {
            const { status, error } = (pollResults[i] as PromiseFulfilledResult<{ beatNumber: number; taskId: string; status: string; error?: string }>).value;
            if (status === "done") { successCount++; setImagesProgress(successCount); toRemove.push(i); }
            else if (status === "failed" || status === "error") {
              const reason = error ?? "Unknown error";
              if (!firstPollError) firstPollError = reason;
              // Overwrite the banner — only the most recent error
              // ever shows.
              setImageRunError(friendlyError(reason));
              toRemove.push(i);
            }
          }
        }
        for (let i = toRemove.length - 1; i >= 0; i--) remaining.splice(toRemove[i], 1);
      }

      await mutate();
      if (abortSignal.aborted) {
        const inFlight = pending.length - successCount;
        if (inFlight > 0) {
          toast.info(`Stopped — ${successCount}/${pending.length} done, ${inFlight} still finishing in the background`);
        } else {
          toast.info(`Stopped — ${successCount}/${pending.length} done`);
        }
      } else if (successCount === 0) {
        // Distinguish a genuine failure from "the client poll window
        // elapsed while KIE was still producing the image". Only show an
        // error banner when a task actually reported one. If beats are
        // merely still in flight (remaining > 0, no captured error), this
        // is NOT a failure — the continuous reconciliation poller above
        // keeps polling and mutate()s the results in when KIE finishes.
        // Firing a "timed out" banner here was the false alarm users saw
        // while generation actually succeeded on KIE moments later.
        const realError = firstPollError ?? firstSubmitError;
        if (realError) {
          setImageRunError((prev) => prev ?? friendlyError(realError));
        } else if (remaining.length > 0) {
          toast.info(`Still generating ${remaining.length} image${remaining.length === 1 ? "" : "s"} — they'll appear here when ready`);
        }
      } else if (successCount < targetBeats.length) {
        // Partial success — if a task errored, its banner is already set
        // above; any remaining in-flight beats are finished silently by
        // the reconciliation poller.
      } else {
        toast.success(`${successCount}/${targetBeats.length} images generated`);
      }
    } catch (err) {
      // Abort errors are intentional Stop clicks — silenced by the
      // aborted-branch above, so we only land here on real failures.
      // Surface the error in the section banner instead of toasting.
      if (!abortSignal.aborted) {
        setImageRunError(friendlyError(err instanceof Error ? err.message : null));
      }
    } finally {
      // Reset any beat still "queued" — those never reached a KIE submit
      // (user stopped, or the submit itself failed client-side) so their
      // tiles must drop the in-flight indicator. Server-side no-op when
      // every target advanced to generating/done/failed.
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_queued_images: true }),
      }).catch(() => { /* best-effort — the mount cleanup covers a miss */ });
      await mutate();
      setGeneratingImages(false);
      setClearingImages(false);
      setStoppingImages(false);
      imagesAbortRef.current = null;
    }
  }

  // Stops the image submission loop immediately. Beats already
  // submitted continue running on KIE and land via webhook / cron /
  // page-resume polling — only unsubmitted ones save us money.
  async function handleStopImages() {
    if (!generatingImages || stoppingImages) return;
    setStoppingImages(true);
    // Mark this as a user-initiated halt so the partial-completion
    // banner ("X images didn't generate on …") stays hidden — the
    // gap is intentional, not a model failure to scold the user about.
    setUserStoppedImages(true);
    if (imagesAbortRef.current) {
      try { imagesAbortRef.current.abort(); } catch { /* ignore */ }
    }
  }

  async function regenerateImage(beat: Beat, promptOverride?: string) {
    if (!selectedImageModel) return;
    const promptToUse = promptOverride ?? beat.imagePrompt;
    // New regen → clear the section banner so the user sees a clean
    // slate for this attempt, not stale errors from a previous run.
    resetImageErrorBanner();
    setRegenBeats((prev) => new Set(prev).add(beat.beatNumber));
    try {
      // Single synchronous call to the regenerate route. The server
      // runs the whole flow (submit → poll KIE → upload → update DB
      // → delete previous) and returns the new image URL when done.
      // No client-side polling, no webhook race, no spinner
      // gymnastics — when this resolves, the DB is updated and
      // mutate() pulls the new URL into SWR.
      const res = await fetch("/api/generate/images/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          beatNumber: beat.beatNumber,
          imagePrompt: promptToUse,
          modelId: selectedImageModel,
          aspectRatio: selectedAspectRatio,
          ...(selectedResolution ? { resolution: selectedResolution } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; url?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Regenerate failed");
      toast.success(`Beat ${beat.beatNumber} regenerated`);
      await mutate();
    } catch (err) {
      toast.error(friendlyError(err instanceof Error ? err.message : null));
    } finally {
      setRegenBeats((prev) => { const next = new Set(prev); next.delete(beat.beatNumber); return next; });
    }
  }

  async function pauseVideos() {
    if (pausingVideos) return;
    setPausingVideos(true);
    try {
      const res = await fetch("/api/generate/videos/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json().catch(() => ({})) as { paused?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Pause failed (HTTP ${res.status})`);
      toast.success(`Paused ${data.paused ?? 0} pending clips`);
      await mutate();
    } catch (err) {
      setVideoRunError(friendlyError(err instanceof Error ? err.message : "Pause failed"));
    } finally {
      setPausingVideos(false);
    }
  }

  async function resumeVideos() {
    if (!selectedVideoModel || resumingVideos) return;
    resetVideoErrorBanner();
    setResumingVideos(true);
    try {
      const res = await fetch("/api/generate/videos/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          modelId: selectedVideoModel,
          aspectRatio: selectedVideoAspectRatio,
          ...(selectedDuration !== null ? { duration: selectedDuration } : {}),
          ...(safeVideoResolution ? { resolution: safeVideoResolution } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { resumed?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Resume failed (HTTP ${res.status})`);
      toast.success(`Resumed ${data.resumed ?? 0} clips`);
      setVideosSubmitted(true);
      await mutate();
    } catch (err) {
      setVideoRunError(friendlyError(err instanceof Error ? err.message : "Resume failed"));
    } finally {
      setResumingVideos(false);
    }
  }

  async function queueVideos(mode: "all" | "failed" = "all") {
    if (!selectedVideoModel || !beats.length) return;
    resetVideoErrorBanner();
    setQueuingVideos(true);
    try {
      // "all" means everything that still needs a video (no URL yet),
      // not literally every beat — re-submitting a done beat would wipe
      // its video_url on the server. "failed" only retries failures.
      // imageUrl is required: image-to-video models won't accept a beat
      // without a source frame. Beats whose images are still rendering
      // are skipped now and become eligible the next time the user
      // clicks Queue.
      // Beats this action targets (has a prompt, and either failed [retry]
      // or has no clip yet [all]). Retry-failed must include beats that
      // failed but still carry a stale video_url from a prior run.
      const targets = beats.filter((b) => {
        if (!b.videoPrompt) return false;
        if (mode === "failed") return b.videoStatus === "failed";
        if (b.videoUrl) return false;
        return true;
      });
      // Every video model is image-to-video, so a beat with no source
      // image can't be generated. Split those out and tell the user to
      // make the images first instead of silently dropping them.
      const missingImage = targets.filter((b) => !b.imageUrl);
      const eligible = targets.filter((b) => b.imageUrl);
      if (eligible.length === 0) {
        if (missingImage.length > 0) {
          const nums = missingImage.map((b) => b.beatNumber).join(", ");
          setNoImageAlert(
            `${missingImage.length} beat${missingImage.length === 1 ? "" : "s"} (${nums}) ${missingImage.length === 1 ? "has" : "have"} no image yet. Every video is generated from a beat's image — generate the missing beat image${missingImage.length === 1 ? "" : "s"} first, then try again.`,
          );
        }
        return;
      }
      if (missingImage.length > 0) {
        toast.error(`Skipped ${missingImage.length} beat${missingImage.length === 1 ? "" : "s"} with no image — generate their images first.`);
      }
      // Instant UI feedback — flip all eligible beats to "queued" before
      // the POST so the badges + fast poll kick in immediately.
      optimisticQueueVideos(new Set(eligible.map((b) => b.beatNumber)));
      const res = await fetch("/api/generate/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          beats: eligible.map((b) => ({ beatNumber: b.beatNumber, videoPrompt: b.videoPrompt, imageUrl: b.imageUrl })),
          modelId: selectedVideoModel,
          aspectRatio: selectedVideoAspectRatio,
          ...(selectedDuration !== null ? { duration: selectedDuration } : {}),
          ...(safeVideoResolution ? { resolution: safeVideoResolution } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { submitted?: number; failures?: { beatNumber: number; error: string }[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
      setVideosSubmitted(true);
      const verb = mode === "failed" ? "re-submitted" : "submitted";
      if ((data.submitted ?? 0) > 0) toast.success(`${data.submitted ?? 0} video clips ${verb}`);
      if (data.failures?.length) {
        setVideoRunError(friendlyError(data.failures[0].error));
      }
      // Reconcile the optimistic flip with server truth.
      await mutate();
    } catch (err) {
      setVideoRunError(friendlyError(err instanceof Error ? err.message : null));
      await mutate(); // revert the optimistic flip on failure
    } finally {
      setQueuingVideos(false);
    }
  }

  async function exportDocx() {
    try {
      const res = await fetch("/api/export/docx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project?.channel_name ?? "export"}_content.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    }
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav
        projectId={projectId}
        currentState={14}
        highestState={project?.current_state}
        channelName={project?.channel_name}
        topRightExtra={
          <button
            onClick={exportDocx}
            className="flex items-center px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
            style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
          >
            Export Doc
          </button>
        }
      />

      <main className="flex-1 flex flex-col overflow-hidden pt-[105px] md:pt-0 lg:px-[15px]">
        {/* Header */}
        <div className="shrink-0 px-5 sm:px-8 md:pr-44 py-4 sm:py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div>
            <h1 className="font-bold text-base sm:text-lg">Generate Assets</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Select a model for each service, then generate your final content
            </p>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <StepCostCard projectId={projectId} column="generate" />
              <StepBalanceCard />
              {/* Free resources button hidden until the /free-resources
                  page is built. Drop this back in when ready:
                  <FreeResourcesButton step="generate" /> */}
            </div>
          </div>
        </div>

        {/* Images / Videos / Both switcher — a persistent tab bar above the
            scrolling grid. Images & Videos drive the single-column view (one
            panel at a time); Both switches to the side-by-side two-column
            view. "Both" is desktop-only — mobile forces single-column for
            performance. Sits outside the scroller as a shrink-0 row so it
            stays fixed above the grid. */}
        <div className="shrink-0 px-5 sm:px-8 pt-3 pb-3" style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)" }}>
          <div className="flex items-center gap-1 rounded-xl p-1" style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
            {([
              {
                key: "image",
                label: "Images",
                icon: <ImageIcon size={15} />,
                active: effectiveView === "single" && singleStep === "image",
                // On mobile the view is force-single, so only move the step
                // and leave the persisted desktop columnView preference alone.
                onClick: () => { if (!isMobile) chooseColumnView("single"); setSingleStep("image"); },
              },
              {
                key: "video",
                label: "Videos",
                icon: <Video size={15} />,
                active: effectiveView === "single" && singleStep === "video",
                onClick: () => { if (!isMobile) chooseColumnView("single"); setSingleStep("video"); },
              },
              ...(!isMobile ? [{
                key: "both",
                label: "Both",
                icon: (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                    <rect x="2" y="2.5" width="5" height="11" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
                    <rect x="9" y="2.5" width="5" height="11" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                ),
                active: effectiveView === "double",
                onClick: () => chooseColumnView("double"),
              }] : []),
            ]).map((t) => (
              <button
                key={t.key}
                onClick={t.onClick}
                aria-pressed={t.active}
                className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5"
                style={t.active
                  ? { background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)" }
                  : { color: "var(--c-55)" }}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pb-[70px]">
        {/* 3-row subgrid keeps the image and video panels perfectly
            row-aligned: model-picker headers share row 1, gallery /
            empty-state areas share row 2, action clusters share row 3.
            Without subgrid, extra content on one side (e.g. a taller
            aspect list, or a resolution section that only one panel
            has) would push the sections below it out of alignment. */}
        <div className={`px-5 pb-4 pt-4 sm:px-8 sm:pb-8 sm:pt-6 mb-[84px] grid gap-6 ${effectiveView === "double" ? "grid-cols-1 lg:grid-cols-2 lg:grid-rows-[auto_auto_auto]" : "grid-cols-1"}`}>
          {/* Image Gen Panel — unmounted (not just hidden) when it isn't
              the active single-view step, so its hundreds of tiles +
              IntersectionObservers don't stay mounted and freeze mobile. */}
          {(effectiveView === "double" || singleStep === "image") && (
          <div className={`rounded-2xl overflow-hidden flex flex-col ${effectiveView === "double" ? "lg:grid lg:grid-rows-subgrid lg:row-span-3" : ""}`}
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
            <div className="p-5 min-h-[500px]" style={{ borderBottom: "1px solid var(--bd-6)" }}>
              <SectionHeader icon={<ImageIcon size={18} />} title="AI Images" subtitle={`${totalBeats} images from script beats`} />
              <ModelPicker
                type="image"
                models={imageModels}
                selectedModelId={selectedImageModel}
                onSelectModel={setSelectedImageModel}
                selectedAspectRatio={selectedAspectRatio}
                onSelectAspectRatio={setSelectedAspectRatio}
                selectedResolution={selectedResolution}
                onSelectResolution={setSelectedResolution}
              />
            </div>

            {/* Middle subgrid row: stale banner + gallery live here so
                the image panel has exactly three direct children (header
                / middle / actions) and subgrid row alignment holds even
                when both inner blocks are empty. */}
            <div className="flex flex-col">
            {beatsStale && !staleImageDismissed && (
              <div className="px-5 pt-4">
                <div className="rounded-xl px-3 py-2.5 flex items-start gap-2 text-xs"
                  style={{ background: "oklch(0.72 0.16 70 / 0.12)", border: "1px solid oklch(0.72 0.16 70 / 0.35)", color: "oklch(0.85 0.12 70)" }}>
                  <span aria-hidden>⚠</span>
                  <span className="flex-1">
                    Script was edited after these beats were generated. Any images below were prompted from the old script — regenerate the beats in <strong>Prompt Studio</strong> before re-running images.
                  </span>
                  <button
                    type="button"
                    onClick={() => setStaleImageDismissed(true)}
                    aria-label="Dismiss"
                    className="shrink-0 -mr-1 -mt-0.5 p-1 rounded-md transition-colors hover:bg-[oklch(0.72_0.16_70_/_0.18)]"
                    style={{ color: "oklch(0.85 0.12 70)" }}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* Image gallery */}
            {(beats.some((b) => b.imageUrl || b.imageStatus) || regenBeats.size > 0) && (
              <div className="px-5 pt-4">
                <ProgressBar value={clearingImages ? 0 : generatedImages} total={totalBeats} />
                <div className="relative mt-3 mb-10">
                <div ref={imgGrid.setRef} className={`grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:overflow-y-auto scroll-visible pr-1 ${effectiveView === "single" ? "sm:max-h-[70vh]" : "max-h-[440px] sm:max-h-72"}`}>
                  {imgGrid.topPad > 0 && <div aria-hidden className="col-span-full" style={{ height: imgGrid.topPad }} />}
                  {beats.slice(imgGrid.start, imgGrid.end).map((b) => {
                    const isRegening = regenBeats.has(b.beatNumber);
                    return (
                      <div
                        key={b.beatNumber}
                        className="cv-tile relative w-full aspect-video rounded-lg overflow-hidden group"
                        style={{ background: "var(--bg-progress)" }}
                        onMouseEnter={(e) => showBeatPrompt(e, b.beatNumber, b.imagePrompt)}
                        onMouseLeave={() => setPromptPopup(null)}
                        onClick={(e) => {
                          if (clearingImages || uploadingBeat === b.beatNumber) return;
                          // Generated → open preview. Empty → Generate/Upload menu.
                          if (b.imageUrl) openPreview(b, "image");
                          else openAssetMenu(e, b, "image");
                        }}
                      >
                        {uploadingBeat === b.beatNumber && (
                          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-1" style={{ background: "oklch(0 0 0 / 0.7)" }}>
                            <Spinner size={20} className="text-white" />
                            <span className="text-[10px] font-medium" style={{ color: "oklch(0.95 0 0)" }}>Uploading…</span>
                          </div>
                        )}
                        {/* Beat number badge — top-left corner of every
                            tile so the beat is identifiable at a glance
                            regardless of image/status state. */}
                        <span
                          className="absolute top-1.5 left-1.5 z-10 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center text-[9px] font-semibold tabular-nums pointer-events-none"
                          style={{ background: "oklch(0 0 0 / 0.6)", color: "white", border: "1px solid oklch(1 0 0 / 0.15)" }}
                        >
                          {b.beatNumber}
                        </span>
                        {/* Touch-only "view prompt" — desktop uses hover. */}
                        <button
                          type="button"
                          onClick={(e) => showBeatPromptTap(e, b.beatNumber, b.imagePrompt)}
                          aria-label={`View prompt for beat ${b.beatNumber}`}
                          className="touch-only absolute bottom-1.5 left-1.5 z-20 w-7 h-7 rounded-full items-center justify-center"
                          style={{ background: "oklch(0 0 0 / 0.6)", color: "white", border: "1px solid oklch(1 0 0 / 0.15)" }}
                        >
                          <Info size={14} />
                        </button>
                        {b.imageUrl && !clearingImages ? (
                          <img src={b.imageUrl} alt={`Beat ${b.beatNumber}`} className="w-full h-full object-cover" loading="lazy" decoding="async" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <span className="text-[10px]" style={{ color: "var(--c-35)" }}>{b.beatNumber}</span>
                          </div>
                        )}

                        {/* View affordance — opens the full closable
                            preview dialog. Replaces the old floating
                            hover preview. */}
                        {b.imageUrl && !clearingImages && !isRegening && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openPreview(b, "image");
                            }}
                            title="View image"
                            aria-label={`View image for beat ${b.beatNumber}`}
                            className="absolute top-1.5 right-1.5 z-10 w-7 h-7 rounded-full flex items-center justify-center transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:scale-110"
                            style={{
                              background: "oklch(0 0 0 / 0.6)",
                              color: "white",
                              border: "1px solid oklch(1 0 0 / 0.15)",
                            }}
                          >
                            <Eye size={12} strokeWidth={2.4} />
                          </button>
                        )}

                        {/* Regen overlay — spinner on top of a dimmed
                            existing image so the user can see the
                            old frame while waiting for the new one. */}
                        {isRegening ? (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1"
                            style={{ background: "oklch(0 0 0 / 0.55)" }}>
                            <Spinner size={20} className="text-white" />
                            <span className="text-[10px] font-medium" style={{ color: "oklch(0.95 0 0)" }}>
                              Regenerating…
                            </span>
                          </div>
                        ) : (b.imageStatus === "generating" || b.imageStatus === "queued") && !clearingImages ? (
                          // In-flight overlay driven by the DB status —
                          // covers bulk runs (and runs resumed from
                          // another tab), which regenBeats can't see.
                          // "queued" = stamped on the whole target set at
                          // bulk-run start; each beat upgrades to
                          // "generating" when its KIE submit lands.
                          // Mirrors the video tiles' spinner + label so
                          // "work is happening here" reads the same on
                          // both grids.
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1"
                            style={{ background: "oklch(0 0 0 / 0.55)" }}>
                            <Spinner size={20} className="text-white" />
                            <span className="text-[10px] font-medium" style={{ color: "oklch(0.95 0 0)" }}>
                              {b.imageStatus}…
                            </span>
                          </div>
                        ) : (
                          <div className={`absolute inset-0 flex items-center justify-center transition-opacity ${b.imageUrl ? "opacity-0 group-hover:opacity-100" : "opacity-100"}`}
                            style={{ background: b.imageUrl ? "oklch(0 0 0 / 0.55)" : "transparent" }}>
                            {/* Status-specific affordance:
                                  - no image, status=failed → RotateCcw (Regenerate)
                                  - no image (any other status) → ImageSparkle (Generate)
                                  - has image → RotateCcw (Regenerate)
                                Failed uses the regenerate icon rather
                                than a distinct retry glyph — the intent
                                is the same as a normal regen and one
                                affordance keeps the tile UX consistent. */}
                            {(() => {
                              // Icon ref typed as the loose
                              // component shape ({ size, strokeWidth,
                              // className }) so both lucide icons
                              // (ForwardRef components) and our
                              // custom ImageSparkle (plain function
                              // component) can be assigned.
                              let Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }> = RotateCcw;
                              let label = "Regenerate";
                              if (!b.imageUrl && b.imageStatus !== "failed") {
                                Icon = ImageSparkle;
                                label = "Generate";
                              }
                              return (
                                <button
                                  onClick={(e) => { e.stopPropagation(); openAssetMenu(e, b, "image"); }}
                                  disabled={!selectedImageModel || generatingImages || generatingTts}
                                  title={generatingTts ? "Voiceover is generating — wait for it to finish" : undefined}
                                  aria-label={`${label} beat ${b.beatNumber}`}
                                  className="w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 hover:scale-110 cursor-pointer"
                                  style={{
                                    background: "oklch(0.72 0.25 285)",
                                    color: "white",
                                    boxShadow: "0 4px 16px oklch(0.72 0.25 285 / 0.55), 0 0 0 2px oklch(1 0 0 / 0.15)",
                                  }}
                                >
                                  <Icon size={20} strokeWidth={2.4} />
                                </button>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {imgGrid.bottomPad > 0 && <div aria-hidden className="col-span-full" style={{ height: imgGrid.bottomPad }} />}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    // Mobile has no inner grid scroll (page scrolls as one),
                    // so scroll the grid into view instead of scrolling it.
                    if (isMobile) imageGridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                    else imageGridRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  title="Jump to the first image"
                  aria-label="Scroll to top"
                  className="fixed sm:absolute top-24 sm:top-2 right-5 sm:right-3 z-30 w-7 h-7 rounded-md flex items-center justify-center transition-all hover:scale-105 active:scale-95"
                  style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.45)" }}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (isMobile) imageGridRef.current?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
                    else imageGridRef.current?.scrollTo({ top: imageGridRef.current.scrollHeight, behavior: "smooth" });
                  }}
                  title="Jump to the most recently generated image"
                  aria-label="Scroll to bottom"
                  className="fixed sm:absolute bottom-24 sm:bottom-2 right-5 sm:right-3 z-30 w-7 h-7 rounded-md flex items-center justify-center transition-all hover:scale-105 active:scale-95"
                  style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.45)" }}
                >
                  <ChevronDown size={14} />
                </button>
                </div>
              </div>
            )}
            </div>

            <div className={effectiveView === "single" ? "p-5 flex flex-col lg:flex-row lg:flex-wrap lg:items-center gap-2 lg:[&>div]:basis-full lg:[&>button]:flex-1" : "p-5 space-y-2"}>
              {(() => {
                // Three button states keyed off pendingCount:
                //   • pendingCount === totalBeats → first-time run: "Generate N Images"
                //   • 0 < pendingCount < totalBeats → partial fail: "Generate Remaining N"
                //   • pendingCount === 0 → all done: "Regenerate All" (this one wipes)
                const pendingCount = totalBeats - generatedImages;
                const isPartial = generatedImages > 0 && pendingCount > 0;
                const isAllDone = generatedImages > 0 && pendingCount === 0;
                const workingImageName = imageModels?.find((m) => m.id === selectedImageModel)?.name ?? "the selected model";
                const kieCredits = apiStatus?.kie?.credits;
                const showCreditBanner = outOfCredits || (typeof kieCredits === "number" && kieCredits <= 0);
                return (
                  <>
                    {showCreditBanner && (
                      <div className="px-3 py-2 rounded-lg text-xs leading-snug flex items-start gap-2"
                        style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.3)", color: "oklch(0.78 0.12 25)" }}>
                        <span aria-hidden style={{ marginTop: "1px" }}>⚠</span>
                        <span>
                          <span style={{ fontWeight: 600 }}>KIE credits exhausted.</span>{" "}
                          Top up your account at{" "}
                          <a href="https://kie.ai/billing" target="_blank" rel="noopener noreferrer"
                            style={{ textDecoration: "underline", fontWeight: 600 }}>
                            kie.ai/billing
                          </a>{" "}
                          to keep generating.
                        </span>
                      </div>
                    )}
                    {isPartial && !generatingImages && !showCreditBanner && !userStoppedImages && !imageErrorDismissed && (
                      <div ref={imageErrorBannerRef} className="px-3 py-2 rounded-lg text-xs leading-snug flex items-start gap-2"
                        style={{ background: "oklch(0.6 0.22 25 / 0.08)", border: "1px solid oklch(0.6 0.22 25 / 0.25)", color: "oklch(0.78 0.12 25)" }}>
                        <div className="flex-1 space-y-1">
                          <p>
                            {pendingCount} image{pendingCount === 1 ? "" : "s"} didn't generate on <span style={{ fontWeight: 600 }}>{workingImageName}</span>. Try switching to a different model above, then run again.
                          </p>
                          {imageRunError && (
                            <p style={{ color: "oklch(0.85 0.08 25)" }}>{imageRunError}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setImageErrorDismissed(true)}
                          aria-label="Dismiss"
                          className="shrink-0 -mr-1 -mt-0.5 p-1 rounded-md transition-colors hover:bg-[oklch(0.6_0.22_25_/_0.15)]"
                          style={{ color: "oklch(0.78 0.12 25)" }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )}
                    {generatingImages && (
                      <button
                        onClick={handleStopImages}
                        disabled={stoppingImages}
                        title="Halt the submission loop — already-submitted beats keep running and land via webhook / cron"
                        className="w-full py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-60"
                        style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                      >
                        {stoppingImages ? "Stopping…" : "Stop generation"}
                      </button>
                    )}
                    <button
                      onClick={() => generateImages({ mode: isAllDone ? "all" : "remaining" })}
                      disabled={generatingImages || generatingTts || !selectedImageModel || !beats.length || showCreditBanner}
                      title={generatingTts ? "Voiceover is generating — wait for it to finish before starting image generation" : showCreditBanner ? "KIE credits exhausted — top up to continue" : undefined}
                      className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                    >
                      {generatingImages ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          {`Generating… ${clearingImages ? 0 : generatedImages}/${totalBeats}`}
                        </span>
                      ) : isPartial
                        ? `Generate Remaining ${pendingCount}`
                        : isAllDone
                        ? `Regenerate All (${totalBeats})`
                        : `Generate ${totalBeats} Images`}
                    </button>
                    {/* Secondary "Regenerate All" affordance when some images
                        succeeded but others failed — gives users a way to
                        explicitly start over if they don't trust the
                        partial state. Wipes existing images. */}
                    {isPartial && !generatingImages && (
                      <button
                        onClick={() => setRegenerateAllConfirmOpen(true)}
                        disabled={generatingTts || !selectedImageModel || showCreditBanner}
                        className="w-full py-2 rounded-xl text-xs font-semibold disabled:opacity-40 transition-all hover:opacity-90 flex items-center justify-center gap-1.5"
                        style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                      >
                        <RotateCcw size={14} strokeWidth={2.4} />
                        {`Regenerate All (${totalBeats})`}
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
          )}

          {/* Video Gen Panel — same unmount-when-inactive treatment. */}
          {(effectiveView === "double" || singleStep === "video") && (
          <div className={`rounded-2xl overflow-hidden flex flex-col ${effectiveView === "double" ? "lg:grid lg:grid-rows-subgrid lg:row-span-3" : ""}`}
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
            <div className="p-5 min-h-[500px]" style={{ borderBottom: "1px solid var(--bd-6)" }}>
              <SectionHeader icon={<Video size={18} />} title="AI Video Clips" subtitle={`${videoBeats} clips · 3–5s each`} />
              <ModelPicker
                type="video"
                models={videoModels}
                selectedModelId={selectedVideoModel}
                onSelectModel={setSelectedVideoModel}
                selectedAspectRatio={selectedVideoAspectRatio}
                onSelectAspectRatio={setSelectedVideoAspectRatio}
                hideAspectRatio
                selectedDuration={selectedDuration ?? ""}
                onSelectDuration={setSelectedDuration}
                selectedResolution={selectedVideoResolution}
                onSelectResolution={setSelectedVideoResolution}
              />
            </div>

            {/* Middle subgrid row: stale banner + empty state + gallery.
                Always renders so the video panel has exactly three
                direct children matching the image panel's subgrid. */}
            <div className="flex flex-col">
            {beatsStale && !staleVideoDismissed && (
              <div className="px-5 pt-4">
                <div className="rounded-xl px-3 py-2.5 flex items-start gap-2 text-xs"
                  style={{ background: "oklch(0.72 0.16 70 / 0.12)", border: "1px solid oklch(0.72 0.16 70 / 0.35)", color: "oklch(0.85 0.12 70)" }}>
                  <span aria-hidden>⚠</span>
                  <span className="flex-1">
                    Script was edited after these beats were generated. Any clips below were prompted from the old script — regenerate the beats in <strong>Prompt Studio</strong> before re-running videos.
                  </span>
                  <button
                    type="button"
                    onClick={() => setStaleVideoDismissed(true)}
                    aria-label="Dismiss"
                    className="shrink-0 -mr-1 -mt-0.5 p-1 rounded-md transition-colors hover:bg-[oklch(0.72_0.16_70_/_0.18)]"
                    style={{ color: "oklch(0.85 0.12 70)" }}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* Video clip grid — mirrors image panel structure: progress + grid in one block.
                Renders placeholder cells (status "—") for every beat with a videoPrompt
                so the user sees the workflow scaffold before queuing any clips. */}
            {totalBeats > 0 && !beats.some((b) => b.videoPrompt) && (
              <div className="px-5 pt-4">
                <div className="rounded-xl p-6 flex flex-col items-center gap-3 text-center"
                  style={{ background: "var(--bg-progress)", border: "1px dashed var(--bd-8)" }}>
                  <Video size={22} style={{ color: "var(--c-35)" }} />
                  <div className="space-y-1">
                    <p className="text-sm font-medium" style={{ color: "var(--c-70)" }}>No video prompts yet</p>
                    <p className="text-xs leading-relaxed" style={{ color: "var(--c-45)" }}>
                      Generate video motion prompts in Prompt Studio to start queuing clips.
                    </p>
                  </div>
                  <button
                    onClick={() => router.push(`/projects/${projectId}/prompts`)}
                    className="mt-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                  >
                    Open Prompt Studio
                  </button>
                </div>
              </div>
            )}
            {beats.some((b) => b.videoPrompt) && (
              <div className="px-5 pt-4">
                <ProgressBar value={generatedVideos} total={videoBeats} />
                <div className="relative mt-3 mb-10">
                <div ref={vidGrid.setRef} className={`grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:overflow-y-auto scroll-visible pr-1 ${effectiveView === "single" ? "sm:max-h-[70vh]" : "max-h-[440px] sm:max-h-72"}`}>
                    {vidGrid.topPad > 0 && <div aria-hidden className="col-span-full" style={{ height: vidGrid.topPad }} />}
                    {videoBeatList.slice(vidGrid.start, vidGrid.end).map((b) => (
                      <div
                        key={b.beatNumber}
                        className="cv-tile w-full aspect-video rounded-lg overflow-hidden flex items-center justify-center relative group"
                        style={{ background: "var(--bg-progress)" }}
                        onMouseEnter={(e) => showBeatPrompt(e, b.beatNumber, b.videoPrompt)}
                        onMouseLeave={() => setPromptPopup(null)}
                        onClick={(e) => {
                          if (uploadingBeat === b.beatNumber) return;
                          // Generated → open preview. Empty → Generate/Upload menu.
                          if (b.videoUrl) openPreview(b, "video");
                          else openAssetMenu(e, b, "video");
                        }}
                      >
                        {uploadingBeat === b.beatNumber && (
                          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-1" style={{ background: "oklch(0 0 0 / 0.7)" }}>
                            <Spinner size={20} className="text-white" />
                            <span className="text-[10px] font-medium" style={{ color: "oklch(0.95 0 0)" }}>Uploading…</span>
                          </div>
                        )}
                        {/* Beat number badge — top-left corner of every
                            tile so the beat is identifiable at a glance
                            regardless of clip/status state. */}
                        <span
                          className="absolute top-1.5 left-1.5 z-10 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center text-[9px] font-semibold tabular-nums pointer-events-none"
                          style={{ background: "oklch(0 0 0 / 0.6)", color: "white", border: "1px solid oklch(1 0 0 / 0.15)" }}
                        >
                          {b.beatNumber}
                        </span>
                        {/* Touch-only "view prompt" — desktop uses hover. */}
                        <button
                          type="button"
                          onClick={(e) => showBeatPromptTap(e, b.beatNumber, b.videoPrompt)}
                          aria-label={`View prompt for beat ${b.beatNumber}`}
                          className="touch-only absolute bottom-1.5 left-1.5 z-20 w-7 h-7 rounded-full items-center justify-center"
                          style={{ background: "oklch(0 0 0 / 0.6)", color: "white", border: "1px solid oklch(1 0 0 / 0.15)" }}
                        >
                          <Info size={14} />
                        </button>
                        {/* Background layer: video if we have one,
                            status badge otherwise. The spinner +
                            regen overlays below sit on top of either. */}
                        {b.videoUrl ? (
                          <LazyVideoTile
                            src={b.videoUrl}
                            title={b.videoUrl}
                            className="w-full h-full object-cover"
                            muted
                            loop
                            playsInline
                            disablePictureInPicture
                            controlsList="nodownload nofullscreen noplaybackrate noremoteplayback"
                          />
                        ) : !b.videoStatus ? (
                          // Pre-queue placeholder — the beat has a prompt
                          // but hasn't been submitted yet. A video icon
                          // signals "this slot will hold a clip" more
                          // clearly than a bare "—" badge.
                          <Video size={20} style={{ color: "var(--c-30)" }} aria-label="No clip yet" />
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded"
                            title={b.videoStatus === "failed" && b.videoError ? b.videoError : undefined}
                            style={{
                              background: b.videoStatus === "rendering" ? "oklch(0.72 0.25 285 / 0.1)" : b.videoStatus === "done" ? "oklch(0.55 0.15 145 / 0.1)" : b.videoStatus === "failed" ? "oklch(0.6 0.22 25 / 0.1)" : "var(--bg-track)",
                              color: b.videoStatus === "rendering" ? "oklch(0.72 0.25 285)" : b.videoStatus === "done" ? "oklch(0.7 0.15 145)" : b.videoStatus === "failed" ? "oklch(0.7 0.2 25)" : "var(--c-35)",
                              cursor: b.videoStatus === "failed" && b.videoError ? "help" : undefined,
                            }}>
                            {/* Status badge maps 1:1 to the DB state so
                                only the beat the worker is currently
                                talking to KIE about reads as
                                "submitting" — other beats in the same
                                batch stay on "queued" until the worker
                                gets to them. The transition the user
                                sees per beat is:
                                queued → submitting → rendering → done. */}
                            {b.videoStatus}
                          </span>
                        )}

                        {/* In-flight overlay — mirrors the image
                            side's regen spinner. Replaces the static
                            status badge with a spinner + matching
                            "submitting…" / "rendering…" label so the
                            user gets a clear "work is happening here
                            right now" signal. Sits over the video
                            too, dimming the old frame while a regen
                            is mid-flight. */}
                        {(b.videoStatus === "submitting" || b.videoStatus === "rendering") && (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1"
                            style={{ background: "oklch(0 0 0 / 0.55)" }}>
                            <Spinner size={20} className="text-white" />
                            <span className="text-[10px] font-medium" style={{ color: "oklch(0.95 0 0)" }}>
                              {b.videoStatus}…
                            </span>
                          </div>
                        )}

                        {/* Regen overlay — uniform across every tile
                            state (done / failed / paused / pending /
                            empty). Hover-fades a dim backdrop with
                            a big centered purple-glow circle that
                            opens the per-beat regenerate confirm
                            modal. Disabled while the beat itself is
                            actively in-flight (queued or rendering)
                            so we don't double-queue the same task,
                            and during global active-video ops. */}
                        {(() => {
                          const inFlight = b.videoStatus === "queued" || b.videoStatus === "submitting" || b.videoStatus === "rendering";
                          // In-flight beats get a Stop affordance so the
                          // user can cancel a single beat without waiting
                          // for the whole batch. Once cancelled the beat
                          // flips to "failed" with a "Cancelled by user"
                          // reason, matching the visual language for any
                          // other stopped beat.
                          if (inFlight) {
                            const stopping = stoppingBeat === b.beatNumber;
                            return (
                              <div className="absolute inset-0 flex items-center justify-center transition-opacity opacity-0 group-hover:opacity-100"
                                style={{ background: "oklch(0 0 0 / 0.55)" }}>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void stopVideoBeat(b.beatNumber);
                                  }}
                                  disabled={stopping}
                                  title={stopping ? "Stopping…" : `Stop beat ${b.beatNumber}`}
                                  aria-label={`Stop beat ${b.beatNumber}`}
                                  className="w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 hover:scale-110 cursor-pointer"
                                  style={{
                                    background: "oklch(0.7 0.2 25)",
                                    color: "white",
                                    boxShadow: "0 3px 12px oklch(0.7 0.2 25 / 0.5), 0 0 0 1.5px oklch(1 0 0 / 0.15)",
                                  }}
                                >
                                  {stopping
                                    ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                    : <X size={14} strokeWidth={2.6} />}
                                </button>
                              </div>
                            );
                          }
                          // Per-beat disable so parallel manual regens are
                          // allowed — the tile only greys out while ITS
                          // own request is mid-flight. Bulk queue in
                          // progress still blocks single-beat regens so
                          // the two paths don't stomp each other during
                          // that specific window.
                          const disabled = queuingVideos || regeneratingBeats.has(b.beatNumber);
                          // Status-specific affordance so the icon
                          // matches the intent at a glance:
                          //   - no clip yet (no videoUrl + no status)
                          //              → Wand2 (Generate; matches the
                          //                image-side affordance for
                          //                first-time creation).
                          //   - paused  → ChevronsRight (fast-forward;
                          //               "continue this work").
                          //               Avoids the Play triangle
                          //               which read as a video play
                          //               button over the autoplaying
                          //               clip.
                          //   - failed  → RefreshCw (retry; the
                          //               standard retry affordance).
                          //   - other   → RotateCcw (regenerate;
                          //               redo from scratch).
                          let Icon: typeof RotateCcw = RotateCcw;
                          let label = "Regenerate";
                          if (!b.videoUrl && !b.videoStatus) {
                            Icon = Wand2;
                            label = "Generate";
                          } else if (b.videoStatus === "paused") {
                            Icon = ChevronsRight;
                            label = "Resume";
                          } else if (b.videoStatus === "failed") {
                            Icon = RefreshCw;
                            label = "Retry";
                          }
                          return (
                            <div className="absolute inset-0 flex items-center justify-center transition-opacity opacity-0 group-hover:opacity-100"
                              style={{ background: "oklch(0 0 0 / 0.55)" }}>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  // All states open the menu; its first
                                  // option adapts (Generate/Regenerate/
                                  // Retry/Resume) + Upload.
                                  openAssetMenu(e, b, "video");
                                }}
                                disabled={disabled}
                                title={`${label} beat ${b.beatNumber}`}
                                aria-label={`${label} beat ${b.beatNumber}`}
                                className="w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 hover:scale-110 cursor-pointer"
                                style={{
                                  background: "oklch(0.72 0.25 285)",
                                  color: "white",
                                  boxShadow: "0 4px 16px oklch(0.72 0.25 285 / 0.55), 0 0 0 2px oklch(1 0 0 / 0.15)",
                                }}
                              >
                                <Icon size={20} strokeWidth={2.4} />
                              </button>
                            </div>
                          );
                        })()}

                        {/* View affordance — opens the full closable
                            preview dialog. Replaces the old floating
                            hover preview. */}
                        {b.videoUrl && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openPreview(b, "video");
                            }}
                            title="View clip"
                            aria-label={`View clip for beat ${b.beatNumber}`}
                            className="absolute top-1.5 right-1.5 z-10 w-7 h-7 rounded-full flex items-center justify-center transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:scale-110"
                            style={{
                              background: "oklch(0 0 0 / 0.6)",
                              color: "white",
                              border: "1px solid oklch(1 0 0 / 0.15)",
                            }}
                          >
                            <Eye size={12} strokeWidth={2.4} />
                          </button>
                        )}
                      </div>
                    ))}
                  {vidGrid.bottomPad > 0 && <div aria-hidden className="col-span-full" style={{ height: vidGrid.bottomPad }} />}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (isMobile) videoGridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                    else videoGridRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  title="Jump to the first clip"
                  aria-label="Scroll to top"
                  className="fixed sm:absolute top-24 sm:top-2 right-5 sm:right-3 z-30 w-7 h-7 rounded-md flex items-center justify-center transition-all hover:scale-105 active:scale-95"
                  style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.45)" }}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (isMobile) videoGridRef.current?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
                    else videoGridRef.current?.scrollTo({ top: videoGridRef.current.scrollHeight, behavior: "smooth" });
                  }}
                  title="Jump to the most recently queued clip"
                  aria-label="Scroll to bottom"
                  className="fixed sm:absolute bottom-24 sm:bottom-2 right-5 sm:right-3 z-30 w-7 h-7 rounded-md flex items-center justify-center transition-all hover:scale-105 active:scale-95"
                  style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.45)" }}
                >
                  <ChevronDown size={14} />
                </button>
                </div>
              </div>
            )}
            </div>

            <div className={effectiveView === "single" ? "p-5 flex flex-col lg:flex-row lg:flex-wrap lg:items-center gap-2 lg:[&>div]:basis-full lg:[&>button]:flex-1" : "p-5 space-y-2"}>
              {((failedVideos > 0 && !hasActiveVideos) || videoRunError) && !videoErrorDismissed && (() => {
                const workingId = project?.video_model_id as string | undefined;
                const workingName = videoModels?.find((m) => m.id === workingId)?.name ?? "the selected model";
                // Surface every DISTINCT failure reason across the failed
                // beats (deduped by friendly message), not just the most
                // recent one — otherwise the user fixes the one beat shown
                // here and a different error surfaces on the next retry. A
                // fresh action-level error (videoRunError) leads the list.
                const distinctBeatErrors = Array.from(new Set(
                  beats
                    .filter((b) => b.videoStatus === "failed" && b.videoError)
                    .map((b) => friendlyError(b.videoError!)),
                ));
                const errors = videoRunError
                  ? [videoRunError, ...distinctBeatErrors.filter((e) => e !== videoRunError)]
                  : distinctBeatErrors;
                // Content-policy blocks are fixed by rephrasing the prompt,
                // not by switching models — so drop the generic "switch
                // model" advice when every surfaced error is a content block
                // (the per-error message already routes them to Prompt Studio).
                const isContentBlock = (e: string) => e.startsWith("Content policy block");
                const allContentBlocks = errors.length > 0 && errors.every(isContentBlock);
                const MAX_SHOWN = 3;
                const shown = errors.slice(0, MAX_SHOWN);
                const extra = errors.length - shown.length;
                return (
                  <div ref={videoErrorBannerRef} className="px-3 py-2 rounded-lg text-xs leading-snug flex items-start gap-2"
                    style={{ background: "oklch(0.6 0.22 25 / 0.08)", border: "1px solid oklch(0.6 0.22 25 / 0.25)", color: "oklch(0.78 0.12 25)" }}>
                    <div className="flex-1 space-y-1">
                      {failedVideos > 0 && !allContentBlocks && (
                        <p>
                          {failedVideos} clip{failedVideos === 1 ? "" : "s"} failed on <span style={{ fontWeight: 600 }}>{workingName}</span>. Try switching to a different model above, then retry.
                        </p>
                      )}
                      {shown.map((e) => (
                        <p key={e} style={{ color: "oklch(0.85 0.08 25)" }}>{e}</p>
                      ))}
                      {extra > 0 && (
                        <p style={{ color: "oklch(0.85 0.08 25)" }}>
                          +{extra} more failed beat{extra === 1 ? "" : "s"} with a different error.
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setVideoErrorDismissed(true)}
                      aria-label="Dismiss"
                      className="shrink-0 -mr-1 -mt-0.5 p-1 rounded-md transition-colors hover:bg-[oklch(0.6_0.22_25_/_0.15)]"
                      style={{ color: "oklch(0.78 0.12 25)" }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              })()}
              {/* Primary action morphs by state:
                  - queuing-in-flight: spinner
                  - paused beats exist: Resume (green)
                  - queued beats exist: Pause (orange)
                  - pending work remains: Queue (purple)
                  - nothing to do: disabled Queue
                  Retry Failed stays as a secondary button when applicable. */}
              {queuingVideos ? (
                <button
                  disabled
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Queuing clips…
                  </span>
                </button>
              ) : pausedVideos > 0 ? (
                <button
                  onClick={resumeVideos}
                  disabled={!selectedVideoModel || resumingVideos || videosBlockedByImages}
                  title={videoBlockReason}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.7 0.15 145)", color: "var(--bg-page-2)" }}
                >
                  {resumingVideos ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Resuming…
                    </span>
                  ) : `Resume ${pausedVideos} Clip${pausedVideos === 1 ? "" : "s"}`}
                </button>
              ) : queuedVideos > 0 ? (
                <button
                  onClick={pauseVideos}
                  disabled={pausingVideos}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "transparent", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.7 0.2 25)" }}
                >
                  {pausingVideos ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Pausing…
                    </span>
                  ) : `Pause ${queuedVideos} Pending`}
                </button>
              ) : failedVideos > 0 && pendingVideos === failedVideos ? (
                <button
                  onClick={() => queueVideos("failed")}
                  disabled={!selectedVideoModel || videosBlockedByImages}
                  title={videoBlockReason}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  Re-queue {failedVideos} Clip{failedVideos === 1 ? "" : "s"}
                </button>
              ) : (
                <button
                  onClick={() => queueVideos("all")}
                  disabled={!selectedVideoModel || !pendingVideosWithImages || videosBlockedByImages}
                  title={videoBlockReason}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  {videosBlockedByImages
                    ? `Waiting on first image (${generatedImages}/${totalBeats})`
                    : `Queue ${pendingVideosWithImages} Video Clip${pendingVideosWithImages === 1 ? "" : "s"}`}
                </button>
              )}
              {/* Show the secondary "Retry Failed" only when there are also some
                  never-attempted beats — otherwise the primary "Re-queue" already
                  covers the failed-only case. */}
              {failedVideos > 0 && pendingVideos > failedVideos && !hasActiveVideos && !queuingVideos && (
                <button
                  onClick={() => queueVideos("failed")}
                  disabled={!selectedVideoModel || videosBlockedByImages}
                  title={videoBlockReason}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "transparent", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285)" }}
                >
                  Retry {failedVideos} Failed
                </button>
              )}
            </div>
          </div>
          )}
        </div>
        {/* The Images/Videos tabs above replace the old single-column
            Continue-to-video / Back-to-images nav. */}
        </div>
      </main>

      {/* Fixed bottom bar */}
      {(() => {
        // Only hard gate now: at least one beat has an image. Voiceover
        // (legacy tts_url) and videos are soft — the user may have
        // per-beat voiceovers (a separate step) or be intentionally
        // skipping clips. The assemble step gracefully handles missing
        // pieces, so the button stays usable as soon as there's
        // something to assemble.
        const hasAnyImage = generatedImages > 0;
        const canContinue = hasAnyImage;
        const pendingImageCount = totalBeats > 0 ? totalBeats - generatedImages : 0;
        const someImagesPending = canContinue && pendingImageCount > 0;
        const pendingVideoCount = videoBeats > 0 ? videoBeats - generatedVideos : 0;
        const noVideosYet = canContinue && videoBeats > 0 && generatedVideos === 0;
        const someVideosPending = canContinue && videoBeats > 0 && pendingVideoCount > 0 && !noVideosYet;
        // Whether advancing now means advancing on a partial set. When true,
        // the first Continue click reveals the skip-warnings drawer instead
        // of navigating; the drawer explains what gets skipped/substituted.
        const hasPendingWarnings = someImagesPending || someVideosPending || noVideosYet;
        const drawerOpen = warningsRevealed && hasPendingWarnings && !navigating;
        // Label stays "Continue →" until the drawer is showing, then flips
        // to "Continue anyway" to signal the second click advances anyway.
        const continueLabel = drawerOpen ? "Continue anyway" : "Continue →";
        const handleContinue = () => {
          if (hasPendingWarnings && !warningsRevealed) { setWarningsRevealed(true); return; }
          setNavigating(true);
          router.push(`/projects/${projectId}/assemble`);
        };

        return (
          <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
            style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
            <div className="sm:px-8">
              {!canContinue && !navigating && (
                <p className="text-xs text-center mb-2" style={{ color: "var(--c-40)" }}>
                  Generate at least one image to continue.
                </p>
              )}
              {/* Skip-warnings drawer — hidden until the first Continue click.
                  A 0fr→1fr grid row animates the height so it slides up from
                  the bar as a drawer. Kept mounted (not conditionally
                  rendered) so the open/close transition is smooth. */}
              <div
                className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
                style={{ gridTemplateRows: drawerOpen ? "1fr" : "0fr", opacity: drawerOpen ? 1 : 0 }}
                aria-hidden={!drawerOpen}
              >
                <div className="overflow-hidden">
                  <div className="flex items-center justify-center gap-2 pb-2 pt-1">
                    <div className="space-y-1">
                      {someImagesPending && (
                        <p className="text-xs text-center" style={{ color: "var(--c-40)" }}>
                          {pendingImageCount} beat{pendingImageCount === 1 ? "" : "s"} still without image — {pendingImageCount === 1 ? "it will" : "they will"} be skipped at assembly.
                        </p>
                      )}
                      {noVideosYet && (
                        <p className="text-xs text-center" style={{ color: "var(--c-40)" }}>
                          No video clips yet — every beat will use its image at assembly.
                        </p>
                      )}
                      {someVideosPending && (
                        <p className="text-xs text-center" style={{ color: "var(--c-40)" }}>
                          {pendingVideoCount} clip{pendingVideoCount === 1 ? "" : "s"} without video — the matching image{pendingVideoCount === 1 ? "" : "s"} will be used in those spots.
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setWarningsRevealed(false)}
                      aria-label="Dismiss"
                      tabIndex={drawerOpen ? 0 : -1}
                      className="shrink-0 p-1 rounded-md transition-colors hover:bg-[var(--bg-input)]"
                      style={{ color: "var(--c-40)" }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              </div>
              <button
                onClick={handleContinue}
                disabled={navigating || !canContinue}
                className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                {navigating ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Loading…
                  </span>
                ) : continueLabel}
              </button>
            </div>
          </div>
        );
      })()}

      <Dialog open={regenerateAllConfirmOpen} onOpenChange={(open) => { if (!generatingImages && !regenerateAllSubmitting) setRegenerateAllConfirmOpen(open); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Regenerate all images?</DialogTitle>
            <DialogDescription>
              This will <strong>wipe every existing image</strong> on this project and generate {totalBeats} fresh image{totalBeats === 1 ? "" : "s"} from your prompts. KIE credits will be charged for the new generations. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setRegenerateAllConfirmOpen(false)}
              disabled={generatingImages || regenerateAllSubmitting}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                setRegenerateAllSubmitting(true);
                // Kick off the long-running image work; it manages its
                // own page-level progress UI from here. Brief await
                // gives the user visual confirmation in the modal
                // before we dismiss.
                void generateImages({ mode: "all" });
                await new Promise((r) => setTimeout(r, 400));
                setRegenerateAllSubmitting(false);
                setRegenerateAllConfirmOpen(false);
              }}
              disabled={generatingImages || regenerateAllSubmitting}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white transition-all disabled:opacity-60"
              style={{ background: "oklch(0.72 0.25 285)" }}
            >
              {regenerateAllSubmitting ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Starting…
                </span>
              ) : "Regenerate all"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hidden file input driving beat uploads (image or video). */}
      <input ref={uploadInputRef} type="file" className="hidden" onChange={onUploadFileChange} />

      {/* Generate / Upload menu for a beat with no asset yet. Global fixed
          element (with a click-away backdrop) so it's never clipped by the
          grids' overflow. */}
      {assetMenu && (() => {
        const beat = beats.find((x) => x.beatNumber === assetMenu.beatNumber);
        if (!beat) return null;
        const ActionIcon = assetMenu.actionLabel === "Generate" ? Wand2
          : assetMenu.actionLabel === "Retry" ? RefreshCw
          : assetMenu.actionLabel === "Resume" ? ChevronsRight
          : RotateCcw;
        return (
          <>
            <div className="fixed inset-0 z-[490]" onClick={() => setAssetMenu(null)} />
            <div
              className="fixed z-[500] flex flex-col gap-0.5 rounded-lg shadow-xl p-1"
              style={{ left: assetMenu.left, top: assetMenu.top, transform: "translate(-50%, -50%)", background: "white", border: "1px solid oklch(0 0 0 / 0.1)" }}
            >
              <button
                onClick={() => { setAssetMenu(null); if (assetMenu.type === "image") regenerateImage(beat); else void regenerateVideoBeat(beat.beatNumber); }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium text-zinc-800 hover:bg-zinc-100 transition-colors"
              >
                <ActionIcon size={13} /> {assetMenu.actionLabel}
              </button>
              <button
                onClick={() => triggerBeatUpload(assetMenu.beatNumber, assetMenu.type)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium text-zinc-800 hover:bg-zinc-100 transition-colors"
              >
                <Upload size={13} /> Upload
              </button>
            </div>
          </>
        );
      })()}

      {/* Global hover-prompt popup. Fixed-position + rendered once at the
          page root so it never gets clipped by the beat grids' overflow.
          White card, 7px padding, wider than a tile. */}
      {/* Touch-only backdrop: the tap-triggered prompt popup has no
          mouseleave to dismiss it, so a tap anywhere closes it. Hidden on
          hover devices where the tooltip follows the pointer. */}
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

      {/* No-image alert — every video model is image-to-video, so a beat
          with no image can't be generated. Explains the fix. */}
      <Dialog open={!!noImageAlert} onOpenChange={(open) => { if (!open) setNoImageAlert(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generate the image first</DialogTitle>
            <DialogDescription>{noImageAlert}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setNoImageAlert(null)}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white"
              style={{ background: "oklch(0.72 0.25 285)" }}
            >
              Got it
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!previewBeat} onOpenChange={(open) => { if (!open && !previewSubmitting) { setPreviewBeat(null); setPreviewEditing(false); setPreviewShowPrompt(false); setPreviewAspect(null); } }}>
        {/* View mode: media only (prompt hidden). Edit mode: dialog
            shrinks and an editable prompt + Save & regenerate appears
            under the media. */}
        <DialogContent
          className={`${previewEditing ? "sm:max-w-xl" : "sm:max-w-3xl"} p-0 overflow-x-hidden overflow-y-auto`}
          showCloseButton={false}
          style={{
            background: "white",
            // The dialog always shrink-wraps the media so its own aspect
            // ratio is honored with no white letterbox borders — in view,
            // show-prompt, and edit modes alike. The prompt panel/editor
            // below inherits the media's width.
            //
            // Override the base DialogContent `grid`+`gap-4` with a plain
            // flex column: grid auto-track sizing fought the media's
            // max-width (leaving a top strip + a gap above the prompt).
            // Flex-col keeps the media flush to the top.
            display: "flex",
            flexDirection: "column",
            // Width is pinned to the media's computed pixel width so the
            // dialog hugs it exactly. `fit-content` can't be used here: the
            // read-only prompt is a long <p> whose max-content width would
            // blow the box out to 95vw. Pinning the width makes the prompt
            // wrap to the media instead of dictating the dialog size.
            //
            // In edit and show-prompt modes enforce a 400px minimum
            // (regardless of aspect) so the prompt/editor stays readable
            // for tall/portrait media — the media then centers within the
            // wider box. maxWidth: 95vw clamps the min on very narrow
            // viewports. Plain view still hugs the media exactly.
            width: previewMediaSize
              ? (previewEditing || previewShowPrompt ? Math.max(previewMediaSize.w, 400) : previewMediaSize.w)
              : undefined,
            maxWidth: "95vw",
            // Safety net: if the media + panel still slightly exceed the
            // viewport, scroll inside the dialog rather than clipping the
            // top/bottom (badge, close button, Save action).
            maxHeight: "95vh",
          }}
        >
          {/* Action cluster — edit before close, both high-contrast
              over full-bleed media. */}
          <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
            {!previewEditing && (
              <>
                <button
                  onClick={() => setPreviewShowPrompt((v) => !v)}
                  title={previewShowPrompt ? "Hide prompt" : "Show prompt"}
                  aria-label={previewShowPrompt ? "Hide prompt" : "Show prompt"}
                  aria-pressed={previewShowPrompt}
                  className="h-9 px-3 rounded-full flex items-center justify-center text-xs font-medium transition-all hover:scale-105"
                  style={{
                    background: previewShowPrompt ? "oklch(0.72 0.25 285 / 0.85)" : "oklch(0 0 0 / 0.65)",
                    color: "white",
                    border: "1px solid oklch(1 0 0 / 0.2)",
                  }}
                >
                  {previewShowPrompt ? "Hide prompt" : "Show prompt"}
                </button>
                <button
                  onClick={() => {
                    if (!previewBeat) return;
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
            {/* Upload (edit mode, images only) — replace this beat's
                image with a file from the user's device. Not offered for
                video: clips should come through the generation pipeline.
                Sits just before Close. */}
            {previewEditing && previewBeat && previewBeat.type === "image" && (
              <button
                type="button"
                onClick={() => triggerBeatUpload(previewBeat.beat.beatNumber, previewBeat.type)}
                disabled={previewSubmitting || uploadingBeat === previewBeat.beat.beatNumber}
                title="Upload a file for this beat"
                aria-label="Upload"
                className="w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110 disabled:opacity-50"
                style={{ background: "oklch(0 0 0 / 0.65)", color: "white", border: "1px solid oklch(1 0 0 / 0.2)" }}
              >
                <Upload size={16} strokeWidth={2.4} />
              </button>
            )}
            <button
              onClick={() => { if (!previewSubmitting) { setPreviewBeat(null); setPreviewEditing(false); setPreviewShowPrompt(false); setPreviewAspect(null); } }}
              title="Close preview"
              aria-label="Close preview"
              className="w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110"
              style={{ background: "oklch(0 0 0 / 0.65)", color: "white", border: "1px solid oklch(1 0 0 / 0.2)" }}
            >
              <X size={18} strokeWidth={2.4} />
            </button>
          </div>
          {/* Beat number — top-left corner, over the media, mirroring
              the corner badge on the grid tiles. */}
          {previewBeat && (
            <span
              className="absolute top-3 left-3 z-20 min-w-[28px] h-7 px-2 rounded-full flex items-center justify-center text-xs font-semibold tabular-nums pointer-events-none"
              style={{ background: "oklch(0 0 0 / 0.65)", color: "white", border: "1px solid oklch(1 0 0 / 0.2)" }}
            >
              {previewBeat.beat.beatNumber}
            </span>
          )}

          {/* Vertical tags below the close cluster — resolution + duration
              (video) or resolution alone (image). For video we use the
              beat's stored snapshot (migration 091) so the tags reflect
              what THIS clip was generated with. For image we don't have a
              per-beat resolution snapshot yet, so we fall back to the
              current picker selection as a best-effort indicator. Tags
              only render when a value is available so an empty column
              never sits under the close button. */}
          {previewBeat && !previewEditing && (() => {
            const tags: string[] = [];
            if (previewBeat.type === "video") {
              if (previewBeat.beat.videoResolution) tags.push(previewBeat.beat.videoResolution);
              if (previewBeat.beat.videoDuration != null && previewBeat.beat.videoDuration !== "") {
                const d = previewBeat.beat.videoDuration;
                // n_frames-style values (Sora) stay as-is; sec values
                // get a friendly "s" suffix.
                tags.push(typeof d === "number" || /^\d+$/.test(String(d)) ? `${d}s` : String(d));
              }
            } else if (previewBeat.type === "image") {
              if (selectedResolution) tags.push(selectedResolution);
            }
            if (tags.length === 0) return null;
            return (
              <div className="absolute top-14 right-3 z-20 flex flex-col items-end gap-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide"
                    style={{
                      background: "oklch(0 0 0 / 0.65)",
                      color: "white",
                      border: "1px solid oklch(1 0 0 / 0.2)",
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            );
          })()}
          {/* While uploading, blank the body and show a single status. */}
          {isUploadingPreview && (
            <div className="flex flex-col items-center justify-center gap-3" style={{ minHeight: 280, padding: 32 }}>
              <Spinner size={28} className="text-zinc-500" />
              <span className="text-sm font-medium text-zinc-600">Uploading…</span>
            </div>
          )}
          {/* Media renders at its own intrinsic aspect ratio — capped to
              the dialog width and the viewport height so portrait and
              landscape both fit without cropping. */}
          {!isUploadingPreview && previewBeat?.type === "image" && previewBeat.beat.imageUrl && (
            <img
              src={previewBeat.beat.imageUrl}
              alt={`Beat ${previewBeat.beat.beatNumber}`}
              // Aspect is already seeded synchronously by openPreview (from
              // the cached grid image), so the box is sized on the first
              // render. onLoad just refines it to the exact ratio.
              onLoad={(e) => setPreviewAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
              className="block mx-auto"
              style={{ width: previewMediaSize?.w, height: previewMediaSize?.h, maxWidth: "95vw", maxHeight: "85vh" }}
            />
          )}
          {!isUploadingPreview && previewBeat?.type === "video" && previewBeat.beat.videoUrl && (
            <video
              key={previewBeat.beat.videoUrl}
              src={previewBeat.beat.videoUrl}
              // Seeded from the source image by openPreview; refine to the
              // exact clip ratio once metadata loads.
              onLoadedMetadata={(e) => setPreviewAspect(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
              className="block mx-auto"
              style={{ width: previewMediaSize?.w, height: previewMediaSize?.h, maxWidth: "95vw", maxHeight: "85vh" }}
              autoPlay
              loop
              playsInline
              controls
            />
          )}
          {/* Read-only prompt — toggled by the "Show prompt" pill. */}
          {!isUploadingPreview && previewShowPrompt && !previewEditing && previewBeat && (
            <div className="px-4 py-3">
              <p className="text-xs font-semibold mb-1" style={{ color: "oklch(0.35 0 0)" }}>
                {previewBeat.type === "image" ? "Image prompt" : "Video prompt"} — beat {previewBeat.beat.beatNumber}
              </p>
              <p className="text-xs leading-relaxed" style={{ color: "oklch(0.45 0 0)" }}>
                {(previewBeat.type === "image" ? previewBeat.beat.imagePrompt : previewBeat.beat.videoPrompt) || "—"}
              </p>
            </div>
          )}
          {!isUploadingPreview && previewEditing && previewBeat && (
            <div className="px-4 py-3 space-y-3">
              <p className="text-xs font-semibold" style={{ color: "oklch(0.35 0 0)" }}>
                {previewBeat.type === "image" ? "Image prompt" : "Video prompt"} — beat {previewBeat.beat.beatNumber}
              </p>
              <textarea
                value={previewEditedPrompt}
                onChange={(e) => setPreviewEditedPrompt(e.target.value)}
                rows={5}
                className="w-full rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-800 text-xs leading-relaxed p-3 outline-none focus:border-zinc-400 resize-y"
                placeholder="Describe what this beat should look like…"
              />
              {/* Model + variant selectors, side by side. The second
                  control is resolution for images and duration for videos
                  — both driven off the selected model's config, mirroring
                  the panel's ModelPicker choices (shared selected* state).
                  Native selects styled with zinc utilities for the white
                  modal. */}
              <div className="flex gap-3">
                <div className="flex-1 min-w-0">
                  <label className="block text-xs font-semibold mb-1" style={{ color: "oklch(0.35 0 0)" }}>
                    Model
                  </label>
                  <select
                    value={(previewBeat.type === "image" ? selectedImageModel : selectedVideoModel) ?? ""}
                    onChange={(e) => {
                      if (previewBeat.type === "image") setSelectedImageModel(e.target.value);
                      else setSelectedVideoModel(e.target.value);
                    }}
                    disabled={previewSubmitting}
                    className="w-full rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-800 text-xs p-2.5 outline-none focus:border-zinc-400 disabled:opacity-40"
                  >
                    <option value="" disabled>Select a model…</option>
                    {(previewBeat.type === "image" ? imageModels : videoModels)?.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
                {previewBeat.type === "image" ? (
                  (() => {
                    const resolutions = selectedImageModel ? getModelConfig(selectedImageModel).resolutions ?? [] : [];
                    return (
                      <div className="flex-1 min-w-0">
                        <label className="block text-xs font-semibold mb-1" style={{ color: "oklch(0.35 0 0)" }}>
                          Resolution
                        </label>
                        <select
                          value={selectedResolution ?? ""}
                          onChange={(e) => setSelectedResolution(e.target.value || null)}
                          disabled={previewSubmitting || resolutions.length === 0}
                          className="w-full rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-800 text-xs p-2.5 outline-none focus:border-zinc-400 disabled:opacity-40"
                        >
                          {resolutions.length === 0
                            ? <option value="">Default</option>
                            : resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                    );
                  })()
                ) : (
                  <>
                    {(() => {
                      const durations = selectedVideoModel ? getVideoModelConfig(selectedVideoModel).durations : [];
                      return (
                        <div className="flex-1 min-w-0">
                          <label className="block text-xs font-semibold mb-1" style={{ color: "oklch(0.35 0 0)" }}>
                            Duration
                          </label>
                          <select
                            value={selectedDuration != null ? String(selectedDuration) : ""}
                            onChange={(e) => {
                              // Preserve the config's original value type
                              // (number vs string) — the API distinguishes.
                              const opt = durations.find((d) => String(d.value) === e.target.value);
                              setSelectedDuration(opt ? opt.value : null);
                            }}
                            disabled={previewSubmitting || durations.length === 0}
                            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-800 text-xs p-2.5 outline-none focus:border-zinc-400 disabled:opacity-40"
                          >
                            {durations.length === 0
                              ? <option value="">Default</option>
                              : durations.map((d) => <option key={String(d.value)} value={String(d.value)}>{d.label}</option>)}
                          </select>
                        </div>
                      );
                    })()}
                    {(() => {
                      const vres = selectedVideoModel ? getVideoModelConfig(selectedVideoModel).resolutions ?? [] : [];
                      return (
                        <div className="flex-1 min-w-0">
                          <label className="block text-xs font-semibold mb-1" style={{ color: "oklch(0.35 0 0)" }}>
                            Resolution
                          </label>
                          <select
                            value={selectedVideoResolution ?? ""}
                            onChange={(e) => setSelectedVideoResolution(e.target.value || null)}
                            disabled={previewSubmitting || vres.length === 0}
                            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-800 text-xs p-2.5 outline-none focus:border-zinc-400 disabled:opacity-40"
                          >
                            {vres.length === 0
                              ? <option value="">Default</option>
                              : vres.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => setPreviewEditing(false)}
                  disabled={previewSubmitting}
                  className="px-4 py-2 rounded-lg text-sm font-medium border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                >
                  Cancel
                </button>
                {(() => {
                  const trimmed = previewEditedPrompt.trim();
                  const original = ((previewBeat.type === "image" ? previewBeat.beat.imagePrompt : previewBeat.beat.videoPrompt) ?? "").trim();
                  const modelPicked = previewBeat.type === "image" ? !!selectedImageModel : !!selectedVideoModel;
                  const canSave = !!trimmed && trimmed !== original && modelPicked && !previewSubmitting;
                  return (
                    <button
                      onClick={async () => {
                        if (!canSave) return;
                        const { beat, type } = previewBeat;
                        setPreviewSubmitting(true);
                        // Fire-and-forget like the standalone edit
                        // modal — the tile flips to its own
                        // regenerating state in the grid.
                        if (type === "image") void regenerateImage(beat, trimmed);
                        else void regenerateVideoBeat(beat.beatNumber, trimmed);
                        await new Promise((r) => setTimeout(r, 400));
                        setPreviewSubmitting(false);
                        setPreviewEditing(false);
                        setPreviewBeat(null);
                      }}
                      disabled={!canSave}
                      className="px-4 py-2 rounded-lg text-sm font-semibold text-white transition-all disabled:opacity-60"
                      style={{ background: "oklch(0.72 0.25 285)" }}
                    >
                      {previewSubmitting ? (
                        <span className="flex items-center gap-2">
                          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Starting…
                        </span>
                      ) : "Save & regenerate"}
                    </button>
                  );
                })()}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleteVoiceoverConfirmOpen} onOpenChange={(open) => { if (!deletingVoiceover) setDeleteVoiceoverConfirmOpen(open); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete voiceover?</DialogTitle>
            <DialogDescription>
              This will <strong>permanently delete</strong> the original and trimmed voiceover files from storage. You&apos;ll need to regenerate them before you can assemble the video. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setDeleteVoiceoverConfirmOpen(false)}
              disabled={deletingVoiceover}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{ background: "transparent", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
            >
              Cancel
            </button>
            <button
              onClick={deleteVoiceover}
              disabled={deletingVoiceover}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-60"
              style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
            >
              {deletingVoiceover ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Deleting…
                </span>
              ) : "Delete voiceover"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
