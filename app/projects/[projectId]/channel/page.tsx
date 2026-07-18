"use client";

import { useState, use, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowUpRight, Zap } from "lucide-react";
import { STUDIO_MODE_NAME } from "@/lib/one-click/config";
import { WizardNav } from "@/components/wizard/WizardNav";
import { NicheLimitModal } from "@/components/NicheLimitModal";
import { StepCostCard } from "@/components/StepCostCard";
import { StepBalanceCard } from "@/components/StepBalanceCard";
import { isAdminUser } from "@/lib/admin";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { toast } from "sonner";
import { useProject } from "@/hooks/useProject";
import type { ChannelInfo, TopVideo } from "@/lib/types";
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

// YouTube videos.list returns duration as ISO 8601 (PT1H23M45S). Format
// as a fixed HH:MM:SS so column widths don't jump between short and
// long videos; show "—" if missing (older cached channel_info rows
// predate the field).
function formatDuration(iso?: string): string {
  if (!iso) return "—";
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return "—";
  const h = parseInt(m[1] ?? "0", 10);
  const min = parseInt(m[2] ?? "0", 10);
  const s = parseInt(m[3] ?? "0", 10);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(min)}:${pad(s)}`;
}

function parseDurationSeconds(iso?: string): number | null {
  if (!iso) return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const h = parseInt(m[1] ?? "0", 10);
  const min = parseInt(m[2] ?? "0", 10);
  const s = parseInt(m[3] ?? "0", 10);
  return h * 3600 + min * 60 + s;
}

// Heclus's downstream pipeline (transcripts + analysis prompt size + KIE
// proxy) handles short videos well but degrades on 45min+. Surface that
// as an explicit user confirmation instead of silently truncating the
// later analyze step.
const MAX_AVG_DURATION_SECONDS = 45 * 60;

function averageDurationSeconds(videos: { duration?: string }[]): number | null {
  const seconds = videos.map((v) => parseDurationSeconds(v.duration)).filter((s): s is number => s != null);
  if (!seconds.length) return null;
  return Math.round(seconds.reduce((sum, s) => sum + s, 0) / seconds.length);
}

// When the channel's avg duration exceeds the threshold, the top-10 set
// gets thinned before we hit Supadata. Two passes:
//   1) Prefer videos that already have captions (Supadata pulls them
//      directly, no slow speech-to-text). If we have >3 captioned
//      videos, that's our full working set for analysis.
//   2) Otherwise fall back to the 3 shortest videos by duration — small
//      enough that Supadata can transcribe them within the route's
//      budget even if it has to generate from audio.
// Under the threshold this returns the original list unchanged.
function pickVideosForTranscription(videos: TopVideo[], avgSeconds: number | null): TopVideo[] {
  if (avgSeconds == null || avgSeconds <= MAX_AVG_DURATION_SECONDS) return videos;
  const captioned = videos.filter((v) => v.hasCaptions === true);
  if (captioned.length > 3) return captioned;
  const withParsed = videos.map((v) => ({ v, secs: parseDurationSeconds(v.duration) ?? Infinity }));
  withParsed.sort((a, b) => a.secs - b.secs);
  return withParsed.slice(0, 3).map((x) => x.v);
}

function formatSecondsAsHHMMSS(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export default function ChannelPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project } = useProject(projectId === "new" ? null : projectId);

  const [channelUrl, setChannelUrl] = useState("");
  const [channelInfo, setChannelInfo] = useState<ChannelInfo | null>(null);
  const [transcripts, setTranscripts] = useState<SupadataTranscript[]>([]);
  // Required pick before any analysis can run — scopes which videos
  // the YouTube fetch + downstream pipeline care about. Null on first
  // visit so the user has to opt in (no silent default like "long"
  // that would commit a wrong-flavor pipeline behind their back).
  const [contentType, setContentType] = useState<"long" | "shorts" | "both" | null>(null);
  // Generation mode: "studio" = the classic step-by-step wizard;
  // "oneclick" = autopilot (analysis runs here while the user is
  // present, then the server orchestrator drives every later step).
  const [genMode, setGenMode] = useState<"studio" | "oneclick">("studio");
  // null = not checked yet; refreshed whenever 1Click is selected and on
  // window focus (so returning from /setup?tab=oneclick picks up the
  // fresh preset without a reload).
  const [oneClickConfigured, setOneClickConfigured] = useState<boolean | null>(null);
  const [oneClickEngaged, setOneClickEngaged] = useState(false);

  useEffect(() => {
    if (genMode !== "oneclick") return;
    let alive = true;
    const check = () =>
      fetch("/api/one-click/config")
        .then((r) => r.json())
        .then((d) => { if (alive) setOneClickConfigured(Boolean(d?.configured)); })
        .catch(() => { if (alive) setOneClickConfigured(false); });
    check();
    window.addEventListener("focus", check);
    return () => { alive = false; window.removeEventListener("focus", check); };
  }, [genMode]);
  const [topicMode, setTopicMode] = useState<"generate" | "custom">("generate");
  const [topicHint, setTopicHint] = useState("");
  const [customTopic, setCustomTopic] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  // Anchored to the "Analysis Progress" panel below so clicking
  // Analyze pulls the steps section into view. Otherwise on a short
  // viewport the panel mounts below the fold and the user can miss the
  // run animation entirely. Matches the demo channel page's behavior.
  const progressRef = useRef<HTMLDivElement | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState("");
  const [showNicheLimitModal, setShowNicheLimitModal] = useState(false);
  const [limitInfo, setLimitInfo] = useState<{ nichesUsed: number; nicheLimit: number; currentPlan: string } | null>(null);
  // Set when a fresh /projects/new run lands on a channel the user
  // already has a niche for; modal redirects them to fork that niche
  // instead of creating a duplicate. Only fires before any expensive
  // pipeline step (transcripts, Claude calls) runs.
  const [existingNiche, setExistingNiche] = useState<{ projectId: string; channelName: string } | null>(null);
  // Long-video consent gate. When the top-10 average duration exceeds
  // MAX_AVG_DURATION_SECONDS we pause runFullAnalysis on this resolver
  // and surface a modal so the user can accept the degraded analysis
  // quality or cancel. The resolver lives in state (not a ref) because
  // the dialog open/close is keyed off it being null.
  const [longVideoConsent, setLongVideoConsent] = useState<{
    avgSeconds: number;
    resolve: (proceed: boolean) => void;
  } | null>(null);
  // Two-stage confirmation inside the consent modal: "warn" shows the
  // 45min threshold message, "explain" elaborates on the trade-offs
  // before they actually commit. Reset to "warn" every time the modal
  // closes so the next open starts at stage 1.
  const [consentStep, setConsentStep] = useState<"warn" | "explain">("warn");

  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email) setUserEmail(data.user.email);
      setIsAdmin(isAdminUser(data.user));
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
    // content_type is whitelisted on the server (long/shorts/both or null)
    // but we still narrow on the client so a stale row from a future
    // schema can't break the tab-render.
    if (
      project?.content_type &&
      !contentType &&
      (project.content_type === "long" || project.content_type === "shorts" || project.content_type === "both")
    ) {
      setContentType(project.content_type);
    }
  }, [project]);

  // Scroll the Analysis Progress panel into view whenever a run kicks
  // off. Tied to isWorking rather than runFullAnalysis directly so it
  // fires on Retry / Re-analyze too, and after React has committed
  // the conditional render — refs are null until then.
  useEffect(() => {
    if (!isWorking) return;
    progressRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [isWorking]);

  async function runFullAnalysis() {
    if (!channelUrl.trim()) return;
    // Belt-and-suspenders — the button is already disabled when this is
    // null. Keeps any keyboard-Enter path honest.
    if (!contentType) {
      toast.error("Pick a content type first");
      return;
    }
    setIsWorking(true);
    setAnalysisError(null);
    setSteps((prev) => prev.map((s) => ({ ...s, status: "idle" })));
    // Scroll is handled by the useEffect on isWorking below — it
    // fires AFTER React has committed the conditionally-mounted
    // panel, so progressRef has an actual target. An inline
    // requestAnimationFrame here would race the render and fire
    // before the panel exists.

    let fetchedInfo: ChannelInfo | null = null;
    let fetchedTranscripts: SupadataTranscript[] = [];

    // If we already have channelInfo from a prior partial run (e.g. user
    // cancelled the long-video consent modal, then clicked Continue),
    // skip the channel fetch + dedup guard — those already succeeded
    // and re-running them just wastes a YouTube quota call.
    if (channelInfo) {
      fetchedInfo = channelInfo;
      setStep("channel", "done");
    } else {
      // Step 1: Fetch channel
      setStep("channel", "running");
      try {
        const res = await fetch("/api/youtube/channel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelUrl, contentType }),
        });
        // Read once as text and only parse if it looks like JSON.
        // Guards against Vercel's plain-text runtime errors (e.g.
        // function timeout, OOM) that the route can't intercept —
        // res.json() on "An error occurred…" throws an opaque
        // "Unexpected token 'A'…" that the error-mapper can't handle.
        const bodyText = await res.text();
        let parsed: { error?: string; [k: string]: unknown } | null = null;
        try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON body */ }
        if (!res.ok) {
          throw new Error(parsed?.error ?? bodyText ?? `Channel fetch failed (${res.status})`);
        }
        fetchedInfo = parsed as unknown as ChannelInfo;
        setChannelInfo(fetchedInfo);
        setStep("channel", "done");
      } catch (err) {
        setStep("channel", "error");
        const msg = err instanceof Error ? err.message : "Failed to fetch channel";
        setAnalysisError(msg);
        toast.error(msg);
        setIsWorking(false);
        return;
      }

      // Dedup guard for fresh-niche flow: if the user already has a
      // project for this channel, redirect them to fork it instead of
      // burning a niche slot + Claude calls on a duplicate. We do this
      // BEFORE transcripts so we don't hit Supadata uselessly.
      if (projectId === "new" && fetchedInfo) {
        const target = fetchedInfo.channelName.trim().toLowerCase();
        try {
          const res = await fetch("/api/projects");
          if (res.ok) {
            const userProjects = await res.json() as Array<{ id: string; channel_name: string | null }>;
            const match = userProjects.find((p) => (p.channel_name ?? "").trim().toLowerCase() === target);
            if (match) {
              // Reset the pipeline back to idle and surface the redirect
              // modal. The user picks: fork the existing niche or cancel.
              setSteps((prev) => prev.map((s) => ({ ...s, status: "idle" })));
              setExistingNiche({ projectId: match.id, channelName: fetchedInfo.channelName });
              setIsWorking(false);
              return;
            }
          }
        } catch {
          // Non-fatal — if the lookup itself errors, we'd rather continue
          // and let the user create than block them on a transient.
        }
      }
    }

    // Long-video gate: if the top-10's avg duration is past the 45min
    // threshold, ask the user to opt in before burning Supadata calls
    // + a likely-degraded Claude analysis. Cancel rolls the pipeline
    // back to idle without surfacing an error (it's a user choice,
    // not a failure).
    const avg = averageDurationSeconds(fetchedInfo!.topVideos);
    if (avg != null && avg > MAX_AVG_DURATION_SECONDS) {
      const proceed = await new Promise<boolean>((resolve) => {
        setLongVideoConsent({ avgSeconds: avg, resolve });
      });
      setLongVideoConsent(null);
      if (!proceed) {
        setSteps((prev) => prev.map((s) => ({ ...s, status: "idle" })));
        setIsWorking(false);
        return;
      }
    }

    // Step 2: Fetch video metadata
    setStep("transcripts", "running");
    if (!fetchedInfo!.topVideos.length) {
      setStep("transcripts", "error");
      // Contextualize the error by the scope the user just picked —
      // "no videos" is misleading when they asked for shorts on a
      // long-only channel (or vice-versa). The remediation is to swap
      // the content-type tab, not retry, so surface that explicitly.
      const msg = contentType === "shorts"
        ? "No Shorts found in this channel's recent uploads. Try \"Long Videos\" or \"Both\"."
        : contentType === "long"
          ? "No long-form videos found on this channel. Try \"Shorts\" or \"Both\"."
          : "No videos found for this channel";
      setAnalysisError(msg);
      toast.error(msg);
      setIsWorking(false);
      return;
    } else {
      // When the channel exceeds the avg-duration threshold, thin the
      // set we hand to Supadata: prefer captioned videos (fast, no
      // STT), fall back to the 3 shortest. Under the threshold this is
      // a no-op pass-through. The full topVideos array is still saved
      // to channel_info — the picker only controls what gets
      // transcribed for the analysis call.
      const videosToFetch = pickVideosForTranscription(fetchedInfo!.topVideos, avg);
      try {
        const res = await fetch("/api/youtube/transcripts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videos: videosToFetch }),
        });
        const bodyText = await res.text();
        let parsed: { error?: string; transcripts?: unknown; [k: string]: unknown } | null = null;
        try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON body */ }
        if (!res.ok) {
          throw new Error(parsed?.error ?? bodyText ?? `Transcript fetch failed (${res.status})`);
        }
        fetchedTranscripts = (parsed?.transcripts ?? []) as typeof fetchedTranscripts;
        setTranscripts(fetchedTranscripts);

        // Merge per-video word counts into fetchedInfo.topVideos so they
        // persist via channel_info on the upcoming PATCH. Without this
        // the words column re-renders as "—" on every page visit until
        // the transcripts step runs again.
        const wordCountByVideo = new Map(
          fetchedTranscripts.filter((t) => t.success).map((t) => [t.videoId, t.wordCount])
        );
        fetchedInfo = {
          ...fetchedInfo!,
          topVideos: fetchedInfo!.topVideos.map((v) => {
            const wc = wordCountByVideo.get(v.videoId);
            return wc != null ? { ...v, wordCount: wc } : v;
          }),
        };
        setChannelInfo(fetchedInfo);
        // Temporary diagnostic — confirms the merge actually wired
        // wordCount onto topVideos. Remove once the not-populating
        // issue is resolved.
        console.log("[transcripts merge]", {
          fetchedCount: fetchedTranscripts.length,
          succeededCount: fetchedTranscripts.filter((t) => t.success).length,
          mapSize: wordCountByVideo.size,
          mergedWordCounts: fetchedInfo.topVideos.map((v) => ({ id: v.videoId, words: v.wordCount })),
        });

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
        // Persist the user's pick so reloads + downstream steps see the
        // same scope. The DB constraint (long/shorts/both) keeps this
        // honest — the !!contentType guard upstream means we never
        // PATCH a null and clobber an existing value.
        ...(contentType ? { content_type: contentType } : {}),
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
      const bodyText = await res.text();
      let data: { error?: string; [k: string]: unknown } | null = null;
      try { data = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON body */ }
      if (!res.ok) {
        throw new Error(data?.error ?? bodyText ?? `Analysis failed (${res.status})`);
      }
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

      // 1Click: engage autopilot now that the project row exists and
      // analysis is done — the orchestrator drives everything from the
      // topic step onward, and the user can close the tab.
      if (genMode === "oneclick") {
        try {
          const res = await fetch("/api/one-click/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: effectiveProjectId }),
          });
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) throw new Error(d.error ?? `1Click start failed (${res.status})`);
          setOneClickEngaged(true);
          toast.success("1Click engaged — we'll take it from here");
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "1Click start failed");
        }
      }

      // Stay on the channel page after analysis instead of auto-routing
      // to /topic. The user advances via the persistent "Continue →" bar
      // at the bottom of the page, which lets them re-analyze with a
      // different content-type pick first if they want — matching the
      // demo flow's behavior. effectiveProjectId is the niche we just
      // created in the projects/new path; route there explicitly so the
      // wizard sidebar reflects the saved project on the next nav.
      if (effectiveProjectId !== projectId) {
        router.replace(`/projects/${effectiveProjectId}/channel`);
      }
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

      <main className="flex-1 min-w-0 overflow-y-auto pt-[105px] md:pt-0 lg:px-[15px]">
        <div className="px-5 sm:px-8 pt-6 sm:pt-10 pb-24 space-y-8">

          {/* Header */}
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Channel Setup</h1>
            <p className="text-sm mt-1" style={{ color: "var(--c-50)" }}>
              Enter a YouTube channel URL to automatically extract style DNA and generate content.
            </p>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <StepCostCard
                projectId={projectId}
                column="channel_analysis"
                hideUnitKinds={isAdmin ? undefined : ["supadata_transcripts"]}
              />
              <StepBalanceCard />
            </div>
          </div>

          {/* URL input card */}
          <div className="rounded-2xl p-6 space-y-5"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>

            {/* Content Type — first decision in the flow. Locked once a
                niche has been analyzed so a downstream regen can't
                silently swap long → shorts (which would invalidate the
                cached transcripts + channel_info we're about to re-use). */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                Content Type
              </label>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { value: "long", label: "Long Videos", desc: "Standard YouTube videos" },
                  { value: "shorts", label: "Shorts", desc: "Vertical short-form" },
                  { value: "both", label: "Both", desc: "Long + shorts" },
                ] as const).map((opt) => {
                  const selected = contentType === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setContentType(opt.value)}
                      disabled={isAnalyzed || isWorking}
                      className="px-4 py-2.5 rounded-xl text-sm text-left transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{
                        background: selected ? "oklch(0.72 0.25 285 / 0.12)" : "var(--bg-progress)",
                        border: `1px solid ${selected ? "oklch(0.72 0.25 285 / 0.3)" : "var(--bd-8)"}`,
                        color: selected ? "oklch(0.72 0.25 285)" : "var(--c-55)",
                      }}
                    >
                      <p className="font-medium">{opt.label}</p>
                      <p className="text-xs mt-0.5 opacity-70">{opt.desc}</p>
                    </button>
                  );
                })}
              </div>
              {!contentType && (
                <p className="text-xs" style={{ color: "var(--c-45)" }}>
                  Pick a content type to begin.
                </p>
              )}
            </div>

            {/* Generation mode — Studio (classic wizard) vs 1Click
                (autopilot). Locked once analysis has run, same as the
                content type. */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                Generation Mode
              </label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: "studio" as const, label: STUDIO_MODE_NAME, desc: "Guide every step yourself — full control." },
                  { value: "oneclick" as const, label: "1Click", desc: "Fully automatic. Start it, close the tab, get an email when your video is ready." },
                ]).map((opt) => {
                  const selected = genMode === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setGenMode(opt.value)}
                      disabled={isAnalyzed || isWorking || oneClickEngaged}
                      className="px-4 py-2.5 rounded-xl text-sm text-left transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{
                        background: selected ? "oklch(0.72 0.25 285 / 0.12)" : "var(--bg-progress)",
                        border: `1px solid ${selected ? "oklch(0.72 0.25 285 / 0.3)" : "var(--bd-8)"}`,
                        color: selected ? "oklch(0.72 0.25 285)" : "var(--c-55)",
                      }}
                    >
                      <p className="font-medium flex items-center gap-1.5">
                        {opt.value === "oneclick" && <Zap size={13} />}
                        {opt.label}
                      </p>
                      <p className="text-xs mt-0.5 opacity-70">{opt.desc}</p>
                    </button>
                  );
                })}
              </div>
              {genMode === "oneclick" && !isAnalyzed && oneClickConfigured && (
                <button
                  type="button"
                  onClick={() => router.push("/setup?tab=oneclick")}
                  className="text-xs font-medium underline underline-offset-2 cursor-pointer"
                  style={{ color: "oklch(0.72 0.25 285)" }}
                >
                  Review 1Click preferences
                </button>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-50)" }}>
                YouTube Channel URL
              </label>
              {/* On a failed analysis we lock the channel URL so the user
                  can't swap channels mid-error (the project row is
                  already tied to this URL) but keep the action button
                  active so they can retry with the same input. */}
              {(() => {
                // Lock the URL field only when the niche has actually
                // been persisted to the DB (project.channel_name +
                // channel_info are set). On a pre-save failure the URL
                // stays editable so the user can fix a typo and retry;
                // on a post-save failure the URL is sticky but the
                // button is still actionable for a Retry.
                const inputLocked = isAnalyzed;
                // contentType is the first required decision — keep the
                // URL field disabled until they've picked, so the flow
                // visibly reads top-down. Once analyzed the content_type
                // is already on the project row, so the lock-by-isAnalyzed
                // branch keeps things stable for Retry / Re-analyze.
                const contentTypeMissing = !contentType;
                const buttonDisabled = isWorking || !channelUrl.trim() || contentTypeMissing || (genMode === "oneclick" && oneClickConfigured !== true);
                const buttonLabel = isWorking
                  ? null
                  : hasError
                    ? "Retry"
                    : isAnalyzed
                      ? "Re-analyze"
                      : channelInfo
                        // Partial run earlier this session — e.g. user
                        // cancelled the long-video consent modal. The
                        // channel fetch result is still in state, so
                        // clicking resumes from there.
                        ? "Continue"
                        : genMode === "oneclick"
                          ? "Start 1Click"
                          : "Analyze";
                // 1Click selected but never configured: the input area
                // becomes a single call-to-action into the Setup page's
                // 1Click tab. The URL field returns once a preset exists.
                if (genMode === "oneclick" && !isAnalyzed && oneClickConfigured === false) {
                  return (
                    <div className="space-y-2">
                      <button
                        type="button"
                        onClick={() => router.push("/setup?tab=oneclick")}
                        className="w-full flex items-center justify-center gap-2 px-5 py-3.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 cursor-pointer"
                        style={{
                          background: "oklch(0.72 0.25 285)",
                          color: "var(--bg-page-2)",
                          boxShadow: "0 0 16px oklch(0.72 0.25 285 / 0.3)",
                        }}
                      >
                        <Zap size={15} />
                        Configure 1Click
                      </button>
                      <p className="text-xs" style={{ color: "var(--c-45)" }}>
                        One-time setup: pick your voice, models, and output format — then every 1Click run is fully automatic.
                      </p>
                    </div>
                  );
                }
                return (
                  <div className="flex gap-3">
                    <input
                      type="text"
                      placeholder={contentTypeMissing ? "Pick a content type above first" : "https://youtube.com/@channelname"}
                      value={channelUrl}
                      readOnly={inputLocked}
                      disabled={contentTypeMissing && !inputLocked}
                      onChange={(e) => {
                        if (inputLocked) return;
                        setChannelUrl(e.target.value);
                        // Drop any stale channelInfo from a prior partial
                        // run so the button label flips back to "Analyze"
                        // and the URL change actually triggers a fresh
                        // fetch instead of "Continue" against the old
                        // channel.
                        if (channelInfo) setChannelInfo(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && !buttonDisabled && runFullAnalysis()}
                      className="flex-1 min-w-0 px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                      style={{
                        background: "var(--bg-progress)",
                        border: "1px solid var(--bd-8)",
                        color: "var(--c-90)",
                        opacity: inputLocked || contentTypeMissing ? 0.6 : 1,
                        cursor: inputLocked || contentTypeMissing ? "not-allowed" : undefined,
                      }}
                      onFocus={(e) => { if (!inputLocked && !contentTypeMissing) (e.target as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.4)"; }}
                      onBlur={(e) => { (e.target as HTMLElement).style.borderColor = "var(--bd-8)"; }}
                    />
                    <button
                      onClick={runFullAnalysis}
                      disabled={buttonDisabled}
                      className="shrink-0 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                      style={{
                        background: "oklch(0.72 0.25 285)",
                        color: "var(--bg-page-2)",
                        boxShadow: buttonDisabled ? "none" : "0 0 16px oklch(0.72 0.25 285 / 0.3)",
                      }}
                    >
                      {isWorking ? (
                        <span className="flex items-center gap-2">
                          <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Running…
                        </span>
                      ) : buttonLabel}
                    </button>
                  </div>
                );
              })()}
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
            <div
              ref={progressRef}
              className="rounded-2xl p-6 space-y-4 scroll-mt-4"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}
            >
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
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
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

              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
                    Top {channelInfo.topVideos.length} Video{channelInfo.topVideos.length === 1 ? "" : "s"}
                  </p>
                  {(() => {
                    const avg = averageDurationSeconds(channelInfo.topVideos);
                    return avg != null ? (
                      <p className="text-xs font-semibold uppercase tracking-wider tabular-nums" style={{ color: "var(--c-45)" }}>
                        Avg duration <span style={{ color: "var(--c-75)" }}>{formatSecondsAsHHMMSS(avg)}</span>
                      </p>
                    ) : null;
                  })()}
                </div>
                {/* Word counts come from the transcripts fetch and are joined
                    by videoId. Before transcripts run, "—" is shown so the
                    column doesn't shift width once the data arrives. */}
                {/* overflow-x-auto + a table min-width lets the 6-column
                    table scroll sideways on mobile instead of crushing the
                    Title column or getting clipped by the page. */}
                <div className="rounded-lg overflow-x-auto" style={{ background: "var(--bg-progress)" }}>
                  <table className="w-full text-sm min-w-[640px]">
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                        <th className="text-left px-3 py-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>Title</th>
                        <th className="text-right px-3 py-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--c-45)" }}>Words</th>
                        <th className="text-center px-3 py-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--c-45)" }}>Captions</th>
                        <th className="text-right px-3 py-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--c-45)" }}>Duration</th>
                        <th className="text-right px-3 py-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--c-45)" }}>Views</th>
                        <th className="text-right px-3 py-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: "var(--c-45)" }}>Published</th>
                      </tr>
                    </thead>
                    <tbody>
                      {channelInfo.topVideos.map((v) => {
                        // Prefer the persisted word count on the video
                        // (set during the transcripts step + saved in
                        // channel_info). Fall back to the live transcripts
                        // state for the moment between the fetch landing
                        // and the channel_info PATCH, plus older rows
                        // that pre-date persistence.
                        const liveTranscript = transcripts.find((t) => t.videoId === v.videoId);
                        const words = v.wordCount ?? (liveTranscript?.success ? liveTranscript.wordCount : null);
                        return (
                          <tr key={v.videoId} style={{ borderTop: "1px solid var(--bd-7)" }}>
                            <td className="px-3 py-2 min-w-0">
                              <a
                                href={`https://www.youtube.com/watch?v=${v.videoId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1.5 min-w-0 hover:opacity-80 transition-opacity"
                                style={{ color: "oklch(0.72 0.25 285)" }}
                                title={v.title}
                              >
                                <span
                                  className="truncate underline underline-offset-2"
                                  style={{ textDecorationColor: "oklch(0.72 0.25 285 / 0.5)" }}
                                >
                                  {v.title}
                                </span>
                                <ArrowUpRight size={12} strokeWidth={2.25} className="shrink-0 opacity-70" aria-hidden />
                              </a>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--c-75)" }}>
                              {words != null ? words.toLocaleString() : "—"}
                            </td>
                            <td className="px-3 py-2 text-center whitespace-nowrap">
                              {v.hasCaptions === true ? (
                                <span style={{ color: "oklch(0.65 0.15 145)" }}>Yes</span>
                              ) : v.hasCaptions === false ? (
                                <span style={{ color: "var(--c-45)" }}>No</span>
                              ) : (
                                <span style={{ color: "var(--c-45)" }}>—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--c-75)" }}>
                              {formatDuration(v.duration)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--c-75)" }}>
                              {v.viewCount.toLocaleString()}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" style={{ color: "var(--c-75)" }}>
                              {v.publishedAt
                                ? new Date(v.publishedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
                                : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

        </div>
      </main>

      {/* Fixed bottom Continue bar. Shows whenever the channel has
          been analyzed — either persisted on the project row (revisit)
          or freshly completed in this session (allDone) — and we're
          not currently mid-run. !isWorking gating keeps it hidden
          during a re-analyze so the user can't race into /topic with
          stale data. md:left-64 offsets the wizard sidebar so the bar
          spans only the content area on desktop. */}
      {!isWorking && (isAnalyzed || allDone) && (
        <div
          className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}
        >
          <div className="px-4 sm:px-8">
            {oneClickEngaged ? (
              // Autopilot owns the rest of the pipeline — invite the user
              // to walk away instead of continuing manually.
              <div className="flex items-center gap-3 flex-wrap">
                <p className="flex-1 min-w-[240px] text-sm font-medium flex items-center gap-2" style={{ color: "oklch(0.72 0.25 285)" }}>
                  <Zap size={15} />
                  1Click engaged — generation continues in the background. You can close this tab; we&apos;ll email you when your video is ready.
                </p>
                <button
                  onClick={() => router.push("/dashboard")}
                  className="shrink-0 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  Go to Dashboard
                </button>
              </div>
            ) : (
              <button
                onClick={() => router.push(`/projects/${projectId}/topic`)}
                className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                Continue →
              </button>
            )}
          </div>
        </div>
      )}


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

      <Dialog
        open={existingNiche !== null}
        onOpenChange={(open) => { if (!open) setExistingNiche(null); }}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>You already have this niche</DialogTitle>
            <DialogDescription>
              A project for this channel already exists in your dashboard. Add a new video to it
              instead of creating a duplicate niche — it preserves your niche slot and reuses the
              channel analysis you&apos;ve already paid for.
            </DialogDescription>
          </DialogHeader>
          {existingNiche && (
            <div className="rounded-xl p-3"
              style={{ background: "oklch(0.72 0.25 285 / 0.06)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
              <p className="text-xs uppercase tracking-wide" style={{ color: "var(--c-45)" }}>Existing niche</p>
              <p className="text-sm font-semibold mt-1" style={{ color: "var(--c-90)" }}>
                {existingNiche.channelName}
              </p>
            </div>
          )}
          <DialogFooter>
            <button
              onClick={() => {
                if (!existingNiche) return;
                router.push(`/projects/new-fork/topic?from=${existingNiche.projectId}`);
              }}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              Add video to existing niche
            </button>
            <button
              onClick={() => setExistingNiche(null)}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={longVideoConsent !== null}
        onOpenChange={(open) => {
          // Dismissal via overlay click / Escape counts as Cancel —
          // resolve(false) so runFullAnalysis's awaited promise exits.
          if (!open && longVideoConsent) {
            longVideoConsent.resolve(false);
            setLongVideoConsent(null);
            setConsentStep("warn");
          }
        }}
      >
        {/* Inline styles override the themed DialogContent (bg-popover,
            text-popover-foreground) so this modal is unconditionally
            white with dark text — matches the design call regardless
            of the user's theme. */}
        <DialogContent
          className="sm:max-w-lg"
          showCloseButton={false}
          style={{ background: "#ffffff", color: "oklch(0.18 0 0)" }}
        >
          <DialogHeader style={{ marginBottom: "20px" }}>
            <DialogTitle style={{ color: "oklch(0.15 0 0)" }}>
              {consentStep === "warn"
                ? `This channel has a video length of ${longVideoConsent ? formatSecondsAsHHMMSS(longVideoConsent.avgSeconds) : "00:00:00"}`
                : "Before you proceed"}
            </DialogTitle>
            <DialogDescription style={{ color: "oklch(0.35 0 0)", marginTop: "20px" }}>
              {consentStep === "warn" ? (
                <>
                  Heclus currently handles a maximum of <strong>45 minutes</strong> per video for
                  the channel analysis step. This channel&apos;s top 10 videos exceed that on
                  average, so the style analysis may be less detailed than usual.
                </>
              ) : (
                <>
                  Your generated video will still follow this channel&apos;s style and DNA, but the
                  final length will stay within Heclus&apos;s current maximum.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter style={{ background: "oklch(0.97 0 0)", borderTopColor: "oklch(0.9 0 0)" }}>
            {consentStep === "warn" ? (
              <button
                onClick={() => setConsentStep("explain")}
                className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                style={{ background: "oklch(0.72 0.25 285)", color: "#ffffff" }}
              >
                Proceed anyway
              </button>
            ) : (
              <button
                onClick={() => {
                  longVideoConsent?.resolve(true);
                  setLongVideoConsent(null);
                  setConsentStep("warn");
                }}
                className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                style={{ background: "oklch(0.55 0.15 145)", color: "#ffffff" }}
              >
                Accept
              </button>
            )}
            <button
              onClick={() => {
                longVideoConsent?.resolve(false);
                setLongVideoConsent(null);
                setConsentStep("warn");
              }}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80"
              style={{ background: "oklch(0.95 0 0)", color: "oklch(0.3 0 0)", border: "1px solid oklch(0.85 0 0)" }}
            >
              Cancel
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
