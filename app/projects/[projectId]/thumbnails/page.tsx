"use client";

import { useState, use, useEffect, useCallback } from "react";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import useSWR from "swr";
import type { ThumbnailConcept, KieModel } from "@/lib/types";
import { getModelConfig } from "@/lib/kie/imageModels";

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
        <div className="relative rounded-xl overflow-hidden" style={{ background: "var(--bg-glass-subtle)" }}>
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

function ThumbnailCard({ thumb, onPreview }: { thumb: ThumbnailConcept; onPreview?: () => void }) {
  const [imgError, setImgError] = useState(false);

  return (
    <div className="rounded-xl overflow-hidden"
      style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>

      {/* Image area */}
      <div
        className="aspect-video w-full relative group"
        style={{ background: "var(--bg-glass-subtle)", cursor: thumb.imageUrl && !imgError ? "zoom-in" : "default" }}
        onClick={() => thumb.imageUrl && !imgError && onPreview?.()}
      >
        {thumb.imageUrl && !imgError ? (
          <img
            src={thumb.imageUrl}
            alt={thumb.title}
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            onError={() => setImgError(true)}
          />
        ) : thumb.imageStatus === "generating" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <span className="w-5 h-5 rounded-full border-2 border-current border-t-transparent animate-spin"
              style={{ color: "oklch(0.72 0.25 285)" }} />
            <p className="text-xs" style={{ color: "var(--c-45)" }}>Generating…</p>
          </div>
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

        {/* Download button */}
        {thumb.imageUrl && !imgError && (
          <div className="absolute top-2 right-2">
            <DownloadButton
              url={thumb.imageUrl}
              filename={`thumbnail-${thumb.position}.png`}
            />
          </div>
        )}
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

  const { data: imageModels } = useSWR<KieModel[]>("/api/kie/models?type=image", fetcher);

  const [conceptStep, setConceptStep] = useState<StepState>(IDLE);
  const [imageStep, setImageStep] = useState<StepState>(IDLE);

  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedRatio, setSelectedRatio] = useState("16:9");
  const [selectedResolution, setSelectedResolution] = useState<string | null>(null);
  const [imageProgress, setImageProgress] = useState<{ done: number; total: number } | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const closePreview = useCallback(() => setPreviewIndex(null), []);

  const thumbnails: ThumbnailConcept[] = project?.thumbnails ?? [];
  const hasConcepts = thumbnails.length > 0;
  const hasImages = thumbnails.some((t) => t.imageUrl);
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
    setConceptStep({ status: "running", message: "Starting..." });
    try {
      await streamStep("/api/workflow/prompts", {
        step: "thumbnails",
        projectId,
        script: project.script,
        visualProfile: project.visual_profile,
        thumbnailAnalysis: project.thumbnail_analysis,
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
      <WizardNav projectId={projectId} currentState={13} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-4 shrink-0"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div>
            <h1 className="font-bold text-lg">Thumbnails</h1>
            {hasConcepts && (
              <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                {thumbnails.length} concepts · {thumbnails.filter((t) => t.imageUrl).length} images generated
              </p>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-8 py-6 space-y-4 max-w-5xl mx-auto">

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
                            style={{ width: `${Math.round((imageProgress.done / imageProgress.total) * 100)}%`, background: "oklch(0.72 0.25 285)" }} />
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
                  <div className="grid grid-cols-3 gap-2 max-h-48 overflow-y-auto">
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
    </div>
  );
}
