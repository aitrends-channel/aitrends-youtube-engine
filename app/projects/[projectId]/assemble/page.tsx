"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import type { Beat } from "@/lib/types";
import { trimToLength, encodeMp3 } from "@/lib/audio/silenceRemover";

interface PageProps {
  params: { projectId: string };
}

const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
type AspectRatio = typeof ASPECT_RATIOS[number];

const RESOLUTION: Record<AspectRatio, string> = {
  "16:9": "1920 × 1080",
  "9:16": "1080 × 1920",
  "1:1":  "1080 × 1080",
};

const CAPTION_LANGUAGES = [
  { code: "source", label: "Source language" },
  { code: "Spanish", label: "Spanish" },
  { code: "French", label: "French" },
  { code: "Portuguese", label: "Portuguese" },
  { code: "German", label: "German" },
  { code: "Italian", label: "Italian" },
  { code: "Japanese", label: "Japanese" },
  { code: "Korean", label: "Korean" },
  { code: "Chinese", label: "Chinese" },
  { code: "Hindi", label: "Hindi" },
  { code: "Arabic", label: "Arabic" },
] as const;

const CAPTION_STYLES = [
  { id: "classic", label: "Classic", hint: "White, black outline" },
  { id: "bold",    label: "Bold",    hint: "Yellow, bold" },
  { id: "boxed",   label: "Boxed",   hint: "White on dark box" },
  { id: "minimal", label: "Minimal", hint: "White, thin outline" },
] as const;

const CAPTION_SIZES     = [{ id: "small", label: "S" }, { id: "medium", label: "M" }, { id: "large", label: "L" }] as const;
const CAPTION_POSITIONS = [{ id: "bottom", label: "Bottom" }, { id: "top", label: "Top" }] as const;

