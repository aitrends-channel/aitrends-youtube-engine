"use client";

import { useState, use, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import useSWR from "swr";
import type { KieModel, Beat } from "@/lib/types";
import { getModelConfig } from "@/lib/kie/imageModels";
import { getVideoModelConfig } from "@/lib/kie/videoModels";
import { removeLongPauses, encodeMp3 } from "@/lib/audio/silenceRemover";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) return r.json().catch(() => ({})).then((e: { error?: string }) => { throw new Error(e.error ?? `Failed to load (${r.status})`); });
    return r.json().catch(() => ({}));
  });

function friendlyError(raw: string | undefined | null): string {
  const msg = (raw ?? "").toLowerCase();
  if (msg.includes("credits insufficient") || msg.includes("insufficient credits") || (msg.includes("insufficient") && (msg.includes("balance") || msg.includes("credit"))))
    return "Insufficient KIE credits — top up your account at kie.ai";
  if (msg.includes("quota_exceeded") || msg.includes("quota exceeded") || msg.includes("credits remaining") || msg.includes("credit balance"))
    return "Insufficient KIE credits — top up your account at kie.ai";
  if (msg.includes("invalid_api_key") || msg.includes("invalid api key") || msg.includes("unauthorized") || (msg.includes("api key") && msg.includes("invalid")))
    return "API key is invalid — go to Settings to update it";
  if (msg.includes("api key") && (msg.includes("missing") || msg.includes("not set") || msg.includes("required")))
    return "API key not set — go to Settings to add it";
  if (msg.includes("internal error") || msg.includes("internal server error") || msg.includes("fail code 500"))
    return "The selected model is temporarily unavailable — try a different one";
  if (msg.includes("this field is required"))
    return "Video model rejected the request — try a different video model";
  if (msg.includes("timed out") || msg.includes("timeout"))
    return "Generation timed out — try again or use a simpler prompt";
  if (msg.includes("no task id") || msg.includes("no taskid"))
    return "Failed to queue task — the model may be unavailable, try another";
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
        border: "1px solid var(--bd-7)",
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

function ModelOption({ model, selected, onSelect }: { model: KieModel; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="w-full text-left p-3 rounded-xl transition-all"
      style={selected ? {
        background: "oklch(0.72 0.25 285 / 0.1)",
        border: "1px solid oklch(0.72 0.25 285 / 0.3)",
        color: "var(--c-90)",
      } : {
        background: "var(--bg-input)",
        border: "1px solid var(--bd-7)",
        color: "var(--c-60)",
      }}
    >
      <p className="font-medium text-xs">{model.name}</p>
      {model.description && <p className="text-xs mt-0.5 opacity-60">{model.description}</p>}
      {(model.tags?.length || model.costPerUnit) && (
        <div className="flex gap-1 mt-2 flex-wrap">
          {model.tags?.map((tag) => (
            <span key={tag} className="px-1.5 py-0.5 rounded text-xs"
              style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>
              {tag}
            </span>
          ))}
          {model.costPerUnit && (
            <span className="px-1.5 py-0.5 rounded text-xs"
              style={{ background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" }}>
              {model.costPerUnit}/s
            </span>
          )}
        </div>
      )}
    </button>
  );
}

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

  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [selectedTtsModel, setSelectedTtsModel] = useState<string | null>(null);
  const [selectedImageModel, setSelectedImageModel] = useState<string | null>(null);
  const [selectedAspectRatio, setSelectedAspectRatio] = useState("16:9");
  const [selectedResolution, setSelectedResolution] = useState<string | null>(null);
  const [selectedVideoModel, setSelectedVideoModel] = useState<string | null>(null);
  const [selectedVideoAspectRatio, setSelectedVideoAspectRatio] = useState("16:9");
  const [selectedDuration, setSelectedDuration] = useState<string | number | null>(null);

  const initialTtsSelected = useRef(false);

  const [navigating, setNavigating] = useState(false);
  const [generatingTts, setGeneratingTts] = useState(false);
  const [ttsProgress, setTtsProgress] = useState<{ current: number; total: number } | null>(null);
  const [ttsStatusMsg, setTtsStatusMsg] = useState<string>("");
  const [removingPauses, setRemovingPauses] = useState(false);
  const [removePausesStatus, setRemovePausesStatus] = useState("");
  const [generatingImages, setGeneratingImages] = useState(false);
  const [queuingVideos, setQueuingVideos] = useState(false);
  const [pausingVideos, setPausingVideos] = useState(false);
  const [resumingVideos, setResumingVideos] = useState(false);
  const [imagesProgress, setImagesProgress] = useState(0);
  // Pending URLs are only set during active generation; otherwise fall back to DB values via project
  const [pendingTtsUrl, setPendingTtsUrl] = useState<string | null>(null);
  const [pendingTtsCleanedUrl, setPendingTtsCleanedUrl] = useState<string | null>(null);
  const [cleanedUrlInvalidated, setCleanedUrlInvalidated] = useState(false);
  const [videosSubmitted, setVideosSubmitted] = useState(false);
  const [regenBeats, setRegenBeats] = useState<Set<number>>(new Set());
  const [clearingImages, setClearingImages] = useState(false);
  const [hoveredImageBeat, setHoveredImageBeat] = useState<Beat | null>(null);
  const [hoveredVideoBeat, setHoveredVideoBeat] = useState<Beat | null>(null);
  const videoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beats: Beat[] = project?.beats ?? [];
  const script: string = project?.script ?? "";
  const totalBeats = beats.length;
  const generatedImages = beats.filter((b) => b.imageUrl).length;
  const generatedVideos = beats.filter((b) => b.videoUrl).length;
  const videoBeats = beats.filter((b) => b.videoPrompt).length;
  const failedVideos = beats.filter((b) => b.videoPrompt && b.videoStatus === "failed").length;
  const pendingVideos = beats.filter((b) => b.videoPrompt && !b.videoUrl).length;
  const queuedVideos = beats.filter((b) => b.videoStatus === "queued").length;
  const pausedVideos = beats.filter((b) => b.videoStatus === "paused").length;

  // Derive display URLs from DB data; use pending state only during active operations
  const ttsUrl = generatingTts ? null : (pendingTtsUrl ?? project?.tts_url ?? null);
  const ttsCleanedUrl = removingPauses || cleanedUrlInvalidated ? null : (pendingTtsCleanedUrl ?? project?.tts_cleaned_url ?? null);

  useEffect(() => {
    if (!generatingImages && project?.images_progress) setImagesProgress(project.images_progress);
  }, [project?.images_progress, generatingImages]);

  useEffect(() => {
    if (ttsModels?.length && !initialTtsSelected.current) {
      initialTtsSelected.current = true;
      setSelectedTtsModel(ttsModels[0].id);
    }
  }, [ttsModels]);
  useEffect(() => { if (imageModels?.length && !selectedImageModel) setSelectedImageModel(imageModels[0].id); }, [imageModels]);

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
  useEffect(() => { if (videoModels?.length && !selectedVideoModel) setSelectedVideoModel(videoModels[0].id); }, [videoModels]);

  useEffect(() => {
    if (!selectedVideoModel) return;
    const config = getVideoModelConfig(selectedVideoModel);
    if (config.durations.length === 0) {
      setSelectedDuration(null);
    } else {
      setSelectedDuration(config.durations[0].value);
    }
    if (!config.aspectRatios.includes(selectedVideoAspectRatio)) {
      setSelectedVideoAspectRatio(config.aspectRatios[0]);
    }
  }, [selectedVideoModel]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasActiveVideos = beats.some((b) => b.videoStatus === "queued" || b.videoStatus === "rendering");

  useEffect(() => {
    if (hasActiveVideos && !videosSubmitted) setVideosSubmitted(true);
  }, [hasActiveVideos]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!videosSubmitted) return;
    let lastError: string | null = null;
    const poll = async () => {
      const res = await fetch(`/api/generate/videos/poll?projectId=${projectId}`);
      const data = await res.json().catch(() => ({})) as { pending?: number; firstError?: string | null };
      if (data.firstError && data.firstError !== lastError) {
        lastError = data.firstError;
        toast.error(friendlyError(data.firstError));
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
      const { channels, sampleRate, originalDuration, newDuration } = removeLongPauses(audioBuffer);

      setRemovePausesStatus("Encoding audio...");
      const mp3Bytes = encodeMp3(channels, sampleRate);

      setRemovePausesStatus("Uploading...");
      const uploadRes = await fetch(`/api/generate/tts/clean?projectId=${projectId}`, {
        method: "POST",
        body: mp3Bytes,
        headers: { "Content-Type": "audio/mpeg" },
      });
      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Upload failed");
      }
      const { url } = await uploadRes.json().catch(() => ({})) as { url?: string };
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

  async function generateImages() {
    if (!selectedImageModel || !beats.length) return;
    const isRegen = generatedImages > 0;
    setGeneratingImages(true);
    setImagesProgress(0);
    if (isRegen) setClearingImages(true);
    let successCount = 0;
    try {
      if (isRegen) {
        await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear_images: true }),
        });
        setClearingImages(false);
      }

      // Submit beats in batches of 3 with a 1.5s gap to avoid kie.ai rate limits
      const SUBMIT_BATCH = 3;
      const pending: { beatNumber: number; taskId: string }[] = [];
      let firstSubmitError: string | null = null;

      for (let i = 0; i < beats.length; i += SUBMIT_BATCH) {
        const batch = beats.slice(i, i + SUBMIT_BATCH);
        const batchResults = await Promise.allSettled(
          batch.map(async (beat) => {
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
            const data = await res.json().catch(() => ({})) as { taskId?: string; error?: string };
            if (!res.ok || !data.taskId) throw new Error(data.error ?? `HTTP ${res.status}`);
            return { beatNumber: beat.beatNumber, taskId: data.taskId };
          })
        );
        for (const r of batchResults) {
          if (r.status === "fulfilled") pending.push(r.value);
          else if (!firstSubmitError) firstSubmitError = r.reason instanceof Error ? r.reason.message : "Unknown error";
        }
        if (i + SUBMIT_BATCH < beats.length) await new Promise((r) => setTimeout(r, 1500));
      }

      if (pending.length === 0) {
        throw new Error(firstSubmitError ?? "unknown error");
      }
      if (firstSubmitError) {
        toast.warning(`${pending.length}/${beats.length} tasks submitted — ${friendlyError(firstSubmitError)}`);
      }

      // Poll all pending tasks in parallel every 3s until all complete
      const remaining = [...pending];
      let firstPollError: string | null = null;
      const MAX_POLLS = 50; // ~2.5 min max
      for (let attempt = 0; attempt < MAX_POLLS && remaining.length > 0; attempt++) {
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
              if (!firstPollError) firstPollError = error ?? "Unknown error";
              toRemove.push(i);
            }
          }
        }
        for (let i = toRemove.length - 1; i >= 0; i--) remaining.splice(toRemove[i], 1);
      }

      await mutate();
      if (successCount === 0) {
        const reason = firstPollError ?? firstSubmitError ?? "timed out";
        toast.error(`0/${beats.length} images generated — ${friendlyError(reason)}`);
      } else if (successCount < beats.length) {
        toast.warning(`${successCount}/${beats.length} images generated — some failed`);
      } else {
        toast.success(`${successCount}/${beats.length} images generated`);
      }
    } catch (err) {
      toast.error(friendlyError(err instanceof Error ? err.message : null));
    } finally {
      setGeneratingImages(false);
      setClearingImages(false);
    }
  }

  async function regenerateImage(beat: Beat) {
    if (!selectedImageModel) return;
    setRegenBeats((prev) => new Set(prev).add(beat.beatNumber));
    try {
      const submitRes = await fetch("/api/generate/images/submit", {
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
      const submitData = await submitRes.json().catch(() => ({})) as { taskId?: string; error?: string };
      if (!submitRes.ok || !submitData.taskId) throw new Error(submitData.error ?? "Failed to submit image task");

      const taskId = submitData.taskId;
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((r) => setTimeout(r, 4000));
        const pollRes = await fetch("/api/generate/images/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, beatNumber: beat.beatNumber, taskId, modelId: selectedImageModel }),
        });
        const pollData = await pollRes.json().catch(() => ({})) as { status?: string; error?: string };
        if (pollData.status === "done") { toast.success(`Beat ${beat.beatNumber} regenerated`); return; }
        if (pollData.status === "failed") throw new Error(pollData.error ?? "Image generation failed");
      }
      throw new Error("timed out");
    } catch (err) {
      toast.error(friendlyError(err instanceof Error ? err.message : null));
    } finally {
      await mutate();
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
      toast.error(err instanceof Error ? err.message : "Pause failed");
    } finally {
      setPausingVideos(false);
    }
  }

  async function resumeVideos() {
    if (!selectedVideoModel || resumingVideos) return;
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
        }),
      });
      const data = await res.json().catch(() => ({})) as { resumed?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Resume failed (HTTP ${res.status})`);
      toast.success(`Resumed ${data.resumed ?? 0} clips`);
      setVideosSubmitted(true);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Resume failed");
    } finally {
      setResumingVideos(false);
    }
  }

  async function queueVideos(mode: "all" | "failed" = "all") {
    if (!selectedVideoModel || !beats.length) return;
    setQueuingVideos(true);
    try {
      // "all" means everything that still needs a video (no URL yet),
      // not literally every beat — re-submitting a done beat would wipe
      // its video_url on the server. "failed" only retries failures.
      const eligible = beats.filter((b) => {
        if (!b.videoPrompt) return false;
        if (b.videoUrl) return false;
        if (mode === "failed") return b.videoStatus === "failed";
        return true;
      });
      if (eligible.length === 0) return;
      const res = await fetch("/api/generate/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          beats: eligible.map((b) => ({ beatNumber: b.beatNumber, videoPrompt: b.videoPrompt, imageUrl: b.imageUrl })),
          modelId: selectedVideoModel,
          aspectRatio: selectedVideoAspectRatio,
          ...(selectedDuration !== null ? { duration: selectedDuration } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { submitted?: number; failures?: { beatNumber: number; error: string }[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
      setVideosSubmitted(true);
      const verb = mode === "failed" ? "re-submitted" : "submitted";
      if ((data.submitted ?? 0) > 0) toast.success(`${data.submitted ?? 0} video clips ${verb}`);
      if (data.failures?.length) {
        toast.error(`${data.failures.length} clip(s) failed — ${friendlyError(data.failures[0].error)}`);
      }
    } catch (err) {
      toast.error(friendlyError(err instanceof Error ? err.message : null));
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

      <main className="flex-1 flex flex-col overflow-hidden pt-[105px] md:pt-0">
        {/* Header */}
        <div className="shrink-0 px-4 sm:px-8 md:pr-44 py-4 sm:py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div>
            <h1 className="font-bold text-base sm:text-lg">Generate Assets</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Select a model for each service, then generate your final content
            </p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pb-[70px]">
        <div className="p-4 sm:p-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* TTS Panel */}
          <div className="rounded-2xl flex flex-col overflow-hidden"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            <div className="p-5" style={{ borderBottom: "1px solid var(--bd-6)" }}>
              <SectionHeader icon="♪" title="Voiceover" subtitle="Text-to-speech from your script" />
              <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
                Select Voice
              </p>
              <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                {ttsError ? (
                  <p className="text-xs px-1" style={{ color: "oklch(0.65 0.15 25)" }}>
                    {ttsError instanceof Error ? ttsError.message : "Failed to load voices"}
                  </p>
                ) : !ttsModels ? (
                  <p className="text-xs px-1" style={{ color: "var(--c-40)" }}>Loading voices...</p>
                ) : ttsModels.length === 0 ? (
                  <p className="text-xs px-1" style={{ color: "var(--c-40)" }}>No voices available</p>
                ) : (
                  ttsModels.map((m) => (
                    <VoiceOption key={m.id} model={m} selected={selectedTtsModel === m.id} onSelect={() => setSelectedTtsModel(m.id)}
                      isPlaying={playingVoiceId === m.id} onPlayToggle={setPlayingVoiceId} />
                  ))
                )}
              </div>
            </div>
            <div className="p-5 mt-auto space-y-3">
              {ttsUrl ? (
                <div className="space-y-3">
                  {/* Original voiceover */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Original</span>
                      <a href={ttsUrl} download="voiceover-original.mp3"
                        className="text-xs" style={{ color: "var(--c-45)" }}>
                        ↓ Download
                      </a>
                    </div>
                    <audio controls src={ttsUrl} className="w-full h-8" />
                  </div>

                  {/* Trimmed voiceover */}
                  {ttsCleanedUrl && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Trimmed</span>
                        <a href={ttsCleanedUrl} download="voiceover-trimmed.mp3"
                          className="text-xs" style={{ color: "var(--c-45)" }}>
                          ↓ Download
                        </a>
                      </div>
                      <audio controls src={ttsCleanedUrl} className="w-full h-8" />
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2">
                    <button onClick={removePauses} disabled={removingPauses || generatingTts}
                      className="flex-1 py-2 rounded-lg text-xs font-medium disabled:opacity-40 transition-all"
                      style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}>
                      {removingPauses ? (
                        <span className="flex items-center justify-center gap-1.5">
                          <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          {removePausesStatus || "Trimming…"}
                        </span>
                      ) : ttsCleanedUrl ? "Re-trim" : "Trim Pauses"}
                    </button>
                    <button onClick={() => generateVoiceover(selectedTtsModel)} disabled={generatingTts}
                      className="px-3 py-2 rounded-lg text-xs disabled:opacity-40"
                      style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}>
                      Regen
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {generatingTts && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-center" style={{ color: "var(--c-55)" }}>{ttsStatusMsg}</p>
                      {ttsProgress && ttsProgress.total > 1 && (
                        <ProgressBar value={ttsProgress.current} total={ttsProgress.total} />
                      )}
                    </div>
                  )}
                  <button
                    onClick={() => generateVoiceover(selectedTtsModel)}
                    disabled={generatingTts || !selectedTtsModel || !script}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                  >
                    {generatingTts ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Generating…
                      </span>
                    ) : "Generate Voiceover"}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Image Gen Panel */}
          <div className="rounded-2xl flex flex-col overflow-hidden"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            <div className="p-5" style={{ borderBottom: "1px solid var(--bd-6)" }}>
              <SectionHeader icon="◈" title="AI Images" subtitle={`${totalBeats} images from script beats`} />
              <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
                Select Model
              </p>
              <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                {(imageModels ?? []).map((m) => (
                  <ModelOption key={m.id} model={m} selected={selectedImageModel === m.id} onSelect={() => setSelectedImageModel(m.id)} />
                ))}
                {!imageModels && <p className="text-xs" style={{ color: "var(--c-40)" }}>Loading models...</p>}
              </div>
              {(() => {
                const config = selectedImageModel ? getModelConfig(selectedImageModel) : null;
                return config ? (
                  <>
                    <p className="text-xs font-semibold uppercase tracking-wider mt-4 mb-2" style={{ color: "var(--c-40)" }}>
                      Aspect Ratio
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {config.aspectRatios.map((r) => (
                        <button
                          key={r}
                          onClick={() => setSelectedAspectRatio(r)}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
                          style={selectedAspectRatio === r ? {
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                            color: "oklch(0.88 0.12 285)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-7)",
                            color: "var(--c-50)",
                          }}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                    {config.resolutions && (
                      <>
                        <p className="text-xs font-semibold uppercase tracking-wider mt-3 mb-2" style={{ color: "var(--c-40)" }}>
                          Resolution
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {config.resolutions.map((res) => (
                            <button
                              key={res}
                              onClick={() => setSelectedResolution(res)}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
                              style={selectedResolution === res ? {
                                background: "oklch(0.72 0.25 285 / 0.15)",
                                border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                                color: "oklch(0.88 0.12 285)",
                              } : {
                                background: "var(--bg-input)",
                                border: "1px solid var(--bd-7)",
                                color: "var(--c-50)",
                              }}
                            >
                              {res}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                ) : null;
              })()}
            </div>

            {/* Image gallery */}
            {(beats.some((b) => b.imageUrl || b.imageStatus) || regenBeats.size > 0) && (
              <div className="px-5 pt-4">
                <ProgressBar value={clearingImages ? 0 : generatedImages} total={totalBeats} />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-3 max-h-72 overflow-y-auto">
                  {beats.map((b) => {
                    const isRegening = regenBeats.has(b.beatNumber);
                    return (
                      <div
                        key={b.beatNumber}
                        className="relative aspect-video rounded-lg overflow-hidden group"
                        style={{ background: "var(--bg-progress)" }}
                        onMouseEnter={() => { if (b.imageUrl && !clearingImages) setHoveredImageBeat(b); }}
                        onMouseLeave={() => setHoveredImageBeat(null)}
                      >
                        {b.imageUrl && !clearingImages ? (
                          <img src={b.imageUrl} alt={`Beat ${b.beatNumber}`} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <span className="text-[9px]" style={{ color: "var(--c-35)" }}>{b.beatNumber}</span>
                          </div>
                        )}

                        {/* Regen overlay */}
                        {isRegening ? (
                          <div className="absolute inset-0 flex items-center justify-center"
                            style={{ background: "oklch(0 0 0 / 0.55)" }}>
                            <span className="text-[9px]" style={{ color: "var(--c-55)" }}>…</span>
                          </div>
                        ) : (
                          <div className={`absolute inset-0 flex items-center justify-center transition-opacity ${b.imageUrl ? "opacity-0 group-hover:opacity-100" : "opacity-100"}`}
                            style={{ background: b.imageUrl ? "oklch(0 0 0 / 0.45)" : "transparent" }}>
                            <button
                              onClick={() => regenerateImage(b)}
                              disabled={!selectedImageModel || generatingImages || generatingTts}
                              title={generatingTts ? "Voiceover is generating — wait for it to finish" : `Regenerate beat ${b.beatNumber}`}
                              className="w-5 h-5 rounded flex items-center justify-center disabled:opacity-40 transition-transform hover:scale-110"
                              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)", fontSize: "11px", lineHeight: 1 }}
                            >
                              ↺
                            </button>
                          </div>
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
                disabled={generatingImages || generatingTts || !selectedImageModel || !beats.length}
                title={generatingTts ? "Voiceover is generating — wait for it to finish before starting image generation" : undefined}
                className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                {generatingImages ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    {`Generating… ${clearingImages ? 0 : generatedImages}/${totalBeats}`}
                  </span>
                ) : generatedImages > 0
                  ? `Regenerate All (${totalBeats})`
                  : `Generate ${totalBeats} Images`}
              </button>
            </div>
          </div>

          {/* Video Gen Panel */}
          <div className="rounded-2xl flex flex-col overflow-hidden"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            <div className="p-5" style={{ borderBottom: "1px solid var(--bd-6)" }}>
              <SectionHeader icon="⚡" title="AI Video Clips" subtitle={`${videoBeats} clips · 3–5s each`} />
              <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
                Select Model
              </p>
              <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                {(videoModels ?? []).map((m) => (
                  <ModelOption key={m.id} model={m} selected={selectedVideoModel === m.id} onSelect={() => setSelectedVideoModel(m.id)} />
                ))}
                {!videoModels && <p className="text-xs" style={{ color: "var(--c-40)" }}>Loading models...</p>}
              </div>
              {(() => {
                if (!selectedVideoModel) return null;
                const config = getVideoModelConfig(selectedVideoModel);
                return (
                  <>
                    {config.aspectRatios.length > 0 && (
                      <>
                        <p className="text-xs font-semibold uppercase tracking-wider mt-4 mb-2" style={{ color: "var(--c-40)" }}>
                          Aspect Ratio
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {config.aspectRatios.map((r) => (
                            <button
                              key={r}
                              onClick={() => setSelectedVideoAspectRatio(r)}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
                              style={selectedVideoAspectRatio === r ? {
                                background: "oklch(0.72 0.25 285 / 0.15)",
                                border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                                color: "oklch(0.88 0.12 285)",
                              } : {
                                background: "var(--bg-input)",
                                border: "1px solid var(--bd-7)",
                                color: "var(--c-50)",
                              }}
                            >
                              {r}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {config.durations.length > 0 && (
                      <>
                        <p className="text-xs font-semibold uppercase tracking-wider mt-3 mb-2" style={{ color: "var(--c-40)" }}>
                          Duration
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {config.durations.map((d) => (
                            <button
                              key={String(d.value)}
                              onClick={() => setSelectedDuration(d.value)}
                              className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
                              style={selectedDuration === d.value ? {
                                background: "oklch(0.72 0.25 285 / 0.15)",
                                border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                                color: "oklch(0.88 0.12 285)",
                              } : {
                                background: "var(--bg-input)",
                                border: "1px solid var(--bd-7)",
                                color: "var(--c-50)",
                              }}
                            >
                              {d.label}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                );
              })()}
            </div>

            {/* Video clip grid */}
            <div className="px-5 pt-4 pb-[50px]">
              {beats.some((b) => b.videoUrl || b.videoStatus) && (
                <>
                  <ProgressBar value={generatedVideos} total={videoBeats} />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-3 max-h-72 overflow-y-auto">
                    {beats.filter((b) => b.videoPrompt).map((b) => (
                      <div
                        key={b.beatNumber}
                        className="aspect-video rounded-lg overflow-hidden flex items-center justify-center"
                        style={{ background: "var(--bg-progress)" }}
                        onMouseEnter={() => {
                          if (!b.videoUrl) return;
                          if (videoHideTimer.current) clearTimeout(videoHideTimer.current);
                          setHoveredVideoBeat(b);
                        }}
                        onMouseLeave={() => {
                          videoHideTimer.current = setTimeout(() => setHoveredVideoBeat(null), 200);
                        }}
                      >
                        {b.videoUrl ? (
                          <video src={b.videoUrl} title={b.videoUrl} className="w-full h-full object-cover" muted autoPlay loop />
                        ) : (
                          <span className="text-[9px] px-1.5 py-0.5 rounded"
                            title={b.videoStatus === "failed" && b.videoError ? b.videoError : undefined}
                            style={{
                              background: b.videoStatus === "rendering" ? "oklch(0.72 0.25 285 / 0.1)" : b.videoStatus === "done" ? "oklch(0.55 0.15 145 / 0.1)" : b.videoStatus === "failed" ? "oklch(0.6 0.22 25 / 0.1)" : "var(--bg-track)",
                              color: b.videoStatus === "rendering" ? "oklch(0.72 0.25 285)" : b.videoStatus === "done" ? "oklch(0.7 0.15 145)" : b.videoStatus === "failed" ? "oklch(0.7 0.2 25)" : "var(--c-35)",
                              cursor: b.videoStatus === "failed" && b.videoError ? "help" : undefined,
                            }}>
                            {b.videoStatus ?? "—"}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
              <p className="text-xs mt-3" style={{ color: "var(--c-40)" }}>
                {(() => {
                  const workingId = project?.video_model_id as string | undefined;
                  const workingName = videoModels?.find((m) => m.id === workingId)?.name ?? workingId;
                  return workingName ? (
                    <>Using <span style={{ color: "var(--c-65)", fontWeight: 600 }}>{workingName}</span> — clips appear as each job completes.</>
                  ) : (
                    "Runs in background — clips appear as each job completes."
                  );
                })()}
              </p>
              {videosSubmitted && (
                <div className="mt-2">
                  <ProgressBar value={generatedVideos} total={videoBeats} />
                </div>
              )}
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
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all mt-3"
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
                  disabled={!selectedVideoModel || resumingVideos}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all mt-3"
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
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all mt-3"
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
                  disabled={!selectedVideoModel}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all mt-3"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  Re-queue {failedVideos} Clip{failedVideos === 1 ? "" : "s"}
                </button>
              ) : (
                <button
                  onClick={() => queueVideos("all")}
                  disabled={!selectedVideoModel || !pendingVideos || hasActiveVideos}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all mt-3"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  Queue {pendingVideos} Video Clip{pendingVideos === 1 ? "" : "s"}
                </button>
              )}
              {/* Show the secondary "Retry Failed" only when there are also some
                  never-attempted beats — otherwise the primary "Re-queue" already
                  covers the failed-only case. */}
              {failedVideos > 0 && pendingVideos > failedVideos && !hasActiveVideos && !queuingVideos && (
                <button
                  onClick={() => queueVideos("failed")}
                  disabled={!selectedVideoModel}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all mt-2"
                  style={{ background: "transparent", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285)" }}
                >
                  Retry {failedVideos} Failed
                </button>
              )}
            </div>
          </div>
        </div>
        </div>
      </main>

      {/* Fixed bottom bar */}
      {(() => {
        const voiceoverReady = !!ttsUrl;
        const imagesReady = totalBeats > 0 && generatedImages === totalBeats;
        const videosReady = videoBeats === 0 || generatedVideos === videoBeats;
        const canContinue = voiceoverReady && imagesReady && videosReady;
        const missing = [
          !voiceoverReady && "voiceover",
          !imagesReady && "images",
          !videosReady && "video clips",
        ].filter(Boolean).join(", ");

        return (
          <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
            style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
            <div className="px-4 sm:px-8 space-y-2">
              {!canContinue && !navigating && (
                <p className="text-xs text-center" style={{ color: "var(--c-40)" }}>
                  Still needed: {missing}
                </p>
              )}
              <button
                onClick={() => { setNavigating(true); router.push(`/projects/${projectId}/assemble`); }}
                disabled={navigating || !canContinue}
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
        );
      })()}

      {/* Video hover preview */}
      {hoveredVideoBeat?.videoUrl && (
        <div
          className="fixed z-50 rounded-xl overflow-hidden shadow-2xl"
          style={{
            bottom: "2rem",
            right: "2rem",
            width: "320px",
            border: "1px solid var(--bd-10)",
            background: "var(--bg-page-2)",
          }}
          onMouseEnter={() => {
            if (videoHideTimer.current) clearTimeout(videoHideTimer.current);
          }}
          onMouseLeave={() => {
            videoHideTimer.current = setTimeout(() => setHoveredVideoBeat(null), 200);
          }}
        >
          <video
            key={hoveredVideoBeat.videoUrl}
            src={hoveredVideoBeat.videoUrl}
            className="w-full"
            style={{ aspectRatio: "16/9", display: "block" }}
            autoPlay
            loop
            playsInline
            controls
          />
          <div className="px-3 py-2">
            <p className="text-xs font-semibold mb-0.5" style={{ color: "var(--c-55)" }}>
              Beat {hoveredVideoBeat.beatNumber}
            </p>
            <p className="text-xs leading-relaxed line-clamp-3" style={{ color: "var(--c-45)" }}>
              {hoveredVideoBeat.videoPrompt}
            </p>
          </div>
        </div>
      )}

      {/* Image hover preview */}
      {hoveredImageBeat?.imageUrl && (
        <div
          className="fixed z-50 pointer-events-none rounded-xl overflow-hidden shadow-2xl"
          style={{
            bottom: "2rem",
            right: "2rem",
            width: "280px",
            border: "1px solid var(--bd-10)",
            background: "var(--bg-panel)",
          }}
        >
          <img
            src={hoveredImageBeat.imageUrl}
            alt={`Beat ${hoveredImageBeat.beatNumber}`}
            className="w-full object-cover"
            style={{ aspectRatio: "16/9" }}
          />
          <div className="px-3 py-2">
            <p className="text-xs font-semibold mb-0.5" style={{ color: "var(--c-55)" }}>
              Beat {hoveredImageBeat.beatNumber}
            </p>
            <p className="text-xs leading-relaxed line-clamp-3" style={{ color: "var(--c-45)" }}>
              {hoveredImageBeat.imagePrompt}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
