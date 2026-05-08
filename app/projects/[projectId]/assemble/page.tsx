"use client";

import { useState, use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import type { Beat } from "@/lib/types";

interface PageProps {
  params: Promise<{ projectId: string }>;
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
  { id: "classic",  label: "Classic",  hint: "White, black outline" },
  { id: "bold",     label: "Bold",     hint: "Yellow, bold" },
  { id: "boxed",    label: "Boxed",    hint: "White on dark box" },
  { id: "minimal",  label: "Minimal",  hint: "White, thin outline" },
] as const;

const CAPTION_SIZES    = [{ id: "small", label: "S" }, { id: "medium", label: "M" }, { id: "large", label: "L" }] as const;
const CAPTION_POSITIONS = [{ id: "bottom", label: "Bottom" }, { id: "top", label: "Top" }] as const;

export default function AssemblePage({ params }: PageProps) {
  const { projectId } = use(params);
  const router = useRouter();
  const { project } = useProject(projectId);

  const beats: Beat[] = project?.beats ?? [];
  const ttsUrl: string | null = project?.tts_url ?? null;
  const ttsCleanedUrl: string | null = project?.tts_cleaned_url ?? null;
  const generatedVideos = beats.filter((b) => b.videoUrl).length;
  const videoBeats = beats.filter((b) => b.videoPrompt).length;

  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [voiceoverType, setVoiceoverType] = useState<"cleaned" | "original">("cleaned");
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captionsLanguage, setCaptionsLanguage] = useState("source");
  const [captionsStyle, setCaptionsStyle] = useState("classic");
  const [captionsSize, setCaptionsSize] = useState("medium");
  const [captionsPosition, setCaptionsPosition] = useState("bottom");
  const [nextTopic, setNextTopic] = useState("");
  const [extraIdeas, setExtraIdeas] = useState<string[]>([]);
  const [generatingIdeas, setGeneratingIdeas] = useState(false);
  const [creatingNext, setCreatingNext] = useState(false);

  const [assembling, setAssembling] = useState(false);
  const [assembleProgress, setAssembleProgress] = useState<{ current: number; total: number } | null>(null);
  const [assembleStatus, setAssembleStatus] = useState("");
  const [assembledUrl, setAssembledUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!assembling && project?.assembled_url && !assembledUrl) {
      setAssembledUrl(project.assembled_url);
    }
  }, [project, assembling, assembledUrl]);

  // Default to original if no cleaned version exists
  useEffect(() => {
    if (project && !project.tts_cleaned_url) {
      setVoiceoverType("original");
    }
  }, [project?.tts_cleaned_url]);

  const allIdeas: string[] = [...(project?.video_ideas ?? []), ...extraIdeas];

  async function generateMoreIdeas() {
    setGeneratingIdeas(true);
    try {
      const res = await fetch("/api/workflow/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json() as { ideas?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to generate ideas");
      setExtraIdeas((prev) => [...prev, ...(data.ideas ?? [])]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate ideas");
    } finally {
      setGeneratingIdeas(false);
    }
  }

  async function startNextVideo() {
    const topic = nextTopic.trim();
    if (!topic) return;
    setCreatingNext(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fork: {
            channelUrl:        project?.channel_url,
            channelName:       project?.channel_name,
            channelAnalysis:   project?.channel_analysis,
            channelInfo:       project?.channel_info,
            transcripts:       project?.transcripts,
            visualProfile:     project?.visual_profile,
            thumbnailAnalysis: project?.thumbnail_analysis,
            videoIdeas:        allIdeas.filter((idea) => idea !== topic),
            selectedTopic:     topic,
          },
        }),
      });
      const data = await res.json() as { id?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to create project");
      router.push(`/projects/${data.id}/script`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create project");
      setCreatingNext(false);
    }
  }

  async function assembleVideo() {
    if (assembling) return;
    setAssembling(true);
    setAssembledUrl(null);
    setAssembleProgress(null);
    setAssembleStatus("Starting…");
    try {
      const res = await fetch("/api/generate/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, aspectRatio, voiceoverType, captionsEnabled, captionsLanguage, captionsStyle, captionsSize, captionsPosition }),
      });
      if (!res.ok || !res.body) throw new Error("Failed to start assembly");

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
          const event = JSON.parse(line.slice(6)) as {
            type: string; message?: string; current?: number; total?: number; url?: string;
          };
          if (event.type === "status") {
            setAssembleStatus(event.message ?? "");
          } else if (event.type === "progress") {
            setAssembleProgress({ current: event.current ?? 0, total: event.total ?? 0 });
            setAssembleStatus(event.message ?? "");
          } else if (event.type === "done") {
            setAssembledUrl(event.url ?? null);
            toast.success("Video assembled!");
          } else if (event.type === "caption_warn") {
            toast.warning(event.message ?? "Captions could not be applied");
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Assembly failed");
    } finally {
      setAssembling(false);
      setAssembleProgress(null);
      setAssembleStatus("");
    }
  }

  const hasVoiceover = voiceoverType === "original" ? !!ttsUrl : !!(ttsCleanedUrl || ttsUrl);

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={15} highestState={project?.current_state} channelName={project?.channel_name} />

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
              <p className="mt-2 text-sm font-medium" style={{ color: "var(--c-65)" }}>
                {RESOLUTION[aspectRatio]}
              </p>
            </div>
          </div>

          {/* Aspect ratio selector */}
          <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--c-40)" }}>
              Output Aspect Ratio
            </p>
            <div className="flex gap-2">
              {ASPECT_RATIOS.map((r) => (
                <button
                  key={r}
                  onClick={() => setAspectRatio(r)}
                  disabled={assembling}
                  className="px-4 py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                  style={aspectRatio === r ? {
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
          </div>

          {/* Voiceover selector */}
          <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--c-40)" }}>
              Voiceover Source
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setVoiceoverType("cleaned")}
                disabled={assembling || !ttsCleanedUrl}
                className="flex-1 py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-35"
                style={voiceoverType === "cleaned" && ttsCleanedUrl ? {
                  background: "oklch(0.72 0.25 285 / 0.15)",
                  border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                  color: "oklch(0.88 0.12 285)",
                } : {
                  background: "var(--bg-input)",
                  border: "1px solid var(--bd-7)",
                  color: ttsCleanedUrl ? "var(--c-50)" : "var(--c-30)",
                }}
              >
                Trimmed{ttsCleanedUrl ? " ✓" : " — unavailable"}
              </button>
              <button
                onClick={() => setVoiceoverType("original")}
                disabled={assembling || !ttsUrl}
                className="flex-1 py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-35"
                style={voiceoverType === "original" ? {
                  background: "oklch(0.72 0.25 285 / 0.15)",
                  border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                  color: "oklch(0.88 0.12 285)",
                } : {
                  background: "var(--bg-input)",
                  border: "1px solid var(--bd-7)",
                  color: ttsUrl ? "var(--c-50)" : "var(--c-30)",
                }}
              >
                Original{ttsUrl ? "" : " — unavailable"}
              </button>
            </div>
          </div>

          {/* Captions */}
          <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold">Captions</p>
                <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                  Burned into the video — always visible
                </p>
              </div>
              <button
                onClick={() => setCaptionsEnabled((v) => !v)}
                disabled={assembling}
                className="relative w-11 h-6 rounded-full transition-all disabled:opacity-40 shrink-0"
                style={{ background: captionsEnabled ? "oklch(0.72 0.25 285)" : "var(--c-22)", border: "1px solid var(--bd-10)" }}
              >
                <span
                  className="absolute top-0.5 w-5 h-5 rounded-full transition-all"
                  style={{
                    background: "oklch(0.95 0 0)",
                    left: captionsEnabled ? "calc(100% - 1.375rem)" : "0.125rem",
                  }}
                />
              </button>
            </div>

            {captionsEnabled && (
              <div className="space-y-4">
                {/* Style */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Style</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {CAPTION_STYLES.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => setCaptionsStyle(s.id)}
                        disabled={assembling}
                        className="py-2 px-3 rounded-xl text-left transition-all disabled:opacity-40"
                        style={captionsStyle === s.id ? {
                          background: "oklch(0.72 0.25 285 / 0.15)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                        } : {
                          background: "var(--bg-input)",
                          border: "1px solid var(--bd-7)",
                        }}
                      >
                        <p className="text-xs font-medium" style={{ color: captionsStyle === s.id ? "oklch(0.88 0.12 285)" : "var(--c-60)" }}>{s.label}</p>
                        <p className="text-xs mt-0.5" style={{ color: "var(--c-38)" }}>{s.hint}</p>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Size + Position */}
                <div className="flex gap-4">
                  <div className="flex-1">
                    <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Size</p>
                    <div className="flex gap-1.5">
                      {CAPTION_SIZES.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => setCaptionsSize(s.id)}
                          disabled={assembling}
                          className="flex-1 py-1.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-40"
                          style={captionsSize === s.id ? {
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                            color: "oklch(0.88 0.12 285)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-7)",
                            color: "var(--c-50)",
                          }}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex-1">
                    <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Position</p>
                    <div className="flex gap-1.5">
                      {CAPTION_POSITIONS.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => setCaptionsPosition(p.id)}
                          disabled={assembling}
                          className="flex-1 py-1.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                          style={captionsPosition === p.id ? {
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                            color: "oklch(0.88 0.12 285)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-7)",
                            color: "var(--c-50)",
                          }}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Language */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Language</p>
                  <div className="flex flex-wrap gap-1.5">
                    {CAPTION_LANGUAGES.map((lang) => (
                      <button
                        key={lang.code}
                        onClick={() => setCaptionsLanguage(lang.code)}
                        disabled={assembling}
                        className="px-3 py-1.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                        style={captionsLanguage === lang.code ? {
                          background: "oklch(0.72 0.25 285 / 0.15)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                          color: "oklch(0.88 0.12 285)",
                        } : {
                          background: "var(--bg-input)",
                          border: "1px solid var(--bd-7)",
                          color: "var(--c-50)",
                        }}
                      >
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
            {assembling && (
              <div className="space-y-2">
                <p className="text-xs text-center" style={{ color: "var(--c-55)" }}>{assembleStatus}</p>
                {assembleProgress && (
                  <ProgressBar value={assembleProgress.current} total={assembleProgress.total} />
                )}
              </div>
            )}

            {assembledUrl && !assembling && (
              <div className="space-y-3">
                <video
                  key={assembledUrl}
                  src={assembledUrl}
                  controls
                  className="w-full rounded-xl"
                  style={{ background: "var(--bg-page-2)" }}
                />
                <div className="flex gap-2">
                  <a
                    href={assembledUrl}
                    download="assembled.mp4"
                    className="flex-1 py-2.5 rounded-xl text-xs font-medium text-center transition-all"
                    style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}
                  >
                    ↓ Download MP4
                  </a>
                  <button
                    onClick={assembleVideo}
                    className="px-5 py-2.5 rounded-xl text-xs font-medium transition-all"
                    style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}
                  >
                    Reassemble
                  </button>
                </div>
              </div>
            )}

            {!assembledUrl && !assembling && (
              <>
                {!hasVoiceover && (
                  <p className="text-xs text-center py-1" style={{ color: "var(--c-40)" }}>
                    Generate a voiceover on the Generate page first.
                  </p>
                )}
                <button
                  onClick={assembleVideo}
                  disabled={!hasVoiceover}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  Assemble Final Video
                </button>
              </>
            )}

            {assembling && !assembleProgress && (
              <p className="text-xs text-center" style={{ color: "var(--c-35)" }}>
                Transcribing voiceover for frame-accurate sync…
              </p>
            )}
          </div>

          </div>{/* end left column */}

          {/* ── Right sticky sidebar: Next Video ──────────────────────────── */}
          {assembledUrl && !assembling && (
            <div className="w-80 shrink-0 sticky top-8">
              <div className="rounded-2xl p-5 space-y-4" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <div>
                  <p className="text-sm font-semibold">Start Your Next Video</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                    Same channel — pick a topic and jump straight to the script
                  </p>
                </div>

                {/* Idea list */}
                {allIdeas.length > 0 && (
                  <div className="space-y-1 max-h-52 overflow-y-auto pr-0.5">
                    {allIdeas.map((idea, i) => (
                      <button
                        key={i}
                        onClick={() => setNextTopic(idea)}
                        className="w-full text-left px-3 py-2.5 rounded-xl text-xs transition-all"
                        style={nextTopic === idea ? {
                          background: "oklch(0.72 0.25 285 / 0.12)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.35)",
                          color: "var(--c-90)",
                        } : {
                          background: "var(--bg-input)",
                          border: "1px solid var(--bd-7)",
                          color: "var(--c-55)",
                        }}
                      >
                        <span className="font-mono text-[9px] mr-2 shrink-0"
                          style={{ color: "oklch(0.72 0.25 285 / 0.5)" }}>
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        {idea}
                      </button>
                    ))}
                  </div>
                )}

                {/* Custom topic input */}
                <input
                  type="text"
                  value={nextTopic}
                  onChange={(e) => setNextTopic(e.target.value)}
                  placeholder={allIdeas.length > 0 ? "Or type a custom topic…" : "Type your next topic…"}
                  className="w-full px-3 py-2.5 rounded-xl text-sm outline-none transition-all"
                  style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
                />

                {/* Actions */}
                <div className="flex flex-col gap-2">
                  <button
                    onClick={startNextVideo}
                    disabled={!nextTopic.trim() || creatingNext}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                  >
                    {creatingNext ? "Creating…" : "Start Next Video →"}
                  </button>
                  <button
                    onClick={generateMoreIdeas}
                    disabled={generatingIdeas || !project?.channel_analysis}
                    className="w-full py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                    style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}
                  >
                    {generatingIdeas ? "Generating…" : "Generate More Ideas"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
