"use client";

import { useState, use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProject";
import type { ChannelInfo, TranscriptResult } from "@/lib/types";

interface PageProps {
  params: Promise<{ projectId: string }>;
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
        <p className="text-xs" style={{ color: "var(--c-45)" }}>{step.sublabel}</p>
      </div>
    </div>
  );
}

export default function ChannelPage({ params }: PageProps) {
  const { projectId } = use(params);
  const router = useRouter();
  const { project } = useProject(projectId);

  const [channelUrl, setChannelUrl] = useState("");
  const [channelInfo, setChannelInfo] = useState<ChannelInfo | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptResult[]>([]);
  const [manualOverrides, setManualOverrides] = useState<Record<string, string>>({});
  const [topicMode, setTopicMode] = useState<"generate" | "custom">("generate");
  const [topicHint, setTopicHint] = useState("");
  const [customTopic, setCustomTopic] = useState("");
  const [isWorking, setIsWorking] = useState(false);

  const [steps, setSteps] = useState<AnalysisStep[]>([
    { id: "channel", label: "Fetch channel info", sublabel: "Name, subscribers, top videos", status: "idle" },
    { id: "transcripts", label: "Extract transcripts", sublabel: "Auto-pull from top 10 videos", status: "idle" },
    { id: "analyze", label: "Analyze channel style", sublabel: "Niche, hook style, tone, pacing", status: "idle" },
    { id: "dna", label: "Extract Style DNA", sublabel: "Sentence rhythm, emotional triggers", status: "idle" },
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
    let fetchedTranscripts: TranscriptResult[] = [];

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

    // Step 2: Extract transcripts
    setStep("transcripts", "running");
    try {
      const res = await fetch("/api/youtube/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: fetchedInfo!.topVideos }),
      });
      const data = await res.json();
      if (res.ok) {
        fetchedTranscripts = data.transcripts;
        setTranscripts(data.transcripts);
        const overrides: Record<string, string> = {};
        for (const t of data.transcripts) {
          if (!t.success) overrides[t.videoId] = "";
        }
        setManualOverrides(overrides);
      }
      setStep("transcripts", "done");
    } catch {
      setStep("transcripts", "error");
      toast.error("Transcript extraction failed — you can paste transcripts manually below");
    }

    // Save channel to project
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_url: channelUrl,
        channel_name: fetchedInfo!.channelName,
        channel_info: fetchedInfo,
      }),
    });

    // Steps 3-4: Claude analysis
    const readyTranscripts = (fetchedTranscripts.length ? fetchedTranscripts : transcripts)
      .map((t) => ({
        title: t.title,
        text: manualOverrides[t.videoId] !== undefined ? manualOverrides[t.videoId] : t.text,
      }))
      .filter((t) => t.text.trim().length > 50);

    if (!readyTranscripts.length) {
      setIsWorking(false);
      toast.error("No transcripts available. Please paste them manually.");
      return;
    }

    const topic = topicMode === "custom" ? customTopic.trim() : undefined;
    if (topicMode === "custom" && !topic) {
      setIsWorking(false);
      toast.error("Enter a topic first");
      return;
    }

    setStep("analyze", "running");
    await new Promise((r) => setTimeout(r, 300));
    setStep("dna", "running");

    try {
      const res = await fetch("/api/workflow/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          transcripts: readyTranscripts,
          topicMode,
          topicHint: topicHint.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (topicMode === "custom" && topic) {
        await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selected_topic: topic }),
        });
      }

      setStep("analyze", "done");
      setStep("dna", "done");
      await new Promise((r) => setTimeout(r, 400));
      router.push(`/projects/${projectId}/topic`);
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
    <div className="flex h-screen">
      <WizardNav projectId={projectId} currentState={1} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-10 space-y-8">

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
                  className="flex-1 px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
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
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                  style={{
                    background: "oklch(0.72 0.25 285)",
                    color: "var(--bg-page-2)",
                    boxShadow: isWorking ? "none" : "0 0 16px oklch(0.72 0.25 285 / 0.3)"
                  }}
                >
                  {isWorking ? "Running..." : "Analyze"}
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
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold">{channelInfo.channelName}</h2>
                  <p className="text-sm" style={{ color: "var(--c-50)" }}>{channelInfo.subscribers} subscribers</p>
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

          {/* Manual transcript fallback */}
          {transcripts.some((t) => !t.success) && (
            <div className="rounded-2xl p-6 space-y-4"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                Manual Transcript Entry
              </p>
              {transcripts.filter((t) => !t.success).map((t) => (
                <div key={t.videoId} className="space-y-2">
                  <p className="text-sm" style={{ color: "var(--c-60)" }}>{t.title}</p>
                  <textarea
                    placeholder="Paste transcript here..."
                    value={manualOverrides[t.videoId] ?? ""}
                    onChange={(e) => setManualOverrides((prev) => ({ ...prev, [t.videoId]: e.target.value }))}
                    rows={6}
                    className="w-full px-4 py-3 rounded-xl text-sm outline-none resize-none transition-all"
                    style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-8)", color: "var(--c-90)" }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
