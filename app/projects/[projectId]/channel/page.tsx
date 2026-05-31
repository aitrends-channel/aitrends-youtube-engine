"use client";

import { useState, use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { WizardNav } from "@/components/wizard/WizardNav";
import { NicheLimitModal } from "@/components/NicheLimitModal";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProject";
import type { ChannelInfo } from "@/lib/types";
import type { SupadataTranscript } from "@/lib/youtube/supadata";

type FailedStage = "channel" | "transcripts" | "analyze";
type HumanError = { title: string; body: string; hint?: string };

function humanizeAnalysisError(stage: FailedStage, raw: string | null): HumanError {
  const msg = (raw ?? "").trim();
  const lower = msg.toLowerCase();

  if (/failed to fetch|networkerror|err_internet|err_network/.test(lower)) {
    return {
      title: "Couldn't reach the server",
      body: "We weren't able to contact the backend.",
      hint: "Check your internet connection and try again.",
    };
  }

  if (stage === "channel") {
    if (/not found|404|invalid channel|no channel/.test(lower)) {
      return {
        title: "Channel not found",
        body: "We couldn't find a YouTube channel at that URL.",
        hint: "Double-check the link — formats like youtube.com/@handle or a channel URL work best.",
      };
    }
    if (/quota|rate limit|429/.test(lower)) {
      return {
        title: "YouTube quota reached",
        body: "Our YouTube API quota has been used up for now.",
        hint: "Please try again in a few hours.",
      };
    }
    if (/401|403|unauthorized|api key/.test(lower)) {
      return {
        title: "YouTube rejected the request",
        body: "Our YouTube API credentials were refused.",
        hint: "Contact support so we can refresh the key.",
      };
    }
    if (/5\d\d|unavailable|timeout/.test(lower)) {
      return {
        title: "YouTube is temporarily unavailable",
        body: "We couldn't reach YouTube to fetch this channel.",
        hint: "Wait a moment and try again.",
      };
    }
    return {
      title: "Couldn't fetch the channel",
      body: msg || "Something went wrong while loading the channel.",
      hint: "Try again, or check the channel URL.",
    };
  }

  if (stage === "transcripts") {
    const body = msg.replace(/^transcripts:\s*/i, "");
    const bodyLower = body.toLowerCase();
    if (/no transcripts|no captions|no subtitles/.test(bodyLower)) {
      return {
        title: "No captions available",
        body: "None of the recent videos on this channel have captions we can read.",
        hint: "Try a channel whose videos include subtitles.",
      };
    }
    if (/quota|rate limit|429/.test(bodyLower)) {
      return {
        title: "Transcript service is rate-limited",
        body: "Our transcript provider is throttling requests right now.",
        hint: "Wait a minute and try again.",
      };
    }
    if (/5\d\d|unavailable|timeout|gateway/.test(bodyLower)) {
      return {
        title: "Transcript service is unreachable",
        body: "Our transcript provider isn't responding.",
        hint: "Please try again in a moment.",
      };
    }
    return {
      title: "Couldn't fetch transcripts",
      body: body || "Something went wrong while collecting captions.",
      hint: "Try again — this is usually a transient issue.",
    };
  }

  if (/credits? insufficient|insufficient credits?|top up|402/.test(lower)) {
    return {
      title: "AI credits exhausted",
      body: "Your KIE balance isn't enough to run this analysis.",
      hint: "Top up your KIE account at kie.ai and try again.",
    };
  }
  if (/anthropic|claude/.test(lower)) {
    if (/401|invalid api key|unauthorized/.test(lower)) {
      return {
        title: "AI authentication failed",
        body: "Our AI provider rejected the request.",
        hint: "Contact support so we can refresh the credentials.",
      };
    }
    if (/overloaded|529/.test(lower)) {
      return {
        title: "AI provider is overloaded",
        body: "The AI service is under heavy load.",
        hint: "Give it a few seconds and try again.",
      };
    }
    if (/rate limit|429/.test(lower)) {
      return {
        title: "AI rate limit reached",
        body: "We've hit our request limit with the AI provider.",
        hint: "Wait a minute and try again.",
      };
    }
  }
  if (/token.*(limit|max|exceed)/.test(lower)) {
    return {
      title: "Too much content to analyze",
      body: "The combined transcripts exceeded the AI's input size.",
      hint: "Try a channel with shorter videos, or contact support.",
    };
  }
  if (/5\d\d|unavailable|timeout/.test(lower)) {
    return {
      title: "Analysis service unavailable",
      body: "Our analysis backend isn't responding right now.",
      hint: "Wait a moment and try again.",
    };
  }
  return {
    title: "Analysis failed",
    body: msg || "We couldn't finish the channel DNA analysis.",
    hint: "Try again — this is often transient.",
  };
}

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
  const isDone = step.status === "done";
  const isRunning = step.status === "running";
  const isError = step.status === "error";
  const isIdle = step.status === "idle";

  return (
    <div className="flex items-center gap-4">
      {/* Item: icon + label */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm"
          style={{
            background: isDone ? "oklch(0.55 0.15 145 / 0.2)"
              : isRunning ? "oklch(0.55 0.15 145 / 0.15)"
              : isError ? "oklch(0.6 0.22 25 / 0.2)"
              : "var(--bg-track)",
            border: `1px solid ${isDone ? "oklch(0.55 0.15 145 / 0.4)"
              : isRunning ? "oklch(0.55 0.15 145 / 0.35)"
              : isError ? "oklch(0.6 0.22 25 / 0.4)"
              : "var(--c-25)"}`,
            color: isDone ? "oklch(0.7 0.15 145)"
              : isRunning ? "oklch(0.65 0.15 145)"
              : isError ? "oklch(0.7 0.22 25)"
              : "var(--c-40)",
          }}
        >
          {isDone ? "✓"
            : isRunning ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
            : isError ? "✕"
            : "○"}
        </div>

        <div className="w-28 sm:w-32">
          <p className="text-sm font-medium truncate" style={{ color: isIdle ? "var(--c-45)" : "var(--c-90)" }}>
            {step.label}
          </p>
          {step.sublabel && <p className="text-xs truncate" style={{ color: "var(--c-45)" }}>{step.sublabel}</p>}
        </div>
      </div>

      {/* Progress bar — fills green incrementally while running, snaps full on done */}
      <div className="flex-1 ml-2 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
        {isError ? (
          <div className="h-full w-full rounded-full" style={{ background: "oklch(0.6 0.22 25)" }} />
        ) : isDone ? (
          <div className="h-full w-full rounded-full" style={{ background: "oklch(0.55 0.15 145)" }} />
        ) : isRunning ? (
          <div
            className="h-full wizard-progress-fill"
            style={{ background: "oklch(0.6 0.16 145)" }}
          />
        ) : null}
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
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState("");
  const [showNicheLimitModal, setShowNicheLimitModal] = useState(false);
  const [limitInfo, setLimitInfo] = useState<{ nichesUsed: number; nicheLimit: number; currentPlan: string } | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email) setUserEmail(data.user.email);
    });
  }, []);

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
    setAnalysisError(null);
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
      const msg = err instanceof Error ? err.message : "Failed to fetch channel";
      setAnalysisError(msg);
      toast.error(msg);
      setIsWorking(false);
      return;
    }

    // Step 2: Fetch video metadata
    setStep("transcripts", "running");
    if (!fetchedInfo!.topVideos.length) {
      setStep("transcripts", "error");
      const msg = "No videos found for this channel";
      setAnalysisError(msg);
      toast.error(msg);
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
        setAnalysisError(`Transcripts: ${msg}`);
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
        setIsWorking(false);
        setLimitInfo({
          nichesUsed: created.nichesUsed ?? 0,
          nicheLimit: created.limit ?? 0,
          currentPlan: created.plan ?? "starter",
        });
        setShowNicheLimitModal(true);
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

    // Kick off the single Claude analysis call; visually split into two
    // sequential phases so users see one step complete before the next starts.
    const apiPromise = (async () => {
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
      return data;
    })();

    try {
      // Phase 1 (Refining): show running until the API returns OR 4s elapses,
      // whichever is longer. Then mark done and start phase 2.
      await Promise.race([
        apiPromise.then(() => {}).catch(() => {}),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
      setStep("analyze", "done");
      await new Promise((r) => setTimeout(r, 350));

      // Phase 2 (Finalising): show running until the API actually finishes
      // AND a minimum 1.5s has passed.
      setStep("dna", "running");
      await Promise.all([
        apiPromise,
        new Promise((r) => setTimeout(r, 1500)),
      ]);

      if (topicMode === "custom" && topic) {
        await fetch(`/api/projects/${effectiveProjectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selected_topic: topic }),
        });
      }

      setStep("dna", "done");
      await new Promise((r) => setTimeout(r, 400));
      router.push(`/projects/${effectiveProjectId}/topic`);
    } catch (err) {
      setStep("analyze", "error");
      setStep("dna", "error");
      const msg = err instanceof Error ? err.message : "Analysis failed";
      setAnalysisError(msg);
      toast.error(msg);
    } finally {
      setIsWorking(false);
    }
  }

  const allDone = steps.every((s) => s.status === "done");
  const hasError = steps.some((s) => s.status === "error");
  const isRunning = steps.some((s) => s.status === "running");
  const isAnalyzed = !!(project?.channel_name && project?.channel_info);

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
                  readOnly={isAnalyzed}
                  onChange={(e) => !isAnalyzed && setChannelUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !isWorking && !isAnalyzed && runFullAnalysis()}
                  className="flex-1 min-w-0 px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                  style={{
                    background: "var(--bg-progress)",
                    border: "1px solid var(--bd-8)",
                    color: "var(--c-90)",
                    opacity: isAnalyzed ? 0.6 : 1,
                    cursor: isAnalyzed ? "default" : undefined,
                  }}
                  onFocus={(e) => { if (!isAnalyzed) (e.target as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.4)"; }}
                  onBlur={(e) => { (e.target as HTMLElement).style.borderColor = "var(--bd-8)"; }}
                />
                <button
                  onClick={runFullAnalysis}
                  disabled={isWorking || !channelUrl.trim() || isAnalyzed}
                  className="shrink-0 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                  style={{
                    background: "oklch(0.72 0.25 285)",
                    color: "var(--bg-page-2)",
                    boxShadow: isWorking || isAnalyzed ? "none" : "0 0 16px oklch(0.72 0.25 285 / 0.3)"
                  }}
                >
                  {isWorking ? (
                    <span className="flex items-center gap-2">
                      <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Running…
                    </span>
                  ) : isAnalyzed ? "Analyzed" : "Analyze"}
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
              {hasError && !isRunning && (() => {
                const failedId = steps.find((s) => s.status === "error")?.id;
                const stage: FailedStage =
                  failedId === "channel" ? "channel"
                    : failedId === "transcripts" ? "transcripts"
                    : "analyze";
                const err = humanizeAnalysisError(stage, analysisError);
                return (
                  <div className="mt-3 rounded-xl p-4 flex gap-3"
                    style={{ background: "oklch(0.6 0.22 25 / 0.08)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}>
                    <AlertCircle size={20} className="shrink-0 mt-0.5" style={{ color: "oklch(0.65 0.22 25)" }} />
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-semibold" style={{ color: "oklch(0.78 0.22 25)" }}>{err.title}</p>
                      <p className="text-sm" style={{ color: "oklch(0.65 0.18 25)" }}>{err.body}</p>
                      {err.hint && (
                        <p className="text-xs pt-1" style={{ color: "oklch(0.6 0.10 25)" }}>{err.hint}</p>
                      )}
                    </div>
                  </div>
                );
              })()}
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
                  Top {channelInfo.topVideos.length} Video{channelInfo.topVideos.length === 1 ? "" : "s"}
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

      {showNicheLimitModal && limitInfo && (
        <NicheLimitModal
          email={userEmail}
          currentPlan={limitInfo.currentPlan}
          nichesUsed={limitInfo.nichesUsed}
          nicheLimit={limitInfo.nicheLimit}
          onClose={() => setShowNicheLimitModal(false)}
          onSuccess={() => {
            setShowNicheLimitModal(false);
            router.push("/dashboard");
          }}
        />
      )}
    </div>
  );
}
