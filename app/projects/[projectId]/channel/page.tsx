"use client";

import { useState, use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProject";
import type { ChannelInfo } from "@/lib/types";
import type { SupadataTranscript } from "@/lib/youtube/supadata";

interface PageProps {
  params: { projectId: string };
}

type StepStatus = "idle" | "running" | "done" | "error";

interface AnalysisStep {
  id: string;
  label: string;
  sublabel: string;
  status: StepStatus;
}

function StepIndicator({ step }: { step: AnalysisStep }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm"
        style={{
          background: step.status === "done" ? "oklch(0.55 0.15 145 / 0.2)"
            : step.status === "running" ? "oklch(0.72 0.25 285 / 0.15)"
            : step.status === "error" ? "oklch(0.6 0.22 25 / 0.2)"
            : "var(--bg-track)",
          border: `1px solid ${step.status === "done" ? "oklch(0.55 0.15 145 / 0.4)"
            : step.status === "running" ? "oklch(0.72 0.25 285 / 0.4)"
            : step.status === "error" ? "oklch(0.6 0.22 25 / 0.4)"
            : "var(--c-25)"}`,
          color: step.status === "done" ? "oklch(0.7 0.15 145)"
            : step.status === "running" ? "oklch(0.72 0.25 285)"
            : step.status === "error" ? "oklch(0.7 0.22 25)"
            : "var(--c-40)",
        }}
      >
        {step.status === "done" ? "✓"
          : step.status === "running" ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
          : step.status === "error" ? "✕"
          : "○"}
      </div>
      <div>
        <p className="text-sm font-medium" style={{
          color: step.status === "idle" ? "var(--c-45)" : "var(--c-90)"
        }}>
          {step.label}
        </p>
        {step.sublabel && <p className="text-xs" style={{ color: "var(--c-45)" }}>{step.sublabel}</p>}
      </div>
    </div>
  );
}

