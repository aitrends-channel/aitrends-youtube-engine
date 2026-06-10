"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
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
  // True from the moment the user clicks Stop until the worker
  // acknowledges by transitioning assembly_status to "stopped".
  // Lets the button label/disabled-state flip to "Stopping…"
  // instantly while the worker finishes its current ffmpeg stage and
  // persists the checkpoint.
  const stopRequested = !!project?.assembly_stop_requested;
  // Confirm dialog for Reassemble. Reassemble doesn't start the run
  // directly anymore — it asks first, then on confirm flips the page
  // into reassembleMode, which hides the current assembled video and
  // reveals the pre-assembly config panel so the user can pick a
  // different voiceover, change captions, etc. before kicking off.
  const [reassembleConfirmOpen, setReassembleConfirmOpen] = useState(false);
  // When true: the existing assembled video is suppressed and the
  // config + Assemble button block is rendered. Cleared automatically
  // when assembleVideo() actually fires (the new run will replace
  // project.assembled_url on success) or if the user navigates away
  // and comes back.
  const [reassembleMode, setReassembleMode] = useState(false);
  const [assembleStatus, setAssembleStatus] = useState("");
  const [assembledUrl, setAssembledUrl] = useState<string | null>(null);

  // Derived: the URL we should actually show in the preview. Single
  // source of truth for "is the preview section visible". Hidden
  // whenever:
  //   - the user committed to reassembling (don't flash the deleted
  //     video back even for a tick), or
  //   - a new assembly is in flight (assembling status), or
  //   - the DB row carries no assembled_url (the canonical source —
  //     the moment clear_assembled lands, the preview disappears).
  // Local `assembledUrl` state is no longer consulted for the gate;
  // the polling effects keep it for unrelated UI bits (e.g. the
  // download anchor target) but rendering decisions go through here
  // so a stale local value can't flash an already-deleted player.
  const dbAssembledUrl = (project?.assembled_url as string | undefined) ?? null;
  const previewUrl: string | null = (reassembleMode || assembling) ? null : dbAssembledUrl;
  const showPreview = !!previewUrl;

  const assembledVideoRef = useRef<HTMLVideoElement>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [trimmingAudio, setTrimmingAudio] = useState(false);
  const [trimAudioStatus, setTrimAudioStatus] = useState("");


  useEffect(() => {
    // Don't auto-restore the preview URL while the user is actively
    // reassembling — the SWR cache can still have stale project data
    // for a tick or two between the PATCH that nulled assembled_url and
    // the refetch that picks up the change, and this effect would
    // otherwise flash the old video back in.
    if (reassembleMode) return;
    const status = project?.assembly_status as string | undefined;
    const url = project?.assembled_url as string | undefined;
    if (!assembling && url && !assembledUrl && (status === "done" || status === "preview")) {
      setAssembledUrl(url);
    }
  }, [project, assembling, assembledUrl, reassembleMode]);

  useEffect(() => {
    const status = project?.assembly_status as string | undefined;
    if (!status) return;
    if (status === "queued") {
      setAssembling(true);
      setAssembleStatus("Queued…");
    } else if (status === "processing" || status === "uploading") {
      setAssembling(true);
      setAssembleStatus((project?.assembly_progress as string | undefined) ?? "Assembling…");
    } else if (status === "stopped") {
      // Worker honored the Stop signal and persisted the checkpoint.
      // Keep the panel visible so the user sees the Resume button
      // (rendered below) without having to refresh — the panel renders
      // as long as `assembling` is true, and `assembleStatus` carries
      // the last progress line so they remember where it stopped.
      setAssembling(true);
      setAssembleStatus((project?.assembly_progress as string | undefined) ?? "Stopped — click Resume to continue");
    } else if (status === "preview" || status === "done") {
      // Same reassembleMode guard as the auto-restore effect above —
      // stale "done" status from the SWR cache pre-refetch would
      // otherwise re-populate assembledUrl with the deleted URL.
      if (reassembleMode) return;
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
  }, [project?.assembly_status, project?.assembly_progress, reassembleMode]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const mp3Bytes = await encodeMp3(channels, sampleRate);

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

  // Confirm-Reassemble action. Hits the clear_assembled endpoint which
  // deletes the assembled mp4 from R2, wipes the assembly_* fields on
  // the project (including the saved checkpoint), then flips the page
  // into reassembleMode so the user can adjust voiceover / captions /
  // aspect ratio before kicking off the new run. The old video is
  // gone the moment this resolves — there is no fallback to the
  // previous output.
  //
  // Order matters: we flip every local-state gate that could keep the
  // preview visible BEFORE the network round-trip. Otherwise the user
  // sees the old player for the ~500ms the PATCH + SWR refetch takes,
  // which looks like the button didn't work. The PATCH itself is then
  // the canonical cleanup (DB + R2), and the mutate() that follows
  // syncs project.assembled_url back to null so the gate stays closed
  // even when reassembleMode eventually drops back to false.
  const [clearingAssembled, setClearingAssembled] = useState(false);
  async function confirmReassemble() {
    // Hide preview + reset every local cache that could keep it
    // visible. These run before the network call so the player
    // disappears immediately on click.
    setReassembleMode(true);
    setAssembledUrl(null);
    setVideoDuration(null);
    setAssembleStatus("");
    setReassembleConfirmOpen(false);
    // Optimistic SWR update: blank assembled_url + assembly_* fields
    // locally so the gate reads null immediately, even before the
    // PATCH completes and the canonical refetch lands.
    void mutate((cur: Record<string, unknown> | undefined) => cur ? {
      ...cur,
      assembled_url: null,
      assembly_status: null,
      assembly_progress: null,
      assembly_error: null,
      assembly_checkpoint: null,
    } : cur, { revalidate: false });
    setClearingAssembled(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_assembled: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to clear assembled video");
      }
      // Canonical refetch — replaces the optimistic state with the
      // server's truth. If the PATCH failed mid-flight, this is what
      // would surface the inconsistency.
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear the existing video");
      // Roll back the optimistic hide so the user can see the existing
      // video again and retry, instead of being stuck on a config
      // panel that doesn't reflect actual server state.
      setReassembleMode(false);
      await mutate();
    } finally {
      setClearingAssembled(false);
    }
  }

  async function stopAssembly() {
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assembly_stop_requested: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to request stop");
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stop failed");
    }
  }

  // Confirm-Cancel action paired with Resume when assembly_status is
  // "stopped". Hits the cancel_assembly PATCH which wipes the
  // checkpoint folder + every assembly_* field on the project (but
  // leaves assembled_url alone so a previously-successful video stays
  // available). After this the progress panel goes away and the user
  // is back at the pre-assembly config view.
  const [cancelAssemblyConfirmOpen, setCancelAssemblyConfirmOpen] = useState(false);
  const [cancellingAssembly, setCancellingAssembly] = useState(false);
  async function cancelAssembly() {
    setCancellingAssembly(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cancel_assembly: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to cancel");
      }
      setAssembling(false);
      setAssembleStatus("");
      setCancelAssemblyConfirmOpen(false);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setCancellingAssembly(false);
    }
  }

  async function resumeAssembly() {
    try {
      // Re-queue via the same endpoint as a fresh assembly. The endpoint
      // writes the current options into Redis (so the worker reads the
      // user's CURRENT settings on Resume — captionsStyle changes etc.
      // take effect) and clears assembly_stop_requested. The worker's
      // checkpoint-hash check then invalidates only the suffix of stages
      // affected by any changed options.
      const res = await fetch("/api/generate/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, aspectRatio, voiceoverType, captionsEnabled, captionsLanguage, captionsStyle, captionsSize, captionsPosition }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to resume");
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Resume failed");
    }
  }

  // Per-run silence trim toggle. assembleVideo() takes a parameter
  // instead of state so the "Trim silences" button can pass true
  // directly without waiting for a setState round-trip. Normal
  // Assemble / Reassemble calls leave the flag at false.
  async function assembleVideo(trimSilence: boolean = false) {
    if (assembling) return;
    // Whether this is a first assembly or a confirmed reassemble, the
    // config panel is the launch path — drop reassembleMode here so a
    // successful run swaps cleanly back to the video-player view.
    setReassembleMode(false);
    setAssembling(true);
    setAssembledUrl(null);
    setAssembleStatus(trimSilence ? "Queuing (trim silences)…" : "Queuing…");
    try {
      const res = await fetch("/api/generate/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, aspectRatio, voiceoverType, captionsEnabled, captionsLanguage, captionsStyle, captionsSize, captionsPosition, trimSilenceEnabled: trimSilence }),
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

  // Trim-silences flow: confirm modal → clear the current assembled
  // mp4 + checkpoint → assembleVideo(true). Single click for the user;
  // no need to drop into the reassembleMode config panel because the
  // only thing changing is the trim flag, not any user-facing option.
  const [trimConfirmOpen, setTrimConfirmOpen] = useState(false);
  const [trimRunning, setTrimRunning] = useState(false);
  async function runTrimAssembly() {
    setTrimRunning(true);
    try {
      const clearRes = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_assembled: true }),
      });
      if (!clearRes.ok) {
        const err = await clearRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to clear assembled video");
      }
      setAssembledUrl(null);
      await mutate();
      setTrimConfirmOpen(false);
      await assembleVideo(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Trim re-assembly failed");
    } finally {
      setTrimRunning(false);
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

              {showPreview && ttsUrl && (
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
              {showPreview && previewUrl && (
                <video
                  key={previewUrl}
                  ref={assembledVideoRef}
                  src={previewUrl}
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

              {assembling && (() => {
                /* Stage-aware progress: the worker emits short status strings
                   for each phase via setProgress(); we match the current one
                   to a known stage and render every stage with a done/doing/
                   pending indicator + an overall % bar. */
                const stages = [
                  { key: "load",       label: "Load project",        match: (s: string) => s.startsWith("Loading") || s === "Queued…" || s === "Starting…" },
                  { key: "voiceover",  label: "Download voiceover",  match: (s: string) => s.startsWith("Downloading") },
                  ...(captionsEnabled ? [{ key: "transcribe", label: "Transcribe voiceover", match: (s: string) => s.startsWith("Transcribing") }] : []),
                  { key: "clips",      label: "Process video clips", match: (s: string) => s.startsWith("Processing") },
                  { key: "join",       label: "Join clips",          match: (s: string) => s.startsWith("Joining") },
                  { key: "mix",        label: "Mix voiceover",       match: (s: string) => s.startsWith("Mixing") },
                  ...(captionsEnabled ? [
                    { key: "gencap",   label: "Generate captions",   match: (s: string) => s.startsWith("Generating") || s.startsWith("Translating") },
                    { key: "burncap",  label: "Burn captions",       match: (s: string) => s.startsWith("Burning") },
                  ] : []),
                  { key: "upload",     label: "Upload to cloud",     match: (s: string) => s.startsWith("Uploading") },
                ];
                const currentIdx = (() => {
                  const i = stages.findIndex((s) => s.match(assembleStatus));
                  return i === -1 ? 0 : i;
                })();
                const pct = Math.round((currentIdx / stages.length) * 100);

                return (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs" style={{ color: "var(--c-45)" }}>
                        <span>Step {currentIdx + 1} of {stages.length}</span>
                        <span>{pct}%</span>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                        <div className="h-full transition-all duration-500"
                          style={{ width: `${pct}%`, background: "oklch(0.72 0.25 285)" }} />
                      </div>
                    </div>

                    <ul className="space-y-2">
                      {stages.map((s, i) => {
                        const done = i < currentIdx;
                        const doing = i === currentIdx;
                        /* Per-stage progress: parse "X of N" out of the status
                           when possible (clips stage). Otherwise we show an
                           indeterminate animated stripe so the user still sees
                           the stage is actively working. */
                        const clipMatch = doing ? assembleStatus.match(/(\d+)\s+of\s+(\d+)/i) : null;
                        const stagePct = done
                          ? 100
                          : doing && clipMatch
                          ? Math.round((parseInt(clipMatch[1], 10) / parseInt(clipMatch[2], 10)) * 100)
                          : 0;
                        const showIndeterminate = doing && !clipMatch;
                        return (
                          <li key={s.key} className="space-y-1">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                                style={{
                                  background: done ? "oklch(0.55 0.15 145 / 0.15)" : doing ? "oklch(0.72 0.25 285 / 0.15)" : "var(--bg-track)",
                                  border: `1px solid ${done ? "oklch(0.55 0.15 145 / 0.4)" : doing ? "oklch(0.72 0.25 285 / 0.4)" : "var(--bd-7)"}`,
                                  color: done ? "oklch(0.7 0.15 145)" : doing ? "oklch(0.88 0.12 285)" : "var(--c-35)",
                                  fontSize: "9px",
                                }}>
                                {done ? "✓" : doing ? (
                                  <span className="w-2 h-2 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" />
                                ) : i + 1}
                              </span>
                              <span className="flex-1" style={{ color: done ? "var(--c-55)" : doing ? "var(--c-65)" : "var(--c-40)", fontWeight: doing ? 600 : 400 }}>
                                {s.label}
                              </span>
                              {doing && clipMatch && (
                                <span className="text-[10px]" style={{ color: "var(--c-55)" }}>{stagePct}%</span>
                              )}
                            </div>
                            <div className="ml-6 h-1 rounded-full overflow-hidden relative" style={{ background: "var(--bg-track)" }}>
                              {showIndeterminate ? (
                                <div className="progress-indeterminate h-full"
                                  style={{ background: "oklch(0.72 0.25 285)" }} />
                              ) : (
                                <div className="h-full transition-all duration-500"
                                  style={{
                                    width: `${stagePct}%`,
                                    background: done ? "oklch(0.7 0.15 145)" : "oklch(0.72 0.25 285)",
                                  }} />
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>

                    <p className="text-[11px] text-center leading-snug" style={{ color: "var(--c-45)" }}>
                      {assembleStatus || "Working…"}
                    </p>

                    {project?.assembly_status === "stopped" ? (
                      <div className="flex gap-2">
                        <button onClick={() => setCancelAssemblyConfirmOpen(true)}
                          disabled={cancellingAssembly}
                          className="flex-1 py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-40"
                          style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}>
                          Cancel
                        </button>
                        <button onClick={resumeAssembly}
                          disabled={cancellingAssembly}
                          className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                          style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                          Resume
                        </button>
                      </div>
                    ) : (
                      <button onClick={stopAssembly} disabled={stopRequested}
                        className="w-full py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-40"
                        style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}>
                        {stopRequested ? "Stopping…" : "Stop"}
                      </button>
                    )}
                    <p className="text-[11px] text-center" style={{ color: "var(--c-35)" }}>Progress updates every ~5 seconds…</p>
                  </div>
                );
              })()}

              {showPreview && previewUrl && (
                <div>
                  <div className="flex gap-2">
                    <button onClick={() => setReassembleConfirmOpen(true)}
                      className="flex-1 py-2.5 rounded-xl text-xs font-medium transition-all"
                      style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}>
                      Reassemble
                    </button>
                    <button onClick={() => setTrimConfirmOpen(true)}
                      disabled={trimRunning || assembling}
                      title="Re-assemble with leading/trailing silence trimmed from every beat. Use if you hear short pauses between beats."
                      className="flex-1 py-2.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                      style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}>
                      {trimRunning ? "Trimming…" : "Trim silences"}
                    </button>
                    <a href={previewUrl} download="assembled.mp4"
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

              {!showPreview && !assembling && uploadFailedPreview && (
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
                  <button onClick={() => assembleVideo()} disabled={assembling}
                    className="w-full py-2 rounded-xl text-xs font-medium disabled:opacity-60 transition-all"
                    style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}>
                    {assembling ? "Queuing…" : "Or reassemble from scratch"}
                  </button>
                </div>
              )}

              {!showPreview && !assembling && !uploadFailedPreview && (
                <>
                  {reassembleMode && (
                    <p className="text-xs text-center py-1" style={{ color: "var(--c-50)" }}>
                      Reassembling — review the settings above, then click <strong>Assemble</strong> to start.
                    </p>
                  )}
                  {!hasVoiceover && (
                    <p className="text-xs text-center py-1" style={{ color: "var(--c-40)" }}>
                      Generate a voiceover on the Generate page first.
                    </p>
                  )}
                  <div className="flex gap-2">
                    {reassembleMode && (
                      <button onClick={() => setReassembleMode(false)} disabled={assembling}
                        className="flex-1 py-2.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                        style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}>
                        Cancel
                      </button>
                    )}
                    <button onClick={() => assembleVideo()} disabled={!hasVoiceover || assembling}
                      className={`${reassembleMode ? "flex-1" : "w-full"} py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all`}
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                      {assembling ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Queuing…
                        </span>
                      ) : reassembleMode ? "Assemble" : "Assemble Final Video"}
                    </button>
                  </div>
                </>
              )}
            </div>

          </div>{/* end left column */}

        </div>
      </main>

      <Dialog open={trimConfirmOpen} onOpenChange={(open) => { if (!trimRunning) setTrimConfirmOpen(open); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Trim silences & reassemble?</DialogTitle>
            <DialogDescription>
              This deletes the current assembled video and re-runs the assembly with leading/trailing silence trimmed from every beat&apos;s audio. Use this if you hear short pauses between beats. Internal pauses inside each beat are preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setTrimConfirmOpen(false)}
              disabled={trimRunning}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{ background: "transparent", border: "1px solid var(--bd-7)", color: "var(--c-60)" }}
            >
              Cancel
            </button>
            <button
              onClick={runTrimAssembly}
              disabled={trimRunning}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-60"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              {trimRunning ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Re-queuing…
                </span>
              ) : "Trim silences & reassemble"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reassembleConfirmOpen} onOpenChange={(open) => { if (!clearingAssembled) setReassembleConfirmOpen(open); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Reassemble video?</DialogTitle>
            <DialogDescription>
              This will <strong>permanently delete</strong> the current assembled video from storage and clear the preview. You&apos;ll then be able to choose the voiceover and adjust the captions / aspect ratio before starting a fresh run. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setReassembleConfirmOpen(false)}
              disabled={clearingAssembled}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{ background: "transparent", border: "1px solid var(--bd-7)", color: "var(--c-60)" }}
            >
              Cancel
            </button>
            <button
              onClick={confirmReassemble}
              disabled={clearingAssembled}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-60"
              style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
            >
              {clearingAssembled ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Deleting…
                </span>
              ) : "Delete & reassemble"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelAssemblyConfirmOpen} onOpenChange={(open) => { if (!cancellingAssembly) setCancelAssemblyConfirmOpen(open); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Cancel this assembly?</DialogTitle>
            <DialogDescription>
              This will <strong>discard the in-progress assembly</strong> — all intermediate work (transcription, encoded clips, joined / padded / mixed video) will be deleted from storage and you won&apos;t be able to Resume. Your previously assembled video (if any) is kept. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setCancelAssemblyConfirmOpen(false)}
              disabled={cancellingAssembly}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{ background: "transparent", border: "1px solid var(--bd-7)", color: "var(--c-60)" }}
            >
              Keep
            </button>
            <button
              onClick={cancelAssembly}
              disabled={cancellingAssembly}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-60"
              style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
            >
              {cancellingAssembly ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Cancelling…
                </span>
              ) : "Yes, cancel"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