export default function AssemblePage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project, mutate } = useProject(projectId);

  const beats: Beat[] = project?.beats ?? [];
  const ttsUrl: string | null = project?.tts_url ?? null;
  const ttsCleanedUrl: string | null = project?.tts_cleaned_url ?? null;
  const generatedVideos = beats.filter((b) => b.videoUrl).length;
  const videoBeats = beats.filter((b) => b.videoPrompt).length;

  // Bump current_state to 15 the first time the user lands here so the
  // Generate step ticks done in the WizardNav. No-op on subsequent visits.
  useEffect(() => {
    const reached = project?.current_state as number | undefined;
    if (reached !== undefined && reached < 15) {
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_state: 15 }),
      }).then(() => mutate()).catch(() => { /* non-blocking */ });
    }
  }, [project?.current_state, projectId, mutate]);

  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [voiceoverType, setVoiceoverType] = useState<"cleaned" | "original">("cleaned");
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captionsLanguage, setCaptionsLanguage] = useState("source");
  const [captionsStyle, setCaptionsStyle] = useState("classic");
  const [captionsSize, setCaptionsSize] = useState("medium");
  const [captionsPosition, setCaptionsPosition] = useState("bottom");
  const [assembling, setAssembling] = useState(false);
  const [assembleStatus, setAssembleStatus] = useState("");
  const [assembledUrl, setAssembledUrl] = useState<string | null>(null);

  const assembledVideoRef = useRef<HTMLVideoElement>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [trimmingAudio, setTrimmingAudio] = useState(false);
  const [trimAudioStatus, setTrimAudioStatus] = useState("");


  useEffect(() => {
    const status = project?.assembly_status as string | undefined;
    const url = project?.assembled_url as string | undefined;
    if (!assembling && url && !assembledUrl && (status === "done" || status === "preview")) {
      setAssembledUrl(url);
    }
  }, [project, assembling, assembledUrl]);

  useEffect(() => {
    const status = project?.assembly_status as string | undefined;
    if (!status) return;
    if (status === "queued") {
      setAssembling(true);
      setAssembleStatus("Queued…");
    } else if (status === "processing" || status === "uploading") {
      setAssembling(true);
      setAssembleStatus((project?.assembly_progress as string | undefined) ?? "Assembling…");
    } else if (status === "preview" || status === "done") {
      const url = project?.assembled_url as string | undefined;
      setAssembling(false);
      setAssembleStatus("");
      if (url) setAssembledUrl(url);
    } else if (status === "failed") {
      if (assembling) toast.error((project?.assembly_error as string | undefined) ?? "Assembly failed");
      setAssembling(false);
      setAssembleStatus("");
      setAssembledUrl((prev) => (prev?.includes("/api/preview/") ? null : prev));
    }
  }, [project?.assembly_status, project?.assembly_progress]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (project && !project.tts_cleaned_url) setVoiceoverType("original");
  }, [project?.tts_cleaned_url]);

  async function trimVoiceoverToVideo() {
    const videoEl = assembledVideoRef.current;
    const duration = videoDuration ?? (videoEl?.duration && isFinite(videoEl.duration) ? videoEl.duration : null);
    if (!duration || !ttsUrl) return;
    setTrimmingAudio(true);
    setTrimAudioStatus("Fetching voiceover…");
    try {
      const res = await fetch(ttsUrl);
      if (!res.ok) throw new Error("Failed to fetch voiceover audio");
      const audioBytes = await res.arrayBuffer();

      setTrimAudioStatus("Decoding audio…");
      const ctx = new AudioContext();
      const audioBuffer = await ctx.decodeAudioData(audioBytes);
      ctx.close();

      if (audioBuffer.duration <= duration) {
        toast.success("Voiceover is already shorter than the video — no trim needed");
        return;
      }

      setTrimAudioStatus("Trimming…");
      const { channels, sampleRate, newDuration } = trimToLength(audioBuffer, duration);

      setTrimAudioStatus("Encoding MP3…");
      const mp3Bytes = encodeMp3(channels, sampleRate);

      setTrimAudioStatus("Uploading…");
      const uploadRes = await fetch(`/api/generate/tts/clean?projectId=${projectId}`, {
        method: "POST",
        body: mp3Bytes,
        headers: { "Content-Type": "audio/mpeg" },
      });
      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Upload failed");
      }
      await mutate();
      setVoiceoverType("cleaned");
      toast.success(`Voiceover trimmed to ${Math.round(newDuration)}s`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Trim failed");
    } finally {
      setTrimmingAudio(false);
      setTrimAudioStatus("");
    }
  }

  async function assembleVideo() {
    if (assembling) return;
    setAssembling(true);
    setAssembledUrl(null);
    setAssembleStatus("Queuing…");
    try {
      const res = await fetch("/api/generate/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, aspectRatio, voiceoverType, captionsEnabled, captionsLanguage, captionsStyle, captionsSize, captionsPosition }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to queue assembly");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Assembly failed");
      setAssembling(false);
      setAssembleStatus("");
    }
  }

  async function retryUpload() {
    if (assembling) return;
    setAssembling(true);
    setAssembleStatus("Uploading…");
    try {
      const res = await fetch("/api/generate/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to start upload");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
      setAssembling(false);
      setAssembleStatus("");
    }
  }

  const hasVoiceover = voiceoverType === "original" ? !!ttsUrl : !!(ttsCleanedUrl || ttsUrl);
  const uploadFailedPreview = project?.assembly_status === "preview" && !project?.assembled_url;

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={15} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 overflow-y-auto pt-[105px] md:pt-0">
        {/* Header */}
        <div className="px-4 sm:px-8 py-4 sm:py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <h1 className="font-bold text-base sm:text-lg">Assemble Final Video</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
            Transcribes your voiceover to align each clip to the exact narration timing
          </p>
        </div>

        <div className="p-4 sm:p-8 pb-24">
          <div className="w-full max-w-2xl mx-auto space-y-6">

            {/* Status cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
              <div className="p-4 rounded-2xl" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Voiceover</p>
                <p className="mt-2 text-sm font-medium"
                  style={{ color: !ttsUrl && !ttsCleanedUrl ? "var(--c-45)" : voiceoverType === "cleaned" && ttsCleanedUrl ? "oklch(0.7 0.15 145)" : "oklch(0.72 0.25 285)" }}>
                  {!ttsUrl && !ttsCleanedUrl ? "Missing" : voiceoverType === "cleaned" && ttsCleanedUrl ? "Trimmed ✓" : "Original"}
                </p>
                {!ttsCleanedUrl && ttsUrl && (
                  <p className="text-xs mt-1" style={{ color: "var(--c-40)" }}>Trim on Generate page</p>
                )}
              </div>
              <div className="p-4 rounded-2xl" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Video Clips</p>
                <p className="mt-2 text-sm font-medium"
                  style={{ color: generatedVideos > 0 ? "oklch(0.72 0.25 285)" : "var(--c-45)" }}>
                  {generatedVideos} / {videoBeats}
                </p>
                {generatedVideos < videoBeats && (
                  <p className="text-xs mt-1" style={{ color: "var(--c-40)" }}>
                    {videoBeats - generatedVideos} will use still images
                  </p>
                )}
              </div>
              <div className="p-4 rounded-2xl" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Output</p>
                <p className="mt-2 text-sm font-medium" style={{ color: "var(--c-65)" }}>{RESOLUTION[aspectRatio]}</p>
              </div>
            </div>

            {/* Aspect ratio */}
            <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--c-40)" }}>Output Aspect Ratio</p>
              <div className="flex gap-2">
                {ASPECT_RATIOS.map((r) => (
                  <button key={r} onClick={() => setAspectRatio(r)} disabled={assembling}
                    className="px-4 py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                    style={aspectRatio === r ? {
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
            </div>

            {/* Voiceover source */}
            <div className="rounded-2xl p-5 space-y-4" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--c-40)" }}>Voiceover Source</p>
                <div className="flex gap-2">
                  <button onClick={() => setVoiceoverType("cleaned")} disabled={assembling || !ttsCleanedUrl}
                    className="flex-1 py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-35"
                    style={voiceoverType === "cleaned" && ttsCleanedUrl ? {
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                      color: "oklch(0.88 0.12 285)",
                    } : {
                      background: "var(--bg-input)",
                      border: "1px solid var(--bd-7)",
                      color: ttsCleanedUrl ? "var(--c-50)" : "var(--c-30)",
                    }}>
                    Trimmed{ttsCleanedUrl ? " ✓" : " — unavailable"}
                  </button>
                  <button onClick={() => setVoiceoverType("original")} disabled={assembling || !ttsUrl}
                    className="flex-1 py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-35"
                    style={voiceoverType === "original" ? {
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                      color: "oklch(0.88 0.12 285)",
                    } : {
                      background: "var(--bg-input)",
                      border: "1px solid var(--bd-7)",
                      color: ttsUrl ? "var(--c-50)" : "var(--c-30)",
                    }}>
                    Original{ttsUrl ? "" : " — unavailable"}
                  </button>
                </div>
              </div>

              {assembledUrl && ttsUrl && (
                <div className="pt-1 border-t" style={{ borderColor: "var(--bd-6)" }}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium" style={{ color: "var(--c-65)" }}>Trim to video length</p>
                      <p className="text-xs mt-0.5" style={{ color: "var(--c-40)" }}>
                        {videoDuration
                          ? `Hard-cut voiceover at ${Math.round(videoDuration)}s to match the assembled video`
                          : "Load the video above to detect its duration"}
                      </p>
                      {trimmingAudio && trimAudioStatus && (
                        <p className="text-xs mt-1" style={{ color: "oklch(0.72 0.25 285)" }}>{trimAudioStatus}</p>
                      )}
                    </div>
                    <button
                      onClick={trimVoiceoverToVideo}
                      disabled={trimmingAudio || assembling || !videoDuration}
                      className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all"
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                    >
                      {trimmingAudio ? (
                        <span className="flex items-center gap-1.5">
                          <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Trimming…
                        </span>
                      ) : "Trim"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Captions */}
            <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-sm font-semibold">Captions</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>Burned into the video — always visible</p>
                </div>
                <button onClick={() => setCaptionsEnabled((v) => !v)} disabled={assembling}
                  className="relative w-11 h-6 rounded-full transition-all disabled:opacity-40 shrink-0"
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
                        <button key={s.id} onClick={() => setCaptionsStyle(s.id)} disabled={assembling}
                          className="py-2 px-3 rounded-xl text-left transition-all disabled:opacity-40"
                          style={captionsStyle === s.id ? {
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-7)",
                          }}>
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
                          <button key={s.id} onClick={() => setCaptionsSize(s.id)} disabled={assembling}
                            className="flex-1 py-1.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-40"
                            style={captionsSize === s.id ? {
                              background: "oklch(0.72 0.25 285 / 0.15)",
                              border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                              color: "oklch(0.88 0.12 285)",
                            } : {
                              background: "var(--bg-input)",
                              border: "1px solid var(--bd-7)",
                              color: "var(--c-50)",
                            }}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex-1">
                      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Position</p>
                      <div className="flex gap-1.5">
                        {CAPTION_POSITIONS.map((p) => (
                          <button key={p.id} onClick={() => setCaptionsPosition(p.id)} disabled={assembling}
                            className="flex-1 py-1.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                            style={captionsPosition === p.id ? {
                              background: "oklch(0.72 0.25 285 / 0.15)",
                              border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                              color: "oklch(0.88 0.12 285)",
                            } : {
                              background: "var(--bg-input)",
                              border: "1px solid var(--bd-7)",
                              color: "var(--c-50)",
                            }}>
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
                        <button key={lang.code} onClick={() => setCaptionsLanguage(lang.code)} disabled={assembling}
                          className="px-3 py-1.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                          style={captionsLanguage === lang.code ? {
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                            color: "oklch(0.88 0.12 285)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-7)",
                            color: "var(--c-50)",
                          }}>
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
              {assembledUrl && (
                <video
                  key={assembledUrl}
                  ref={assembledVideoRef}
                  src={assembledUrl}
                  controls
                  className="w-full rounded-xl"
                  style={{ background: "var(--bg-page-2)" }}
                  onLoadedMetadata={() => {
                    const d = assembledVideoRef.current?.duration;
                    if (d && isFinite(d)) setVideoDuration(d);
                  }}
                  onError={() => toast.error("Preview unavailable — the worker may have restarted. Try exporting or click Reassemble.")}
                />
              )}

              {assembling && (
                <div className="space-y-3">
                  <div className="flex items-center justify-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0"
                      style={{ color: "oklch(0.72 0.25 285)" }} />
                    <p className="text-xs text-center" style={{ color: "var(--c-55)" }}>{assembleStatus}</p>
                  </div>
                  <button onClick={() => { setAssembling(false); setAssembleStatus(""); }}
                    className="w-full py-2 rounded-xl text-xs font-medium transition-all"
                    style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-7)", color: "var(--c-45)" }}>
                    Cancel / Restart
                  </button>
                  <p className="text-xs text-center" style={{ color: "var(--c-35)" }}>Progress updates every ~5 seconds…</p>
                </div>
              )}

              {!assembling && assembledUrl && (
                <div>
                  <div className="flex gap-2">
                    <button onClick={assembleVideo}
                      className="flex-1 py-2.5 rounded-xl text-xs font-medium transition-all"
                      style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}>
                      Reassemble
                    </button>
                    <a href={assembledUrl} download="assembled.mp4"
                      className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-center transition-all"
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                      ↓ Export
                    </a>
                  </div>
                  <button
                    onClick={() => router.push(`/projects/${projectId}/thumbnails`)}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)", marginTop: "50px", marginBottom: "20px" }}
                  >
                    Continue →
                  </button>
                </div>
              )}

              {!assembledUrl && !assembling && uploadFailedPreview && (
                <div className="space-y-2">
                  <div className="rounded-xl p-3" style={{ background: "oklch(0.6 0.22 25 / 0.08)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}>
                    <p className="text-xs font-semibold" style={{ color: "oklch(0.7 0.2 25)" }}>
                      Upload to cloud failed
                    </p>
                    <p className="text-xs mt-1" style={{ color: "var(--c-55)" }}>
                      Your assembled video is preserved on the worker. Retry just the upload — no need to re-render.
                    </p>
                    {project?.assembly_error && (
                      <p className="text-[10px] mt-1.5 font-mono break-all" style={{ color: "var(--c-40)" }}>
                        {project.assembly_error as string}
                      </p>
                    )}
                  </div>
                  <button onClick={retryUpload} disabled={assembling}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 transition-all"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                    {assembling ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Uploading…
                      </span>
                    ) : "Retry Upload"}
                  </button>
                  <button onClick={assembleVideo} disabled={assembling}
                    className="w-full py-2 rounded-xl text-xs font-medium disabled:opacity-60 transition-all"
                    style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}>
                    {assembling ? "Queuing…" : "Or reassemble from scratch"}
                  </button>
                </div>
              )}

              {!assembledUrl && !assembling && !uploadFailedPreview && (
                <>
                  {!hasVoiceover && (
                    <p className="text-xs text-center py-1" style={{ color: "var(--c-40)" }}>
                      Generate a voiceover on the Generate page first.
                    </p>
                  )}
                  <button onClick={assembleVideo} disabled={!hasVoiceover || assembling}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                    {assembling ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Queuing…
                      </span>
                    ) : "Assemble Final Video"}
                  </button>
                </>
              )}
            </div>

          </div>{/* end left column */}

        </div>
      </main>
    </div>
  );
}