export default function ChannelPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project } = useProject(projectId === "new" ? null : projectId);

  const [channelUrl, setChannelUrl] = useState("");
  const [channelInfo, setChannelInfo] = useState<ChannelInfo | null>(null);
  const [transcripts, setTranscripts] = useState<SupadataTranscript[]>([]);
  const [topicMode, setTopicMode] = useState<"generate" | "custom">("generate");
  const [topicHint, setTopicHint] = useState("");
  const [customTopic, setCustomTopic] = useState("");
  const [isWorking, setIsWorking] = useState(false);

  const [steps, setSteps] = useState<AnalysisStep[]>([
    { id: "channel", label: "Scanning", sublabel: "", status: "idle" },
    { id: "transcripts", label: "Processing", sublabel: "", status: "idle" },
    { id: "analyze", label: "Refining", sublabel: "", status: "idle" },
    { id: "dna", label: "Finalising", sublabel: "", status: "idle" },
  ]);

  function setStep(id: string, status: StepStatus) {
    setSteps((prev) => prev.map((s) => s.id === id ? { ...s, status } : s));
  }

  // Load saved data if project has channel info
  useEffect(() => {
    if (project?.channel_info && !channelInfo) {
      setChannelInfo(project.channel_info);
    }
    if (project?.channel_url && !channelUrl) {
      setChannelUrl(project.channel_url);
    }
  }, [project]);

  async function runFullAnalysis() {
    if (!channelUrl.trim()) return;
    setIsWorking(true);
    setSteps((prev) => prev.map((s) => ({ ...s, status: "idle" })));

    let fetchedInfo: ChannelInfo | null = null;
    let fetchedTranscripts: SupadataTranscript[] = [];

    // Step 1: Fetch channel
    setStep("channel", "running");
    try {
      const res = await fetch("/api/youtube/channel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      fetchedInfo = data;
      setChannelInfo(data);
      setStep("channel", "done");
    } catch (err) {
      setStep("channel", "error");
      toast.error(err instanceof Error ? err.message : "Failed to fetch channel");
      setIsWorking(false);
      return;
    }

    // Step 2: Fetch video metadata
    setStep("transcripts", "running");
    if (!fetchedInfo!.topVideos.length) {
      setStep("transcripts", "error");
      toast.error("No videos found for this channel");
      setIsWorking(false);
      return;
    } else {
      try {
        const res = await fetch("/api/youtube/transcripts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videos: fetchedInfo!.topVideos }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `Transcript fetch failed (${res.status})`);
        fetchedTranscripts = data.transcripts;
        setTranscripts(data.transcripts);
        setStep("transcripts", "done");
      } catch (err) {
        setStep("transcripts", "error");
        const msg = err instanceof Error ? err.message : "Transcript fetch failed";
        toast.error(`Transcripts: ${msg}`);
        setIsWorking(false);
        return;
      }
    }

    // Steps 3-4: Claude analysis
    const readyTranscripts = fetchedTranscripts.length ? fetchedTranscripts : transcripts;
    if (!readyTranscripts.length) {
      setIsWorking(false);
      toast.error("No transcripts available. Try again.");
      return;
    }

    const topic = topicMode === "custom" ? customTopic.trim() : undefined;
    if (topicMode === "custom" && !topic) {
      setIsWorking(false);
      toast.error("Enter a topic first");
      return;
    }

    // Create the project record now that the first step succeeded
    let effectiveProjectId = projectId;
    if (projectId === "new") {
      const createRes = await fetch("/api/projects", { method: "POST" });
      const created = await createRes.json();
      if (createRes.status === 403 && created.limitReached) {
        toast.error("You've reached your niche limit. Upgrade your plan to add more.");
        setIsWorking(false);
        return;
      }
      if (!created.id) {
        toast.error("Failed to create project");
        setIsWorking(false);
        return;
      }
      effectiveProjectId = created.id;
    }

    // Save channel to project
    await fetch(`/api/projects/${effectiveProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_url: channelUrl,
        channel_name: fetchedInfo!.channelName,
        channel_info: fetchedInfo,
      }),
    });

    setStep("analyze", "running");
    await new Promise((r) => setTimeout(r, 300));
    setStep("dna", "running");

    try {
      const res = await fetch("/api/workflow/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: effectiveProjectId,
          transcripts: readyTranscripts,
          topicMode,
          topicHint: topicHint.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (topicMode === "custom" && topic) {
        await fetch(`/api/projects/${effectiveProjectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selected_topic: topic }),
        });
      }

      setStep("analyze", "done");
      setStep("dna", "done");
      await new Promise((r) => setTimeout(r, 400));
      router.push(`/projects/${effectiveProjectId}/topic`);
    } catch (err) {
      setStep("analyze", "error");
      setStep("dna", "error");
      toast.error(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setIsWorking(false);
    }
  }

  const allDone = steps.every((s) => s.status === "done");
  const hasError = steps.some((s) => s.status === "error");
  const isRunning = steps.some((s) => s.status === "running");

  return (
    <div className="flex h-screen overflow-x-hidden">
      <WizardNav projectId={projectId} currentState={1} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 min-w-0 overflow-y-auto pt-[105px] md:pt-0">
        <div className="max-w-2xl mx-auto px-4 sm:px-8 pt-6 sm:pt-10 pb-24 space-y-8">

          {/* Header */}
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Channel Setup</h1>
            <p className="text-sm mt-1" style={{ color: "var(--c-50)" }}>
              Enter a YouTube channel URL to automatically extract style DNA and generate content.
            </p>
          </div>

          {/* URL input card */}
          <div className="rounded-2xl p-6 space-y-5"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                YouTube Channel URL
              </label>
              <div className="flex gap-3">
                <input
                  type="text"
                  placeholder="https://youtube.com/@channelname"
                  value={channelUrl}
                  onChange={(e) => setChannelUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !isWorking && runFullAnalysis()}
                  className="flex-1 min-w-0 px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                  style={{
                    background: "var(--bg-progress)",
                    border: "1px solid var(--bd-8)",
                    color: "var(--c-90)",
                  }}
                  onFocus={(e) => { (e.target as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.4)"; }}
                  onBlur={(e) => { (e.target as HTMLElement).style.borderColor = "var(--bd-8)"; }}
                />
                <button
                  onClick={runFullAnalysis}
                  disabled={isWorking || !channelUrl.trim()}
                  className="shrink-0 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                  style={{
                    background: "oklch(0.72 0.25 285)",
                    color: "var(--bg-page-2)",
                    boxShadow: isWorking ? "none" : "0 0 16px oklch(0.72 0.25 285 / 0.3)"
                  }}
                >
                  {isWorking ? (
                    <span className="flex items-center gap-2">
                      <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Running…
                    </span>
                  ) : "Analyze"}
                </button>
              </div>
            </div>

            {/* Topic selection */}
            <div className="space-y-3">
              <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                Topic Strategy
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(["generate", "custom"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setTopicMode(mode)}
                    className="px-4 py-2.5 rounded-xl text-sm text-left transition-all"
                    style={{
                      background: topicMode === mode ? "oklch(0.72 0.25 285 / 0.12)" : "var(--bg-progress)",
                      border: `1px solid ${topicMode === mode ? "oklch(0.72 0.25 285 / 0.3)" : "var(--bd-8)"}`,
                      color: topicMode === mode ? "oklch(0.72 0.25 285)" : "var(--c-55)",
                    }}
                  >
                    <p className="font-medium">{mode === "generate" ? "Generate Ideas" : "Custom Topic"}</p>
                    <p className="text-xs mt-0.5 opacity-70">
                      {mode === "generate" ? "AI creates 25 video ideas" : "I already have a topic"}
                    </p>
                  </button>
                ))}
              </div>

              {topicMode === "generate" && (
                <input
                  type="text"
                  placeholder="Optional topic direction hint (e.g. 'faith and perseverance')"
                  value={topicHint}
                  onChange={(e) => setTopicHint(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                  style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-8)", color: "var(--c-90)" }}
                />
              )}

              {topicMode === "custom" && (
                <input
                  type="text"
                  placeholder="Enter your video topic"
                  value={customTopic}
                  onChange={(e) => setCustomTopic(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                  style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-8)", color: "var(--c-90)" }}
                />
              )}
            </div>
          </div>

          {/* Analysis progress */}
          {(isWorking || steps.some((s) => s.status !== "idle")) && (
            <div className="rounded-2xl p-6 space-y-4"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                Analysis Progress
              </p>
              <div className="space-y-4">
                {steps.map((step, i) => (
                  <div key={step.id}>
                    <StepIndicator step={step} />
                    {i < steps.length - 1 && (
                      <div className="ml-4 mt-1 mb-1 w-px h-3"
                        style={{ background: step.status === "done" ? "oklch(0.55 0.15 145 / 0.3)" : "var(--c-22)" }} />
                    )}
                  </div>
                ))}
              </div>

              {allDone && (
                <div className="mt-2 px-3 py-2 rounded-lg text-sm text-center"
                  style={{ background: "oklch(0.55 0.15 145 / 0.1)", border: "1px solid oklch(0.55 0.15 145 / 0.2)", color: "oklch(0.7 0.15 145)" }}>
                  Analysis complete — redirecting to script editor...
                </div>
              )}
              {hasError && !isRunning && (
                <div className="mt-2 px-3 py-2 rounded-lg text-sm"
                  style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.2)", color: "oklch(0.7 0.22 25)" }}>
                  Some steps failed. Check the errors above and try again.
                </div>
              )}
            </div>
          )}

          {/* Channel info card (after fetch) */}
          {channelInfo && (
            <div className="rounded-2xl p-6 space-y-4"
              style={{ background: "var(--bg-panel)", border: "1px solid oklch(0.72 0.25 285 / 0.15)" }}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-semibold truncate">{channelInfo.channelName}</h2>
                  <p className="text-sm truncate" style={{ color: "var(--c-50)" }}>{channelInfo.subscribers} subscribers</p>
                </div>
                <div className="px-2 py-1 rounded-full text-xs font-medium"
                  style={{ background: "oklch(0.55 0.15 145 / 0.15)", border: "1px solid oklch(0.55 0.15 145 / 0.3)", color: "oklch(0.7 0.15 145)" }}>
                  Found
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
                  Top 10 Videos
                </p>
                {channelInfo.topVideos.map((v) => (
                  <div key={v.videoId} className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm"
                    style={{ background: "var(--bg-progress)" }}>
                    <span className="text-xs shrink-0" style={{ color: "var(--c-50)" }}>
                      {v.viewCount.toLocaleString()} views
                    </span>
                    <span className="truncate" style={{ color: "var(--c-75)" }}>{v.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
