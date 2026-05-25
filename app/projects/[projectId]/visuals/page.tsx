"use client";

import { useState, use, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";

interface PageProps {
  params: { projectId: string };
}

type Mode = "auto" | "manual";
type StepStatus = "idle" | "running" | "done" | "error";

interface AutoShot {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  frameUrls: string[];
}

function StepRow({ label, sublabel, status }: { label: string; sublabel: string; status: StepStatus }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-sm"
        style={
          status === "done" ? { background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.7 0.15 145)" } :
          status === "running" ? { background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" } :
          status === "error" ? { background: "oklch(0.6 0.22 25 / 0.12)", color: "oklch(0.7 0.2 25)" } :
          { background: "var(--bg-progress)", color: "var(--c-35)" }
        }
      >
        {status === "done" ? "✓" :
         status === "running" ? <span className="block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" /> :
         status === "error" ? "✕" : "○"}
      </div>
      <div>
        <p className="text-sm font-medium" style={{ color: status === "idle" ? "var(--c-40)" : "var(--c-85)" }}>{label}</p>
        <p className="text-xs" style={{ color: "var(--c-40)" }}>{sublabel}</p>
      </div>
    </div>
  );
}

function SelectableImage({
  url, selected, onToggle, label,
}: { url: string; selected: boolean; onToggle: () => void; label?: string }) {
  return (
    <button
      onClick={onToggle}
      className="relative rounded-xl overflow-hidden transition-all group"
      style={{
        border: `2px solid ${selected ? "oklch(0.72 0.25 285)" : "var(--bd-8)"}`,
        boxShadow: selected ? "0 0 12px oklch(0.72 0.25 285 / 0.3)" : "none",
      }}
    >
      <img src={url} alt={label ?? ""} className="w-full aspect-video object-cover" />
      {/* Selected overlay */}
      <div className="absolute inset-0 transition-all"
        style={{ background: selected ? "oklch(0.72 0.25 285 / 0.12)" : "transparent" }} />
      {/* Checkmark */}
      {selected && (
        <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
          style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
          ✓
        </div>
      )}
      {label && (
        <div className="absolute bottom-0 inset-x-0 px-2 py-1 text-xs truncate"
          style={{ background: "oklch(0.06 0 0 / 0.8)", color: "var(--c-60)" }}>
          {label}
        </div>
      )}
    </button>
  );
}

export default function VisualsPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project } = useProject(projectId);

  const [mode, setMode] = useState<Mode>("auto");
  const [navigating, setNavigating] = useState(false);

  // Auto screenshot state
  const [fetching, setFetching] = useState(false);
  const [autoShots, setAutoShots] = useState<AutoShot[]>([]);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());

  // Manual upload state
  const [videoImages, setVideoImages] = useState<File[]>([]);
  const [thumbnailImages, setThumbnailImages] = useState<File[]>([]);

  // Analysis state
  const [steps, setSteps] = useState<{ upload: StepStatus; analyze: StepStatus }>({ upload: "idle", analyze: "idle" });
  const [visualProfile, setVisualProfile] = useState<Record<string, unknown> | null>(null);

  const videoInputRef = useRef<HTMLInputElement>(null);
  const thumbInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (project?.visual_profile) setVisualProfile(project.visual_profile);
  }, [project]);

  const topVideos: { videoId: string; title: string }[] =
    (project?.channel_info as { topVideos?: { videoId: string; title: string }[] } | undefined)?.topVideos ?? [];

  async function fetchScreenshots() {
    if (!topVideos.length) { toast.error("No videos found — complete Channel Setup first"); return; }
    setFetching(true);
    setAutoShots([]);
    setSelectedImages(new Set());
    try {
      const res = await fetch("/api/youtube/screenshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: topVideos, projectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setAutoShots(data.screenshots);

      // Auto-select all unique images by default
      const all = new Set<string>();
      for (const shot of data.screenshots as AutoShot[]) {
        if (shot.thumbnailUrl) all.add(shot.thumbnailUrl);
        for (const f of shot.frameUrls) all.add(f);
      }
      setSelectedImages(all);
      toast.success(`Fetched screenshots from ${data.screenshots.length} videos`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to fetch screenshots");
    } finally {
      setFetching(false);
    }
  }

  function toggleImage(url: string) {
    setSelectedImages((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }

  function setStep(key: keyof typeof steps, status: StepStatus) {
    setSteps((prev) => ({ ...prev, [key]: status }));
  }

  async function uploadFileToSupabase(file: File, folder: string): Promise<string> {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("projectId", projectId);
    formData.append("folder", folder);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.url as string;
  }

  async function analyzeVisuals() {
    let videoImageUrls: string[];
    let thumbnailImageUrls: string[];

    if (mode === "auto") {
      if (selectedImages.size < 3) { toast.error("Select at least 3 images"); return; }
      const thumbUrlSet = new Set(autoShots.map((s) => s.thumbnailUrl).filter(Boolean));
      videoImageUrls = [...selectedImages].filter((u) => !thumbUrlSet.has(u));
      thumbnailImageUrls = [...selectedImages].filter((u) => thumbUrlSet.has(u));
      setStep("upload", "done"); // already uploaded during fetch
    } else {
      if (videoImages.length < 3) { toast.error("Upload at least 3 video screenshots"); return; }
      setStep("upload", "running");
      try {
        videoImageUrls = await Promise.all(videoImages.map((f) => uploadFileToSupabase(f, "visual-refs")));
        thumbnailImageUrls = await Promise.all(thumbnailImages.map((f) => uploadFileToSupabase(f, "thumbnail-refs")));
        setStep("upload", "done");
      } catch (err) {
        setStep("upload", "error");
        toast.error(err instanceof Error ? err.message : "Upload failed");
        return;
      }
    }

    setStep("analyze", "running");
    try {
      const res = await fetch("/api/workflow/visual-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, videoImageUrls, thumbnailImageUrls }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setVisualProfile(data.visualProfile);
      setStep("analyze", "done");
      toast.success("Visual style extracted!");
    } catch (err) {
      setStep("analyze", "error");
      toast.error(err instanceof Error ? err.message : "Analysis failed");
    }
  }

  const analyzing = steps.upload === "running" || steps.analyze === "running";
  const canAnalyze = !analyzing && (
    mode === "auto" ? selectedImages.size >= 3 : videoImages.length >= 3
  );

  const totalSelected = selectedImages.size;

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={7} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 overflow-y-auto pt-[105px] md:pt-0">
        {/* Header */}
        <div className="px-4 sm:px-8 py-4 sm:py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div className="flex items-start sm:items-center justify-between gap-3">
            <div>
              <h1 className="font-bold text-base sm:text-lg">Visual Style Extraction</h1>
              <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                Upload or auto-capture screenshots so Claude can extract the channel&apos;s visual signature
              </p>
            </div>
            {visualProfile && (
              <button
                onClick={() => { setNavigating(true); router.push(`/projects/${projectId}/prompts`); }}
                disabled={navigating}
                className="shrink-0 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold disabled:opacity-60 transition-all"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                {navigating ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Loading…
                  </span>
                ) : "Continue →"}
              </button>
            )}
          </div>
        </div>

        <div className="p-4 sm:p-8 pb-24 sm:pb-24 max-w-4xl mx-auto space-y-6">
          {/* Mode toggle */}
          <div className="flex gap-2 p-1 rounded-xl"
            style={{ background: "var(--bg-elevated)", border: "1px solid var(--bd-7)" }}>
            {(["auto", "manual"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="flex-1 px-3 sm:px-5 py-2 rounded-lg text-sm font-medium transition-all"
                style={mode === m ? {
                  background: "oklch(0.72 0.25 285)",
                  color: "var(--bg-page-2)",
                } : {
                  color: "var(--c-50)",
                }}
              >
                {m === "auto" ? "⚡ Auto Screenshot" : "↑ Manual Upload"}
              </button>
            ))}
          </div>

          {/* AUTO MODE */}
          {mode === "auto" && (
            <div className="space-y-5">
              {/* Fetch button */}
              <div className="rounded-2xl p-5"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <p className="font-semibold text-sm">Auto-capture from Channel Videos</p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                      Fetches thumbnails + 3 frame stills from each of the top {topVideos.length || "10"} videos
                    </p>
                  </div>
                  <button
                    onClick={fetchScreenshots}
                    disabled={fetching || !topVideos.length}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-all"
                    style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                  >
                    {fetching ? (
                      <>
                        <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                        Fetching...
                      </>
                    ) : (
                      <>⚡ Fetch Screenshots</>
                    )}
                  </button>
                </div>

                {/* Info about what it does */}
                {!autoShots.length && !fetching && (
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {[
                      { icon: "◎", label: "Thumbnail images", desc: "Official YouTube thumbnail per video" },
                      { icon: "◈", label: "Video frame stills", desc: "3 auto-frames from ~25%, 50%, 75% of each video" },
                      { icon: "✦", label: "Style extraction", desc: "Claude analyzes colors, lighting, mood, composition" },
                    ].map((item) => (
                      <div key={item.label} className="p-3 rounded-xl"
                        style={{ background: "oklch(0.09 0 0)", border: "1px solid var(--bd-6)" }}>
                        <span className="text-base" style={{ color: "oklch(0.72 0.25 285)" }}>{item.icon}</span>
                        <p className="font-medium text-xs mt-2 mb-0.5">{item.label}</p>
                        <p className="text-xs" style={{ color: "var(--c-40)" }}>{item.desc}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Fetched screenshots grid */}
              {autoShots.length > 0 && (() => {
                const allImages = [...new Set(autoShots.flatMap((s) => [
                  ...(s.thumbnailUrl ? [s.thumbnailUrl] : []),
                  ...s.frameUrls,
                ]))];
                return (
                  <div className="space-y-5">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">
                        Select images for analysis
                        <span className="ml-2 text-xs font-normal" style={{ color: "var(--c-45)" }}>
                          {totalSelected} selected
                        </span>
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setSelectedImages(new Set(allImages))}
                          className="text-xs px-3 py-1 rounded-lg"
                          style={{ background: "var(--bg-progress)", color: "var(--c-55)", border: "1px solid var(--bd-7)" }}
                        >
                          Select all
                        </button>
                        <button
                          onClick={() => setSelectedImages(new Set())}
                          className="text-xs px-3 py-1 rounded-lg"
                          style={{ background: "var(--bg-progress)", color: "var(--c-55)", border: "1px solid var(--bd-7)" }}
                        >
                          Clear all
                        </button>
                      </div>
                    </div>

                    <div className="rounded-2xl overflow-hidden"
                      style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                      <div className="px-5 py-3 flex items-center gap-2"
                        style={{ borderBottom: "1px solid var(--bd-6)" }}>
                        <span style={{ color: "oklch(0.72 0.25 285)" }}>◈</span>
                        <p className="text-xs font-semibold">Captured Images</p>
                      </div>
                      <div className="p-5">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          {allImages.map((url, i) => (
                            <SelectableImage
                              key={url}
                              url={url}
                              selected={selectedImages.has(url)}
                              onToggle={() => toggleImage(url)}
                              label={`Image ${i + 1}`}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* MANUAL MODE */}
          {mode === "manual" && (
            <div className="space-y-5">
              {/* Video screenshots */}
              <div className="rounded-2xl overflow-hidden"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <div className="px-5 py-4 flex items-center justify-between"
                  style={{ borderBottom: "1px solid var(--bd-6)" }}>
                  <div>
                    <p className="font-semibold text-sm">Video Screenshots</p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>3–5 frames from actual videos</p>
                  </div>
                  <div className="px-2.5 py-1 rounded-full text-xs font-medium"
                    style={{
                      background: videoImages.length >= 3 ? "oklch(0.55 0.15 145 / 0.1)" : "var(--bg-progress)",
                      color: videoImages.length >= 3 ? "oklch(0.7 0.15 145)" : "var(--c-45)",
                      border: `1px solid ${videoImages.length >= 3 ? "oklch(0.55 0.15 145 / 0.3)" : "var(--bd-6)"}`,
                    }}>
                    {videoImages.length} / 5
                  </div>
                </div>
                <div className="p-5 space-y-4">
                  <div
                    onClick={() => videoInputRef.current?.click()}
                    className="rounded-xl p-6 text-center cursor-pointer transition-all"
                    style={{ border: "1.5px dashed var(--bd-10)", background: "oklch(0.09 0 0)" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.3)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-10)"; }}
                  >
                    <p className="text-sm" style={{ color: "var(--c-50)" }}>
                      Drop images here or <span style={{ color: "oklch(0.72 0.25 285)" }}>click to upload</span>
                    </p>
                    <p className="text-xs mt-1" style={{ color: "var(--c-35)" }}>PNG, JPG, WEBP · up to 5</p>
                  </div>
                  <input ref={videoInputRef} type="file" accept="image/*" multiple className="hidden"
                    onChange={(e) => setVideoImages(Array.from(e.target.files ?? []).slice(0, 5))} />
                  {videoImages.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {videoImages.map((f, i) => (
                        <div key={i} className="relative aspect-video rounded-lg overflow-hidden"
                          style={{ border: "1px solid var(--bd-10)" }}>
                          <img src={URL.createObjectURL(f)} alt="" className="w-full h-full object-cover" />
                          <button
                            onClick={() => setVideoImages((p) => p.filter((_, j) => j !== i))}
                            className="absolute top-1 right-1 w-4 h-4 rounded-full flex items-center justify-center text-xs"
                            style={{ background: "var(--bg-overlay)", color: "white" }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Thumbnails */}
              <div className="rounded-2xl overflow-hidden"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <div className="px-5 py-4 flex items-center justify-between"
                  style={{ borderBottom: "1px solid var(--bd-6)" }}>
                  <div>
                    <p className="font-semibold text-sm">Thumbnail Images <span className="text-xs font-normal" style={{ color: "var(--c-45)" }}>(optional)</span></p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>2–3 thumbnails for style matching</p>
                  </div>
                  <div className="px-2.5 py-1 rounded-full text-xs"
                    style={{ background: "var(--bg-progress)", color: "var(--c-45)", border: "1px solid var(--bd-6)" }}>
                    {thumbnailImages.length} / 3
                  </div>
                </div>
                <div className="p-5 space-y-4">
                  <div
                    onClick={() => thumbInputRef.current?.click()}
                    className="rounded-xl p-5 text-center cursor-pointer transition-all"
                    style={{ border: "1.5px dashed var(--bd-10)", background: "oklch(0.09 0 0)" }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.3)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-10)"; }}
                  >
                    <p className="text-sm" style={{ color: "var(--c-50)" }}>
                      Drop thumbnails or <span style={{ color: "oklch(0.72 0.25 285)" }}>click to upload</span>
                    </p>
                  </div>
                  <input ref={thumbInputRef} type="file" accept="image/*" multiple className="hidden"
                    onChange={(e) => setThumbnailImages(Array.from(e.target.files ?? []).slice(0, 3))} />
                  {thumbnailImages.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {thumbnailImages.map((f, i) => (
                        <div key={i} className="relative aspect-video rounded-lg overflow-hidden"
                          style={{ border: "1px solid var(--bd-10)" }}>
                          <img src={URL.createObjectURL(f)} alt="" className="w-full h-full object-cover" />
                          <button
                            onClick={() => setThumbnailImages((p) => p.filter((_, j) => j !== i))}
                            className="absolute top-1 right-1 w-4 h-4 rounded-full flex items-center justify-center text-xs"
                            style={{ background: "var(--bg-overlay)", color: "white" }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Analysis progress */}
          {(analyzing || steps.analyze === "done" || steps.analyze === "error") && (
            <div className="rounded-2xl p-5 space-y-4"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
                Analysis Progress
              </p>
              <div className="space-y-3">
                {mode === "manual" && (
                  <StepRow label="Upload images" sublabel="Storing to cloud storage" status={steps.upload} />
                )}
                <StepRow label="Extract visual style" sublabel="Claude analyzes art direction, lighting, mood, composition" status={steps.analyze} />
              </div>
            </div>
          )}

          {/* Analyze button */}
          {!visualProfile && (
            <button
              onClick={analyzeVisuals}
              disabled={!canAnalyze}
              className="w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
              style={{ background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))", color: "var(--bg-page-2)" }}
            >
              {analyzing ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Analyzing…
                </span>
              ) : mode === "auto" && !autoShots.length ? "Fetch screenshots first" :
               `Analyze ${mode === "auto" ? `${totalSelected} selected images` : "Visual Style"}`}
            </button>
          )}

          {/* Visual profile result */}
          {visualProfile && (
            <div className="rounded-2xl overflow-hidden"
              style={{ background: "var(--bg-panel)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }}>
              <div className="px-5 py-4 flex items-center gap-2"
                style={{ borderBottom: "1px solid var(--bd-6)", background: "oklch(0.55 0.15 145 / 0.06)" }}>
                <span style={{ color: "oklch(0.7 0.15 145)" }}>✓</span>
                <p className="font-semibold text-sm" style={{ color: "oklch(0.7 0.15 145)" }}>
                  Visual Style Profile Extracted
                </p>
              </div>
              <div className="p-5 grid grid-cols-2 gap-4">
                {[
                  { label: "Art Style", value: (visualProfile as Record<string, string>).artStyle },
                  { label: "Lighting", value: (visualProfile as Record<string, string>).lightingStyle },
                  { label: "Camera", value: (visualProfile as Record<string, string>).cameraStyle },
                  { label: "Mood", value: (visualProfile as Record<string, string>).mood },
                ].map(({ label, value }) => value ? (
                  <div key={label}>
                    <p className="text-xs mb-1" style={{ color: "var(--c-45)" }}>{label}</p>
                    <p className="text-sm" style={{ color: "oklch(0.8 0 0)" }}>{value}</p>
                  </div>
                ) : null)}
                {Array.isArray((visualProfile as Record<string, unknown>).colorPalette) && (
                  <div className="col-span-2">
                    <p className="text-xs mb-2" style={{ color: "var(--c-45)" }}>Color Palette</p>
                    <div className="flex gap-2 flex-wrap">
                      {((visualProfile as Record<string, unknown>).colorPalette as string[]).map((c, i) => (
                        <span key={i} className="px-2.5 py-1 rounded-lg text-xs"
                          style={{ background: "var(--bg-progress)", color: "var(--c-70)", border: "1px solid var(--bd-8)" }}>
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="px-5 pb-5">
                <button
                  onClick={() => { setNavigating(true); router.push(`/projects/${projectId}/prompts`); }}
                  disabled={navigating}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  {navigating ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Loading…
                    </span>
                  ) : "Generate All Prompts →"}
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
