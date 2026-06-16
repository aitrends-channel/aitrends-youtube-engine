"use client";

import { useState, use, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import useSWR from "swr";
import { RotateCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { ThumbnailConcept, KieModel } from "@/lib/types";
import { getModelConfig } from "@/lib/kie/imageModels";
import { presignedUpload } from "@/lib/upload-client";

interface PageProps {
  params: { projectId: string };
}

type StepStatus = "idle" | "running" | "done" | "error";
interface StepState { status: StepStatus; message: string; error?: string }
const IDLE: StepState = { status: "idle", message: "" };

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) return r.json().catch(() => ({})).then((e: { error?: string }) => { throw new Error(e.error ?? `Request failed (${r.status})`); });
    return r.json().catch(() => ({}));
  });

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
      title="Copy"
      className="shrink-0 w-5 h-5 flex items-center justify-center rounded transition-colors"
      style={{ color: copied ? "oklch(0.7 0.15 145)" : "var(--c-35)" }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="4" y="1" width="7" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M1 4.5h0a1.5 1.5 0 0 1 1.5-1.5H4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <rect x="1" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
    </button>
  );
}

function DownloadButton({ url, filename }: { url: string; filename: string }) {
  const [downloading, setDownloading] = useState(false);

  async function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    setDownloading(true);
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(objectUrl);
    } catch {
      // silently fail — the image can still be opened in a new tab
    } finally {
      setDownloading(false);
    }
  }

  return (
    <button
      onClick={handleDownload}
      disabled={downloading}
      title="Download image"
      className="w-7 h-7 rounded-lg flex items-center justify-center transition-all disabled:opacity-50"
      style={{ background: "var(--bg-overlay)", color: "var(--c-75)" }}
    >
      {downloading ? (
        <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
      ) : (
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
          <path d="M6.5 1v7M4 6l2.5 2.5L9 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M1.5 10.5v.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function PreviewModal({
  thumbs,
  index,
  onClose,
  onNav,
}: {
  thumbs: ThumbnailConcept[];
  index: number;
  onClose: () => void;
  onNav: (i: number) => void;
}) {
  const thumb = thumbs[index];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onNav(index - 1);
      if (e.key === "ArrowRight" && index < thumbs.length - 1) onNav(index + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, thumbs.length, onClose, onNav]);

  if (!thumb) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "oklch(0 0 0 / 0.85)", backdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <div
        className="relative flex flex-col max-w-4xl w-full max-h-full"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="flex items-center gap-3">
            <span className="w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold shrink-0"
              style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)" }}>
              {thumb.position}
            </span>
            <p className="text-sm font-semibold text-white/90 truncate">{thumb.title}</p>
          </div>
          <div className="flex items-center gap-2">
            {thumb.imageUrl && (
              <DownloadButton url={thumb.imageUrl} filename={`thumbnail-${thumb.position}.png`} />
            )}
            <button
              onClick={onClose}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-white/10"
              style={{ color: "var(--c-55)" }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {/* Image */}
        <div className="relative rounded-xl overflow-hidden" style={{ background: "var(--bg-card-subtle)" }}>
          <div className="aspect-video w-full">
            {thumb.imageUrl ? (
              <img src={thumb.imageUrl} alt={thumb.title} className="w-full h-full object-contain" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <p className="text-sm" style={{ color: "var(--c-35)" }}>No image generated yet</p>
              </div>
            )}
          </div>

          {/* Prev / Next arrows */}
          {index > 0 && (
            <button
              onClick={() => onNav(index - 1)}
              className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-xl flex items-center justify-center transition-all hover:scale-105"
              style={{ background: "var(--bg-overlay)", color: "var(--c-70)" }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          {index < thumbs.length - 1 && (
            <button
              onClick={() => onNav(index + 1)}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-xl flex items-center justify-center transition-all hover:scale-105"
              style={{ background: "var(--bg-overlay)", color: "var(--c-70)" }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M5 2l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>

        {/* Dot indicators */}
        {thumbs.length > 1 && (
          <div className="flex justify-center gap-1.5 mt-3">
            {thumbs.map((_, i) => (
              <button
                key={i}
                onClick={() => onNav(i)}
                className="rounded-full transition-all"
                style={{
                  width: i === index ? "20px" : "6px",
                  height: "6px",
                  background: i === index ? "oklch(0.72 0.25 285)" : "var(--c-25)",
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ThumbnailCard({
  thumb,
  onPreview,
  onRegen,
  isRegenerating,
  canRegen,
}: {
  thumb: ThumbnailConcept;
  onPreview?: () => void;
  onRegen?: () => void;
  isRegenerating?: boolean;
  canRegen?: boolean;
}) {
  const [imgError, setImgError] = useState(false);
  // A card is "in progress" whenever either the DB status says
  // generating OR our per-thumbnail regen state is set (covers the
  // optimistic window before image_status flips in the DB).
  const isBusy = isRegenerating || thumb.imageStatus === "generating";

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>

      {/* Image area */}
      <div
        className="aspect-video w-full relative group"
        style={{ background: "var(--bg-card-subtle)", cursor: thumb.imageUrl && !imgError && !isBusy ? "zoom-in" : "default" }}
        onClick={() => !isBusy && thumb.imageUrl && !imgError && onPreview?.()}
      >
        {isBusy ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2"
            style={{ background: "oklch(0.06 0 0 / 0.6)" }}>
            <span className="w-5 h-5 rounded-full border-2 border-current border-t-transparent animate-spin"
              style={{ color: "oklch(0.72 0.25 285)" }} />
            <p className="text-xs font-medium" style={{ color: "oklch(0.88 0.12 285)" }}>
              {isRegenerating ? "Regenerating…" : "Generating…"}
            </p>
          </div>
        ) : thumb.imageUrl && !imgError ? (
          <img
            src={thumb.imageUrl}
            alt={thumb.title}
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            onError={() => setImgError(true)}
          />
        ) : thumb.imageStatus === "failed" ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xs" style={{ color: "oklch(0.55 0.15 25)" }}>Failed</p>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xs" style={{ color: "var(--c-30)" }}>No image yet</p>
          </div>
        )}

        {/* Position badge */}
        <div className="absolute top-2 left-2 w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold"
          style={{ background: "var(--bg-overlay)", color: "oklch(0.58 0.28 300)" }}>
          {thumb.position}
        </div>

        {/* Top-right action row: regen + download */}
        <div className="absolute top-2 right-2 flex items-center gap-1.5">
          {/* Regen button — shows whenever there's an existing image or
              a failed attempt to retry, and the page is in a state where
              a regen can start. Hidden during in-flight states. */}
          {!isBusy && canRegen && (thumb.imageUrl || thumb.imageStatus === "failed") && onRegen && (
            <button
              onClick={(e) => { e.stopPropagation(); onRegen(); }}
              aria-label={thumb.imageStatus === "failed" ? "Retry thumbnail" : "Regenerate thumbnail"}
              title={thumb.imageStatus === "failed" ? "Retry" : "Regenerate"}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-opacity hover:opacity-90"
              style={{ background: "var(--bg-overlay)", color: "oklch(0.88 0.12 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Download button */}
          {!isBusy && thumb.imageUrl && !imgError && (
            <DownloadButton
              url={thumb.imageUrl}
              filename={`thumbnail-${thumb.position}.png`}
            />
          )}
        </div>
      </div>

      {/* Text content */}
      <div className="p-4 space-y-3">
        <p className="font-semibold text-sm">{thumb.title}</p>
        <div className="space-y-2.5">
          {[
            { label: "Visual Concept", value: thumb.visualConcept },
            { label: "Text Overlay", value: thumb.textOverlay, highlight: true },
            { label: "Emotion Trigger", value: thumb.emotionTrigger },
          ].map(({ label, value, highlight }) => (
            <div key={label}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>{label}</p>
                <CopyButton text={value} />
              </div>
              <p className="text-xs leading-relaxed"
                style={{ color: highlight ? "var(--c-82)" : "oklch(0.58 0 0)" }}>
                {value}
              </p>
            </div>
          ))}
          <div>
            <div className="flex items-center gap-1.5 mb-0.5">
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Style Prompt</p>
              <CopyButton text={thumb.stylePrompt} />
            </div>
            <p className="text-xs leading-relaxed" style={{ color: "var(--c-42)" }}>{thumb.stylePrompt}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

async function streamStep(url: string, body: object, onUpdate: (s: StepState) => void): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === "status") onUpdate({ status: "running", message: event.message });
        else if (event.type === "error") throw new Error(event.message);
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
}

export default function ThumbnailsPage({ params }: PageProps) {
  const { projectId } = params;
  const { project, mutate } = useProject(projectId);
  const router = useRouter();

  const { data: imageModels } = useSWR<KieModel[]>("/api/kie/models?type=image", fetcher);

  // If the user came from Assemble (current_state >= 15), bump to 16 so the
  // WizardNav's Assemble phase satisfies `reached > Math.max(...states)` and
  // ticks done. Thumbnails has state 13 (it's a side-branch) so we can't
  // rely on its own state to mark prior phases complete. No-op if the user
  // visited Thumbnails before completing Assemble.
  useEffect(() => {
    const reached = project?.current_state as number | undefined;
    if (reached !== undefined && reached >= 15 && reached < 16) {
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_state: 16 }),
      }).then(() => mutate()).catch(() => { /* non-blocking */ });
    }
  }, [project?.current_state, projectId, mutate]);

  const [conceptStep, setConceptStep] = useState<StepState>(IDLE);
  const [imageStep, setImageStep] = useState<StepState>(IDLE);
  // The 5 niche-video thumbnails (cover art) that fed the thumbnail-
  // style analysis. Surfaced in the UI so the user can see which
  // references the model was inspired by. Populated on the first
  // generateConcepts() run and kept in local state for this session.
  const [nicheThumbs, setNicheThumbs] = useState<Array<{ videoId: string; title: string; thumbnailUrl: string }>>([]);
  // Reference-source mode for the thumbnail-style analysis.
  //   "auto"   → pull thumbnail covers of the top 5 niche videos
  //   "manual" → user-uploaded reference thumbnails (3–5 images)
  // Same toggle pattern as the visuals step's Auto / Manual.
  type ThumbRefMode = "auto" | "manual";
  const [refMode, setRefMode] = useState<ThumbRefMode>("auto");
  const [manualRefFiles, setManualRefFiles] = useState<File[]>([]);
  const [isDraggingRef, setIsDraggingRef] = useState(false);
  const manualRefInputRef = useRef<HTMLInputElement>(null);

  function handleManualRefFiles(incoming: FileList | File[] | null | undefined) {
    if (!incoming) return;
    const files = Array.from(incoming).filter((f) => f.type.startsWith("image/")).slice(0, 5);
    if (files.length === 0) {
      toast.error("Only image files are accepted");
      return;
    }
    setManualRefFiles(files);
    if (files.length < 3) {
      const need = 3 - files.length;
      toast.info(`Add ${need} more ${need === 1 ? "image" : "images"} — analysis needs at least 3 references`);
    }
  }
  // Per-thumbnail regen state. Decoupled from the bulk image-step state
  // (imageStep / imageProgress) so regenerating a single card doesn't
  // flip the whole step into "Running…". A Set supports parallel
  // regens; the regen confirm dialog gates each one.
  const [regeneratingPositions, setRegeneratingPositions] = useState<Set<number>>(new Set());
  const [regenConfirmPos, setRegenConfirmPos] = useState<number | null>(null);
  const [regenSubmitting, setRegenSubmitting] = useState(false);

  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedRatio, setSelectedRatio] = useState("16:9");
  const [selectedResolution, setSelectedResolution] = useState<string | null>(null);
  const [imageProgress, setImageProgress] = useState<{ done: number; total: number } | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const closePreview = useCallback(() => setPreviewIndex(null), []);
  const [navigating, setNavigating] = useState(false);

  const thumbnails: ThumbnailConcept[] = project?.thumbnails ?? [];
  const hasConcepts = thumbnails.length > 0;
  const hasImages = thumbnails.some((t) => t.imageUrl);
  const allImagesGenerated = hasConcepts && thumbnails.every((t) => !!t.imageUrl);
  const isConceptRunning = conceptStep.status === "running";
  const isImageRunning = imageStep.status === "running";

  const effectiveConcept: StepState =
    conceptStep.status !== "idle" ? conceptStep :
    hasConcepts ? { status: "done", message: "" } : IDLE;

  const activeModel = selectedModel ?? imageModels?.[0]?.id ?? null;
  const modelConfig = activeModel ? getModelConfig(activeModel) : null;

  async function generateConcepts() {
    if (!project?.script || !project?.visual_profile) {
      toast.error("Script and visual analysis required first");
      return;
    }
    setConceptStep({ status: "running", message: "Clearing previous references…" });
    try {
      // Every run starts from a clean slate so the analysis is
      // anchored to the references the user is uploading/fetching
      // right now. The server endpoint wipes:
      //   - thumbnail_analysis on the project row (DB cache)
      //   - the R2 thumbnail-refs/ prefix (prior manual uploads)
      //   - *-thumb.jpg keys under auto-frames/ (prior auto pulls)
      // We mirror the wipe in local state so the UI doesn't show
      // stale refs while the new ones are still uploading.
      const clearRes = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_thumbnail_refs: true }),
      });
      if (!clearRes.ok) {
        const e = await clearRes.json().catch(() => ({}));
        throw new Error(e.error ?? "Failed to clear previous references");
      }
      setNicheThumbs([]);
      mutate(
        { ...project, thumbnail_analysis: null },
        { revalidate: false },
      );

      // Thumbnail-style analysis. Two modes:
      //   "auto"   — pull the cover art of the top 5 niche videos.
      //   "manual" — upload the user's own reference thumbnails first,
      //              then analyze those.
      // Either way, the resulting thumbnailAnalysis flows into
      // buildThumbnailsPrompt on the server alongside the visuals-
      // step visualProfile. The cache was just nulled above, so this
      // always starts at null and runs a fresh analysis.
      let thumbnailAnalysis: Record<string, unknown> | null = null;
      let thumbnailImageUrls: string[] = [];

      if (refMode === "manual") {
        if (manualRefFiles.length < 3) {
          throw new Error("Upload at least 3 reference thumbnails to analyze");
        }
        setConceptStep({ status: "running", message: `Uploading ${manualRefFiles.length} reference thumbnails…` });
        thumbnailImageUrls = await Promise.all(
          manualRefFiles.map((f) => presignedUpload(f, projectId, "thumbnail-refs")),
        );
        // Stash uploaded URLs in the niche-refs UI panel so the
        // user keeps seeing which references fed the analysis. We
        // synthesize a videoId-shaped entry so the existing grid
        // renders without changes; clicking the title is a no-op
        // (the href becomes a yt watch URL with an empty id which
        // YouTube redirects sanely).
        setNicheThumbs(
          thumbnailImageUrls.map((url, i) => ({
            videoId: `manual-${i + 1}`,
            title: manualRefFiles[i].name,
            thumbnailUrl: url,
          })),
        );
      } else {
        const channelInfo = project.channel_info as { topVideos?: { videoId: string; title: string }[] } | undefined;
        const niche5 = (channelInfo?.topVideos ?? []).slice(0, 5);
        if (niche5.length > 0) {
          setConceptStep({ status: "running", message: "Pulling top 5 niche thumbnails…" });
          const shotsRes = await fetch("/api/youtube/screenshots", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videos: niche5, projectId, kinds: ["thumbnails"] }),
          });
          const shotsData = await shotsRes.json();
          if (!shotsRes.ok) throw new Error(shotsData.error ?? "Failed to fetch niche thumbnails");
          const screenshots = (shotsData.screenshots ?? []) as Array<{ videoId: string; title: string; thumbnailUrl?: string }>;
          const refs = screenshots
            .filter((s) => !!s.thumbnailUrl)
            .map((s) => ({ videoId: s.videoId, title: s.title, thumbnailUrl: s.thumbnailUrl as string }));
          setNicheThumbs(refs);
          thumbnailImageUrls = refs.map((r) => r.thumbnailUrl);
        }
      }

      if (!thumbnailAnalysis && thumbnailImageUrls.length > 0) {
        setConceptStep({ status: "running", message: `Analyzing ${thumbnailImageUrls.length} reference thumbnails…` });
        const analysisRes = await fetch("/api/workflow/visual-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, thumbnailImageUrls }),
        });
        const analysisData = await analysisRes.json();
        if (analysisRes.ok && analysisData.thumbnailAnalysis) {
          thumbnailAnalysis = analysisData.thumbnailAnalysis;
        }
      }

      const visualProfile = project.visual_profile as Record<string, unknown> | null;
      if (!visualProfile) throw new Error("Visual profile missing — run the Visuals step first");

      setConceptStep({ status: "running", message: "Generating concepts…" });
      await streamStep("/api/workflow/prompts", {
        step: "thumbnails",
        projectId,
        script: project.script,
        // Prefer the freshly-resolved visualProfile (which includes
        // the 5-niche-video frames analysis above) over the original
        // visuals-step value. Falls back when no fresh analysis ran.
        visualProfile,
        thumbnailAnalysis,
      }, setConceptStep);
      await mutate();
      setConceptStep({ status: "done", message: "" });
      toast.success("Thumbnail concepts generated");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      setConceptStep({ status: "error", message: "", error: msg });
      toast.error(msg);
    }
  }

  async function generateImages() {
    if (!hasConcepts) { toast.error("Generate concepts first"); return; }
    if (!activeModel) { toast.error("Select an image model"); return; }

    const toGenerate = thumbnails
      .filter((t) => t.stylePrompt)
      .map((t) => ({ position: t.position, stylePrompt: t.stylePrompt }));

    setImageStep({ status: "running", message: "Generating images…" });
    setImageProgress({ done: 0, total: toGenerate.length });

    if (hasImages && project) {
      mutate(
        { ...project, thumbnails: thumbnails.map((t) => ({ ...t, imageUrl: undefined, imageStatus: undefined })) },
        { revalidate: false }
      );
    }

    try {
      const res = await fetch("/api/generate/thumbnail-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          thumbnails: toGenerate,
          modelId: activeModel,
          aspectRatio: selectedRatio,
          resolution: selectedResolution ?? undefined,
          clearFirst: hasImages,
        }),
      });

      const data = await res.json() as { success: number; total: number; failures: { position: number; error: string }[] };
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Image generation failed");

      await mutate();
      setImageProgress({ done: data.success, total: data.total });

      const allFailed = data.failures?.length === data.total && data.total > 0;
      const firstError = data.failures?.[0]?.error;

      if (allFailed) {
        const msg = firstError ?? "Image generation failed";
        setImageStep({ status: "error", message: "", error: msg });
        toast.error(msg);
      } else if (data.failures?.length) {
        setImageStep({ status: "done", message: "" });
        toast.error(`${data.failures.length} of ${data.total} image(s) failed${firstError ? `: ${firstError}` : ""}`);
      } else {
        setImageStep({ status: "done", message: "" });
        toast.success(`${data.success} thumbnail images generated`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      setImageStep({ status: "error", message: "", error: msg });
      toast.error(msg);
    }
  }

  // Regenerate a single thumbnail. Hits the same /api/generate/thumbnail-images
  // route as the bulk path but with a single-element thumbnails array
  // and clearFirst=false so it only touches this position. The route
  // flips image_status to "generating" then "done"/"failed", which the
  // existing ThumbnailCard already renders via the project's SWR poll.
  async function regenOne(position: number) {
    if (!activeModel) { toast.error("Select an image model"); return; }
    const concept = thumbnails.find((t) => t.position === position);
    if (!concept || !concept.stylePrompt) { toast.error("No prompt found for this thumbnail"); return; }

    setRegeneratingPositions((prev) => new Set(prev).add(position));
    // Optimistic update so the spinner shows immediately instead of
    // waiting for the route to flip image_status in the DB + the next
    // SWR poll to surface it.
    if (project) {
      mutate(
        {
          ...project,
          thumbnails: thumbnails.map((t) => t.position === position
            ? { ...t, imageUrl: undefined, imageStatus: "generating" }
            : t),
        },
        { revalidate: false }
      );
    }

    try {
      const res = await fetch("/api/generate/thumbnail-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          thumbnails: [{ position, stylePrompt: concept.stylePrompt }],
          modelId: activeModel,
          aspectRatio: selectedRatio,
          resolution: selectedResolution ?? undefined,
          clearFirst: false,
        }),
      });
      const data = await res.json() as { failures?: { position: number; error: string }[] };
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Regeneration failed");
      const firstError = data.failures?.[0]?.error;
      if (firstError) {
        toast.error(`Thumbnail ${position} failed: ${firstError}`);
      } else {
        toast.success(`Thumbnail ${position} regenerated`);
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Regeneration failed");
      await mutate();
    } finally {
      setRegeneratingPositions((prev) => {
        const next = new Set(prev);
        next.delete(position);
        return next;
      });
    }
  }

  function requestRegenOne(position: number) {
    if (anyRunning) { toast.error("Wait for the current run to finish"); return; }
    if (regeneratingPositions.has(position)) return;
    if (!activeModel) { toast.error("Select an image model"); return; }
    setRegenConfirmPos(position);
  }

  async function confirmRegenOne() {
    if (regenConfirmPos === null) return;
    setRegenSubmitting(true);
    const pos = regenConfirmPos;
    setRegenConfirmPos(null);
    try {
      await regenOne(pos);
    } finally {
      setRegenSubmitting(false);
    }
  }

  function StepBadge({ status, num }: { status: StepStatus; num: number }) {
    return (
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold mt-0.5"
        style={
          status === "done" ? { background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.7 0.15 145)" } :
          status === "running" ? { background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" } :
          status === "error" ? { background: "oklch(0.6 0.22 25 / 0.12)", color: "oklch(0.7 0.2 25)" } :
          { background: "var(--bg-progress)", color: "var(--c-30)" }
        }>
        {status === "done" ? "✓" : status === "error" ? "✕" : status === "running"
          ? <span className="block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
          : num}
      </div>
    );
  }

  const anyRunning = isConceptRunning || isImageRunning;

  const thumbsWithImages = thumbnails.filter((t) => t.imageUrl);

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      {previewIndex !== null && (
        <PreviewModal
          thumbs={thumbsWithImages}
          index={previewIndex}
          onClose={closePreview}
          onNav={setPreviewIndex}
        />
      )}
      <WizardNav projectId={projectId} currentState={13} highestState={project?.current_state} channelName={project?.channel_name} progressComplete={allImagesGenerated} />

      <main className="flex-1 flex flex-col overflow-hidden pt-[105px] md:pt-0">
        {/* Header */}
        <div className="sm:px-8 py-3 sm:py-4 shrink-0"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <h1 className="font-bold text-lg">Thumbnails</h1>
          {hasConcepts && (
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              {thumbnails.length} concepts · {thumbnails.filter((t) => t.imageUrl).length} images generated
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="sm:px-8 pt-4 sm:pt-6 pb-24 space-y-4 max-w-5xl mx-auto">

            {/* Reference source — pick between auto (niche videos)
                and manual (upload your own thumbnails). Same toggle
                pattern as the visuals step. */}
            <div className="rounded-xl p-4"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
                    Reference thumbnails
                  </p>
                  <p className="text-[11px] mt-0.5" style={{ color: "var(--c-40)" }}>
                    {refMode === "auto"
                      ? "Pulls cover art from the top 5 niche videos"
                      : "Upload your own thumbnails to inspire concept creation"}
                  </p>
                </div>
                <div className="flex gap-1 p-1 rounded-lg"
                  style={{ background: "var(--bg-elevated)", border: "1px solid var(--bd-7)" }}>
                  {(["auto", "manual"] as ThumbRefMode[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => setRefMode(m)}
                      disabled={anyRunning}
                      className="px-3 py-1.5 rounded-md text-xs font-medium transition-all disabled:opacity-40"
                      style={refMode === m
                        ? { background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }
                        : { color: "var(--c-50)" }}
                    >
                      {m === "auto" ? "⚡ Auto" : "↑ Manual"}
                    </button>
                  ))}
                </div>
              </div>

              {refMode === "manual" && (
                <div className="space-y-3">
                  <div
                    onClick={() => manualRefInputRef.current?.click()}
                    onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setIsDraggingRef(true); }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!isDraggingRef) setIsDraggingRef(true);
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                      setIsDraggingRef(false);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setIsDraggingRef(false);
                      handleManualRefFiles(e.dataTransfer?.files);
                    }}
                    className="rounded-xl p-6 text-center cursor-pointer transition-all"
                    style={{
                      border: `1.5px dashed ${isDraggingRef ? "oklch(0.72 0.25 285)" : "var(--bd-10)"}`,
                      background: isDraggingRef ? "oklch(0.72 0.25 285 / 0.06)" : "oklch(0.09 0 0)",
                    }}
                  >
                    <p className="text-sm" style={{ color: "var(--c-50)" }}>
                      {isDraggingRef
                        ? <span style={{ color: "oklch(0.72 0.25 285)" }}>Release to upload</span>
                        : <>Drop thumbnails here or <span style={{ color: "oklch(0.72 0.25 285)" }}>click to upload</span></>}
                    </p>
                    <p className="text-xs mt-1" style={{ color: "var(--c-35)" }}>PNG, JPG, WEBP · 3 to 5 images</p>
                  </div>
                  <input ref={manualRefInputRef} type="file" accept="image/*" multiple className="hidden"
                    onChange={(e) => handleManualRefFiles(e.target.files)} />
                  {manualRefFiles.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                      {manualRefFiles.map((f, i) => (
                        <div key={i} className="relative aspect-video rounded-lg overflow-hidden"
                          style={{ border: "1px solid var(--bd-10)" }}>
                          <img src={URL.createObjectURL(f)} alt="" className="w-full h-full object-cover" />
                          <button
                            onClick={() => setManualRefFiles((p) => p.filter((_, j) => j !== i))}
                            className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-xs"
                            style={{ background: "oklch(0.05 0 0 / 0.7)", color: "white" }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {manualRefFiles.length > 0 && manualRefFiles.length < 3 && (
                    <div
                      className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
                      style={{ background: "oklch(0.72 0.55 75 / 0.08)", border: "1px solid oklch(0.72 0.55 75 / 0.25)", color: "oklch(0.78 0.18 75)" }}
                    >
                      <span aria-hidden="true">!</span>
                      <span>Add {3 - manualRefFiles.length} more {3 - manualRefFiles.length === 1 ? "image" : "images"} — analysis needs at least 3.</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Niche references — populated after generateConcepts()
                pulls or uploads references for analysis. Renders the
                actual images that fed buildThumbnailsPrompt. */}
            {nicheThumbs.length > 0 && (
              <div className="rounded-xl p-4"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
                    Niche references
                  </p>
                  <span className="text-[11px]" style={{ color: "var(--c-40)" }}>
                    Top {nicheThumbs.length} niche thumbnails analyzed
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {nicheThumbs.map((t) => (
                    <a
                      key={t.videoId}
                      href={`https://www.youtube.com/watch?v=${t.videoId}`}
                      target="_blank"
                      rel="noreferrer"
                      title={t.title}
                      className="relative aspect-video rounded-lg overflow-hidden transition-transform hover:scale-[1.02]"
                      style={{ border: "1px solid var(--bd-7)" }}
                    >
                      <img src={t.thumbnailUrl} alt={t.title}
                        className="w-full h-full object-cover" />
                      <div className="absolute inset-x-0 bottom-0 px-2 py-1 text-[10px] truncate"
                        style={{ background: "oklch(0.05 0 0 / 0.7)", color: "var(--c-70)" }}>
                        {t.title}
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Step 1 — Concepts */}
            <div className="rounded-xl p-4 flex gap-4"
              style={{
                background: isConceptRunning ? "oklch(0.72 0.25 285 / 0.03)" : "var(--bg-panel)",
                border: `1px solid ${effectiveConcept.status === "done" ? "oklch(0.55 0.15 145 / 0.25)" : isConceptRunning ? "oklch(0.72 0.25 285 / 0.25)" : effectiveConcept.status === "error" ? "oklch(0.6 0.22 25 / 0.3)" : "var(--bd-7)"}`,
                transition: "border-color 0.2s",
              }}>
              <StepBadge status={effectiveConcept.status} num={1} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold mb-0.5" style={{ color: "var(--c-85)" }}>Generate Concepts</p>
                <p className="text-xs mb-2" style={{ color: "var(--c-40)" }}>
                  5 thumbnail concepts with text overlays, visual style, and image generation prompts
                </p>
                {isConceptRunning && <p className="text-xs" style={{ color: "oklch(0.65 0.15 75)" }}>{conceptStep.message}</p>}
                {effectiveConcept.status === "done" && hasConcepts && <p className="text-xs" style={{ color: "oklch(0.6 0.15 145)" }}>{thumbnails.length} concepts ready</p>}
                {effectiveConcept.status === "error" && <p className="text-xs" style={{ color: "oklch(0.65 0.15 25)" }}>{conceptStep.error}</p>}
              </div>
              <div className="shrink-0 flex items-start">
                <button onClick={generateConcepts} disabled={anyRunning}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-30 transition-opacity"
                  style={effectiveConcept.status === "done" || effectiveConcept.status === "error"
                    ? { background: "var(--bg-progress)", color: "var(--c-50)", border: "1px solid var(--bd-8)" }
                    : { background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                  {isConceptRunning ? "Running…" : effectiveConcept.status === "done" ? "Regenerate" : effectiveConcept.status === "error" ? "Retry" : "Generate"}
                </button>
              </div>
            </div>

            {/* Step 2 — Images */}
            <div className="rounded-xl overflow-hidden"
              style={{
                background: "var(--bg-panel)",
                border: `1px solid ${imageStep.status === "done" || hasImages ? "oklch(0.55 0.15 145 / 0.25)" : isImageRunning ? "oklch(0.72 0.25 285 / 0.25)" : imageStep.status === "error" ? "oklch(0.6 0.22 25 / 0.3)" : "var(--bd-7)"}`,
                opacity: hasConcepts ? 1 : 0.4,
                transition: "border-color 0.2s, opacity 0.2s",
              }}>

              <div className="p-4 flex gap-4">
                <StepBadge status={hasImages && imageStep.status === "idle" ? "done" : imageStep.status} num={2} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold mb-0.5" style={{ color: "var(--c-85)" }}>Generate Images</p>
                  <p className="text-xs mb-2" style={{ color: "var(--c-40)" }}>
                    Generate an AI image for each concept using the style prompt
                  </p>
                  {isImageRunning && imageProgress && (
                    <div className="space-y-1.5">
                      <p className="text-xs" style={{ color: "oklch(0.65 0.15 75)" }}>{imageStep.message}</p>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
                          <div className="h-full rounded-full transition-all"
                            style={{ width: `${Math.min(99, Math.round((imageProgress.done / imageProgress.total) * 100))}%`, background: "oklch(0.72 0.25 285)" }} />
                        </div>
                        <span className="text-xs shrink-0" style={{ color: "var(--c-40)" }}>
                          {imageProgress.done}/{imageProgress.total}
                        </span>
                      </div>
                    </div>
                  )}
                  {(imageStep.status === "done" || hasImages) && imageStep.status === "idle" && (
                    <p className="text-xs" style={{ color: "oklch(0.6 0.15 145)" }}>
                      {thumbnails.filter((t) => t.imageUrl).length} images generated
                    </p>
                  )}
                  {imageStep.status === "error" && <p className="text-xs" style={{ color: "oklch(0.65 0.15 25)" }}>{imageStep.error}</p>}
                </div>
                <div className="shrink-0 flex items-start">
                  <button onClick={generateImages} disabled={!hasConcepts || anyRunning}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-30 transition-opacity"
                    style={hasImages && imageStep.status === "idle" || imageStep.status === "error"
                      ? { background: "var(--bg-progress)", color: "var(--c-50)", border: "1px solid var(--bd-8)" }
                      : { background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                    {isImageRunning ? "Running…" : hasImages && imageStep.status === "idle" ? "Regenerate" : imageStep.status === "error" ? "Retry" : "Generate"}
                  </button>
                </div>
              </div>

              {/* Model + ratio selector */}
              {hasConcepts && !isImageRunning && (
                <div className="px-4 pb-4 space-y-3" style={{ borderTop: "1px solid var(--bd-6)" }}>
                  <p className="text-xs font-semibold uppercase tracking-wider pt-3" style={{ color: "var(--c-40)" }}>Image Model</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                    {(imageModels ?? []).map((m) => (
                      <button key={m.id} onClick={() => { setSelectedModel(m.id); setSelectedResolution(null); }}
                        className="text-left px-3 py-2 rounded-lg text-xs transition-all"
                        style={activeModel === m.id ? {
                          background: "oklch(0.72 0.25 285 / 0.1)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                          color: "var(--c-88)",
                        } : {
                          background: "var(--bg-input)",
                          border: "1px solid var(--bd-7)",
                          color: "var(--c-55)",
                        }}>
                        <p className="font-medium truncate">{m.name}</p>
                        {m.tags?.slice(0, 2).map((tag) => (
                          <span key={tag} className="inline-block mt-1 px-1.5 py-0.5 rounded text-xs mr-1"
                            style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>{tag}</span>
                        ))}
                      </button>
                    ))}
                  </div>

                  {modelConfig && (
                    <div className="flex flex-wrap gap-3">
                      <div>
                        <p className="text-xs mb-1.5" style={{ color: "var(--c-40)" }}>Aspect Ratio</p>
                        <div className="flex gap-1.5 flex-wrap">
                          {modelConfig.aspectRatios.map((r) => (
                            <button key={r} onClick={() => setSelectedRatio(r)}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
                              style={selectedRatio === r ? {
                                background: "oklch(0.72 0.25 285 / 0.15)",
                                color: "oklch(0.72 0.25 285)",
                                border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                              } : {
                                background: "var(--bg-control)",
                                color: "var(--c-50)",
                                border: "1px solid var(--bd-8)",
                              }}>
                              {r}
                            </button>
                          ))}
                        </div>
                      </div>
                      {modelConfig.resolutions && modelConfig.resolutions.length > 0 && (
                        <div>
                          <p className="text-xs mb-1.5" style={{ color: "var(--c-40)" }}>Resolution</p>
                          <div className="flex gap-1.5">
                            {modelConfig.resolutions.map((res) => (
                              <button key={res} onClick={() => setSelectedResolution(res === selectedResolution ? null : res)}
                                className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
                                style={selectedResolution === res ? {
                                  background: "oklch(0.72 0.25 285 / 0.15)",
                                  color: "oklch(0.72 0.25 285)",
                                  border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                                } : {
                                  background: "var(--bg-control)",
                                  color: "var(--c-50)",
                                  border: "1px solid var(--bd-8)",
                                }}>
                                {res}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Thumbnail grid */}
            {hasConcepts && (
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 pt-2">
                {thumbnails.map((t) => {
                  const previewIdx = thumbsWithImages.findIndex((tw) => tw.position === t.position);
                  return (
                    <ThumbnailCard
                      key={t.position}
                      thumb={t}
                      onPreview={previewIdx >= 0 ? () => setPreviewIndex(previewIdx) : undefined}
                      onRegen={() => requestRegenOne(t.position)}
                      isRegenerating={regeneratingPositions.has(t.position)}
                      canRegen={!anyRunning && !!activeModel}
                    />
                  );
                })}
              </div>
            )}

            {/* Empty state */}
            {!hasConcepts && conceptStep.status === "idle" && (
              <div className="flex items-center justify-center py-20">
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 rounded-xl mx-auto flex items-center justify-center text-xl"
                    style={{ background: "var(--bg-control)", border: "1px solid var(--bd-8)" }}>
                    ⬟
                  </div>
                  <p className="text-sm font-semibold">No thumbnails yet</p>
                  <p className="text-xs" style={{ color: "var(--c-40)" }}>
                    Click Generate in Step 1 to create 5 thumbnail concepts, then generate images in Step 2.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Fixed Done bar — only when every thumbnail concept has rendered */}
      {allImagesGenerated && (
        <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
          <div className="sm:px-8 max-w-5xl mx-auto">
            <button
              onClick={() => { setNavigating(true); router.push(`/projects/${projectId}/next`); }}
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

      <Dialog open={regenConfirmPos !== null} onOpenChange={(open) => { if (!regenSubmitting && !open) setRegenConfirmPos(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Regenerate thumbnail {regenConfirmPos}?</DialogTitle>
            <DialogDescription>
              This will overwrite the existing image for thumbnail{" "}
              <span className="font-semibold" style={{ color: "var(--c-80)" }}>#{regenConfirmPos}</span>
              {" "}with a fresh render from the same prompt and model.
              KIE credits will be charged for the new image.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setRegenConfirmPos(null)}
              disabled={regenSubmitting}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{ background: "transparent", border: "1px solid var(--bd-7)", color: "var(--c-60)" }}
            >
              Cancel
            </button>
            <button
              onClick={confirmRegenOne}
              disabled={regenSubmitting}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-60"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              {regenSubmitting ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Starting…
                </span>
              ) : `Regenerate thumbnail ${regenConfirmPos}`}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
