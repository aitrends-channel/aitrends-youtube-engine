"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { Beat } from "@/lib/types";

// ── Sub-components ─────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
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

function BeatCard({ beat }: { beat: Beat }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl overflow-hidden transition-all"
      style={{ background: "var(--bg-panel)", border: `1px solid ${expanded ? "oklch(0.72 0.25 285 / 0.2)" : "var(--bd-7)"}` }}>
      <button
        className="w-full flex items-start gap-3 p-4 text-left transition-colors"
        style={{ background: expanded ? "oklch(0.72 0.25 285 / 0.04)" : "transparent" }}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-xs font-bold"
          style={{ background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" }}>
          {beat.beatNumber}
        </span>
        <p className="text-sm flex-1 leading-relaxed line-clamp-2" style={{ color: "var(--c-60)" }}>
          {beat.scriptSegment}
        </p>
        <span className="text-xs shrink-0 mt-1" style={{ color: "var(--c-35)" }}>
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4" style={{ borderTop: "1px solid var(--bd-6)" }}>
          <div className="pt-3 rounded-lg px-3 py-2.5" style={{ background: "oklch(0.72 0.25 285 / 0.05)", border: "1px solid oklch(0.72 0.25 285 / 0.12)" }}>
            <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: "oklch(0.6 0.15 75)" }}>
              Script Segment
            </p>
            <p className="text-sm leading-relaxed font-medium" style={{ color: "var(--c-85)" }}>{beat.scriptSegment}</p>
          </div>

          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
                Image Prompt
              </p>
              <CopyButton text={beat.imagePrompt} />
            </div>
            <p className="text-sm leading-relaxed" style={{ color: "var(--c-75)" }}>{beat.imagePrompt}</p>
          </div>

          <div className="flex gap-2 flex-wrap">
            {[
              { icon: "◎", label: beat.camera, key: "camera" },
              { icon: "◈", label: beat.lighting, key: "lighting" },
              { icon: "✦", label: beat.mood, key: "mood" },
              { icon: "▷", label: beat.action, key: "action" },
            ].filter((t) => t.label).map((tag) => (
              <span key={tag.key} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs"
                style={{ background: "var(--bg-progress)", color: "var(--c-55)", border: "1px solid var(--bd-7)" }}>
                <span style={{ color: "var(--c-50)" }}>{tag.icon}</span>
                {tag.label}
              </span>
            ))}
          </div>

          {beat.videoPrompt ? (
            <div className="rounded-lg px-3 py-2.5" style={{ background: "oklch(0.6 0.15 200 / 0.05)", border: "1px solid oklch(0.6 0.15 200 / 0.15)" }}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "oklch(0.55 0.12 200)" }}>
                  Video Prompt
                </p>
                <CopyButton text={beat.videoPrompt} />
              </div>
              <p className="text-sm leading-relaxed" style={{ color: "var(--c-70)" }}>{beat.videoPrompt}</p>
            </div>
          ) : (
            <p className="text-xs italic" style={{ color: "var(--c-35)" }}>No video prompt yet — run Step 2 to generate.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Step card ──────────────────────────────────────────────────────────────

type StepStatus = "idle" | "running" | "done" | "error";

interface StepState {
  status: StepStatus;
  message: string;
  progress?: { current: number; total: number };
  error?: string;
}

interface StepCardProps {
  num: number;
  title: string;
  description: string;
  state: StepState;
  doneLabel?: string;
  disabled?: boolean;
  optional?: boolean;
  /** Custom button label for non-running, non-done states (e.g. "Generate Remaining 9"). */
  actionLabel?: string | null;
  /** When set, renders a secondary "Clear" button. The handler should wipe persisted state for this step. */
  onClear?: (() => Promise<void> | void) | null;
  onGenerate: () => void;
}

function StepCard({ num, title, description, state, doneLabel, disabled, optional, actionLabel, onClear, onGenerate }: StepCardProps) {
  const isRunning = state.status === "running";
  const isDone = state.status === "done";
  const isError = state.status === "error";

  // Time-based fake progress when the route doesn't emit real progress
  // events (single-chunk runs). Asymptotic curve so the bar never
  // visually stalls — even on long runs (multi-chunk image prompts,
  // KIE retries) it keeps creeping closer to 95% without ever pinning.
  // Time-to-target: ~50% at 45s, ~75% at 90s, ~95% at 3min.
  const RATE_CONSTANT_MS = 45000;
  const ASYMPTOTE = 95;
  const [fakePct, setFakePct] = useState(0);
  useEffect(() => {
    if (isDone) { setFakePct(100); return; }
    if (!isRunning) { setFakePct(0); return; }
    const startedAt = Date.now();
    setFakePct(0);
    const t = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setFakePct(ASYMPTOTE * (1 - Math.exp(-elapsed / RATE_CONSTANT_MS)));
    }, 80);
    return () => clearInterval(t);
  }, [isRunning, isDone]);

  // Prefer real progress when the route reports it; else use fake.
  const realPct = state.progress
    ? Math.round((state.progress.current / state.progress.total) * 100)
    : null;
  const shownPct = realPct ?? Math.round(fakePct);

  const borderColor = isDone
    ? "oklch(0.55 0.15 145 / 0.25)"
    : isRunning
    ? "oklch(0.72 0.25 285 / 0.25)"
    : isError
    ? "oklch(0.6 0.22 25 / 0.3)"
    : "var(--bd-7)";

  const bg = isRunning ? "oklch(0.72 0.25 285 / 0.03)" : "var(--bg-panel)";

  return (
    <div className="rounded-xl p-4 flex gap-4"
      style={{ background: bg, border: `1px solid ${borderColor}`, transition: "border-color 0.2s" }}>

      {/* Step badge */}
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold mt-0.5"
        style={
          isDone ? { background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.7 0.15 145)" } :
          isRunning ? { background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" } :
          isError ? { background: "oklch(0.6 0.22 25 / 0.12)", color: "oklch(0.7 0.2 25)" } :
          { background: "var(--bg-progress)", color: "var(--c-30)" }
        }>
        {isDone ? "✓" : isError ? "✕" : isRunning
          ? <span className="block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
          : num}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-sm font-semibold" style={{ color: disabled && !isDone ? "var(--c-35)" : "var(--c-85)" }}>
            {title}
          </p>
          {optional && (
            <span className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: "var(--bg-progress)", color: "var(--c-35)" }}>
              optional
            </span>
          )}
        </div>

        <p className="text-xs mb-2" style={{ color: "var(--c-40)" }}>{description}</p>

        {/* Status line */}
        {isRunning && (
          <div className="space-y-1.5">
            <p className="text-xs" style={{ color: "oklch(0.65 0.15 75)" }}>{state.message}</p>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
                <div className="h-full rounded-full transition-all duration-200"
                  style={{
                    width: `${shownPct}%`,
                    background: "oklch(0.55 0.15 145)",
                  }} />
              </div>
              <span className="text-xs shrink-0 tabular-nums font-mono"
                style={{ color: "oklch(0.7 0.15 145)" }}>
                {state.progress ? `${state.progress.current}/${state.progress.total}` : `${shownPct}%`}
              </span>
            </div>
          </div>
        )}
        {isDone && doneLabel && (
          <p className="text-xs" style={{ color: "oklch(0.6 0.15 145)" }}>{doneLabel}</p>
        )}
        {isError && (
          <p className="text-xs leading-relaxed" style={{ color: "oklch(0.65 0.15 25)" }}>{state.error}</p>
        )}
      </div>

      {/* Action buttons */}
      <div className="shrink-0 flex items-start gap-2">
        {onClear && !isRunning && (isDone || isError) && (
          <button
            onClick={() => { Promise.resolve(onClear()).catch(() => { /* surfaced via toast in caller */ }); }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity"
            style={{ background: "transparent", color: "var(--c-50)", border: "1px solid var(--bd-8)" }}
          >
            Clear
          </button>
        )}
        <button
          onClick={onGenerate}
          disabled={disabled || isRunning}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-30 transition-opacity"
          style={
            isDone || isError
              ? { background: "var(--bg-progress)", color: "var(--c-50)", border: "1px solid var(--bd-8)" }
              : { background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }
          }
        >
          {isRunning ? "Running..." : (actionLabel ?? (isDone ? "Regenerate" : isError ? "Retry" : "Generate"))}
        </button>
      </div>
    </div>
  );
}

// ── SSE helper ─────────────────────────────────────────────────────────────

// Returns true when the server signaled `done`, false when the stream
// ended without one (truncated by a proxy, idle-timeout, etc.). The
// caller decides what to do — typically refetching project state and
// trusting the DB over the SSE channel.
async function streamStep(
  url: string,
  body: object,
  onUpdate: (s: StepState) => void
): Promise<boolean> {
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
  let doneReceived = false;

  // Idle watchdog: if no bytes arrive for IDLE_MS, abort the reader and
  // exit. Some proxies leave the connection technically open but stop
  // forwarding data, which made reader.read() hang forever.
  const IDLE_MS = 60_000;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { reader.cancel().catch(() => {}); }, IDLE_MS);
  };
  resetIdle();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "status") {
            onUpdate({ status: "running", message: event.message });
          } else if (event.type === "progress") {
            onUpdate({
              status: "running",
              message: `Section ${event.current} of ${event.total}`,
              progress: { current: event.current, total: event.total },
            });
          } else if (event.type === "error") {
            throw new Error(event.message);
          } else if (event.type === "done") {
            doneReceived = true;
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  return doneReceived;
}

// ── Page ───────────────────────────────────────────────────────────────────

type Tab = "beats" | "video";

interface PageProps {
  params: { projectId: string };
}

const IDLE: StepState = { status: "idle", message: "" };

export default function PromptsPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project, mutate } = useProject(projectId);

  // Bump current_state to 13 the first time the user lands here so the
  // Visuals phase ticks done in the WizardNav. The visuals phase's
  // states array tops out at 12, but visual-analysis only bumps to 9
  // — leaving Visuals visually locked when the user is past it. State
  // 13 keeps the project past the Visuals "done" threshold without
  // crossing into Generate/Assemble territory.
  useEffect(() => {
    const reached = project?.current_state as number | undefined;
    if (reached !== undefined && reached < 13) {
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_state: 13 }),
      }).then(() => mutate()).catch(() => { /* non-blocking */ });
    }
  }, [project?.current_state, projectId, mutate]);

  const [imageStep, setImageStep] = useState<StepState>(IDLE);
  const [videoStep, setVideoStep] = useState<StepState>(IDLE);
  const [activeTab, setActiveTab] = useState<Tab>("beats");
  const [navigating, setNavigating] = useState(false);
  const [clearTarget, setClearTarget] = useState<"image" | "video" | null>(null);
  const [clearing, setClearing] = useState(false);
  // Regenerate-from-done flow. We don't reuse clearTarget because the
  // confirmation copy and post-confirm behavior differ — clearing
  // stops there; regenerating clears and then kicks off generation.
  const [regenTarget, setRegenTarget] = useState<"image" | "video" | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const beats: Beat[] = project?.beats ?? [];
  const videoBeats = beats.filter((b) => b.videoPrompt);

  const hasImageBeats = beats.length > 0;
  const hasVideoBeats = videoBeats.length > 0;

  // Remaining-work counts for resume labels. Both stages are resumable
  // server-side (per-chunk DB writes), so on any failure — including
  // credit/quota limits or upstream 500s — the retry picks up from
  // where we left off. The action label always reflects that, even
  // when zero work has been saved yet (first-chunk failure).
  const videoRemaining = beats.length > 0 ? beats.length - videoBeats.length : 0;
  const imageActionLabel = imageStep.status === "error"
    ? "Generate Remaining"
    : null;
  // Video resume requires image beats to actually exist on the server.
  // If they were cleared or never generated, fall back to the plain
  // "Retry" so users don't fire a request that can't possibly succeed.
  const videoActionLabel = videoStep.status === "error" && videoRemaining > 0 && hasImageBeats
    ? `Generate Remaining ${videoRemaining}`
    : null;

  // Derive effective step state: prefer live state, fall back to DB presence
  const effectiveImage: StepState =
    imageStep.status !== "idle" ? imageStep :
    hasImageBeats ? { status: "done", message: "" } : IDLE;

  const effectiveVideo: StepState =
    videoStep.status !== "idle" ? videoStep :
    hasVideoBeats ? { status: "done", message: "" } : IDLE;

  async function runImageStep() {
    if (!project?.script || !project?.visual_profile) {
      toast.error("Script and visual analysis required first");
      return;
    }
    setImageStep({ status: "running", message: "Starting..." });
    try {
      const doneReceived = await streamStep("/api/workflow/prompts", {
        step: "images",
        projectId,
        script: project.script,
        visualProfile: project.visual_profile,
      }, setImageStep);

      // Always refetch — the server may have finished writing beats even
      // if the SSE `done` event never reached us (proxy truncation).
      const fresh = await mutate();
      const completedOnServer = (fresh?.current_state ?? 0) >= 14;
      const freshBeats = (fresh?.beats ?? []) as Beat[];
      // Don't trust the SSE or current_state signal alone — only flip to
      // done when every beat in the DB actually carries a non-empty
      // imagePrompt. Catches silent insert failures or partial writes.
      const beatsReady = freshBeats.length > 0 && freshBeats.every((b) => !!b.imagePrompt);

      if ((doneReceived || completedOnServer) && beatsReady) {
        setImageStep({ status: "done", message: "" });
        toast.success("Image prompts generated");
        if (hasVideoBeats) setVideoStep(IDLE);
      } else if (doneReceived || completedOnServer) {
        // Server said done but beats aren't all populated — partial
        // success. Surface it instead of misleadingly showing complete.
        throw new Error("Generation reported done but some beats are missing prompts. Try again — the existing beats are preserved.");
      } else {
        throw new Error("Generation timed out — the server closed the connection before finishing. Any beats saved so far are preserved. Try again to complete the rest.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      setImageStep({ status: "error", message: "", error: msg });
    }
  }

  async function confirmClear() {
    if (!clearTarget) return;
    setClearing(true);
    try {
      const body = clearTarget === "image"
        ? { clear_image_prompts: true }
        : { clear_video_prompts: true };
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to clear");
      }
      if (clearTarget === "image") {
        setImageStep(IDLE);
        setVideoStep(IDLE); // video prompts live on the same rows
      } else {
        setVideoStep(IDLE);
      }
      await mutate();
      toast.success(clearTarget === "image" ? "Cleared image prompts" : "Cleared video prompts");
      setClearTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear");
    } finally {
      setClearing(false);
    }
  }

  async function confirmRegenerate() {
    if (!regenTarget) return;
    setRegenerating(true);
    try {
      // Clear first — image prompt regeneration would otherwise just
      // resume-skip every chunk since the server's resume logic treats
      // existing beats as already done.
      const body = regenTarget === "image"
        ? { clear_image_prompts: true }
        : { clear_video_prompts: true };
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to clear before regeneration");
      }
      if (regenTarget === "image") {
        setImageStep(IDLE);
        setVideoStep(IDLE);
      } else {
        setVideoStep(IDLE);
      }
      await mutate();
      const target = regenTarget;
      setRegenTarget(null);
      // Kick off the corresponding generation now that the slate is clean.
      if (target === "image") {
        await runImageStep();
      } else {
        await runVideoStep();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to regenerate");
    } finally {
      setRegenerating(false);
    }
  }

  async function runVideoStep() {
    // Re-check server state — image beats may have been cleared since
    // the page rendered. Pull fresh data and read the latest from the
    // response rather than relying on the SWR-cached `beats` closure.
    const fresh = await mutate();
    const freshBeats = (fresh?.beats ?? []) as Beat[];
    if (freshBeats.length === 0) {
      toast.error("Image prompts are missing — generate them first.");
      setVideoStep(IDLE);
      return;
    }
    setVideoStep({ status: "running", message: "Starting..." });
    try {
      const doneReceived = await streamStep("/api/workflow/prompts", {
        step: "videos",
        projectId,
      }, setVideoStep);

      const updated = await mutate();
      const updatedBeats = (updated?.beats ?? []) as Beat[];
      const completedOnServer =
        updatedBeats.length > 0 && updatedBeats.every((b) => !!b.videoPrompt);

      if (doneReceived || completedOnServer) {
        setVideoStep({ status: "done", message: "" });
        toast.success("Video prompts generated");
      } else {
        throw new Error("Generation timed out — the server closed the connection before finishing. Any prompts saved so far are preserved. Try again to complete the rest.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      setVideoStep({ status: "error", message: "", error: msg });
    }
  }

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "beats", label: "Image Beats", count: beats.length },
    { id: "video", label: "Video Beats", count: videoBeats.length },
  ];

  const anyRunning =
    imageStep.status === "running" ||
    videoStep.status === "running";

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={9} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 overflow-y-auto pt-[105px] md:pt-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-8 md:pr-44 py-3 sm:py-4"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)" }}>
          <div>
            <h1 className="font-bold text-base sm:text-lg">Prompt Studio</h1>
            {hasImageBeats && (
              <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                {beats.length} beats
              </p>
            )}
          </div>
        </div>

        <div className="mx-5">
        {/* Step cards */}
        <div className="px-4 sm:px-8 py-4 sm:py-5 space-y-3"
          style={{ borderBottom: hasImageBeats ? "1px solid var(--bd-6)" : "none" }}>
          <StepCard
            num={1}
            title="Image Prompts"
            description="One AI image prompt per script beat, matched to your channel's visual style"
            state={effectiveImage}
            doneLabel={beats.length > 0 ? `${beats.length} beats ready` : undefined}
            actionLabel={imageActionLabel}
            onClear={hasImageBeats && effectiveImage.status !== "done" ? () => setClearTarget("image") : null}
            onGenerate={effectiveImage.status === "done" ? () => setRegenTarget("image") : runImageStep}
          />
          <StepCard
            num={2}
            title="Video Prompts"
            description="Camera movement and motion instructions layered on top of each image beat"
            state={effectiveVideo}
            doneLabel={videoBeats.length > 0 ? `${videoBeats.length} beats ready` : undefined}
            actionLabel={videoActionLabel}
            onClear={hasVideoBeats && effectiveVideo.status !== "done" ? () => setClearTarget("video") : null}
            disabled={!hasImageBeats}
            optional
            onGenerate={effectiveVideo.status === "done" ? () => setRegenTarget("video") : runVideoStep}
          />
        </div>

        {/* Tabs + content */}
        {hasImageBeats && (
          <>
            <div className="px-4 sm:px-8 pt-4 flex gap-1"
              style={{ borderBottom: "1px solid var(--bd-6)" }}>
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="px-4 py-2 text-xs font-medium rounded-t-lg transition-all"
                  style={activeTab === tab.id ? {
                    background: "oklch(0.72 0.25 285 / 0.08)",
                    color: "oklch(0.72 0.25 285)",
                    borderBottom: "2px solid oklch(0.72 0.25 285)",
                  } : {
                    color: "var(--c-45)",
                    borderBottom: "2px solid transparent",
                  }}
                >
                  {tab.label}
                  {tab.count > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-xs"
                      style={{
                        background: activeTab === tab.id ? "oklch(0.72 0.25 285 / 0.15)" : "var(--bg-progress)",
                        color: activeTab === tab.id ? "oklch(0.72 0.25 285)" : "var(--c-45)",
                      }}>
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="px-4 sm:px-8 pt-6 pb-24 space-y-3">
              {activeTab === "beats" && beats.map((beat) => (
                <BeatCard key={beat.beatNumber} beat={beat} />
              ))}
              {activeTab === "video" && (
                videoBeats.length > 0 ? videoBeats.map((beat) => (
                  <div key={beat.beatNumber} className="rounded-xl p-4 space-y-3"
                    style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                    <div className="flex items-center gap-3">
                      <span className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0"
                        style={{ background: "oklch(0.6 0.15 200 / 0.12)", color: "oklch(0.6 0.15 200)" }}>
                        {beat.beatNumber}
                      </span>
                      <p className="text-xs line-clamp-1" style={{ color: "var(--c-50)" }}>{beat.scriptSegment}</p>
                    </div>
                    <p className="text-sm leading-relaxed" style={{ color: "var(--c-70)" }}>{beat.videoPrompt}</p>
                  </div>
                )) : (
                  <div className="text-center py-12">
                    <p className="text-sm" style={{ color: "var(--c-40)" }}>
                      Run Step 2 to generate video motion prompts.
                    </p>
                  </div>
                )
              )}
            </div>
          </>
        )}

        {/* Empty state when nothing generated yet */}
        {!hasImageBeats && imageStep.status === "idle" && (
          <div className="flex items-center justify-center py-24">
            <div className="text-center space-y-3">
              <div className="w-12 h-12 rounded-xl mx-auto flex items-center justify-center text-xl"
                style={{ background: "var(--bg-control)", border: "1px solid var(--bd-8)" }}>
                ⬡
              </div>
              <p className="text-sm font-semibold">No prompts yet</p>
              <p className="text-xs" style={{ color: "var(--c-40)" }}>
                Start with Step 1 to generate image prompts for every script beat.
              </p>
            </div>
          </div>
        )}
        </div>
      </main>

      {/* Fixed bottom bar */}
      {hasImageBeats && (
        <div
          className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}
        >
          <div className="mx-5 px-4 sm:px-8">
          <button
            onClick={() => { setNavigating(true); router.push(`/projects/${projectId}/generate`); }}
            disabled={anyRunning || navigating}
            className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
          >
            {navigating ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Loading…
              </span>
            ) : "Generate →"}
          </button>
          </div>
        </div>
      )}

      <Dialog open={!!regenTarget} onOpenChange={(open) => { if (!open && !regenerating) setRegenTarget(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {regenTarget === "image" ? "Regenerate image prompts?" : "Regenerate video prompts?"}
            </DialogTitle>
            <DialogDescription>
              {regenTarget === "image"
                ? `This will permanently delete all ${beats.length} existing image beat${beats.length === 1 ? "" : "s"} (along with any video prompts attached) and then generate fresh ones. This can't be undone.`
                : `This will permanently delete the video prompts on all ${videoBeats.length} beat${videoBeats.length === 1 ? "" : "s"} and then generate fresh ones. Image prompts stay intact. This can't be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setRegenTarget(null)}
              disabled={regenerating}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
            <button
              onClick={confirmRegenerate}
              disabled={regenerating}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.5 0.22 25)", color: "white" }}
            >
              {regenerating ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Regenerating…
                </span>
              ) : "Regenerate"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!clearTarget} onOpenChange={(open) => { if (!open && !clearing) setClearTarget(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {clearTarget === "image" ? "Clear image prompts?" : "Clear video prompts?"}
            </DialogTitle>
            <DialogDescription>
              {clearTarget === "image"
                ? `This permanently removes all ${beats.length} image beat${beats.length === 1 ? "" : "s"} from the database. Video prompts attached to those beats will also be cleared. This can't be undone.`
                : `This removes the video prompts from all ${videoBeats.length} beat${videoBeats.length === 1 ? "" : "s"}. Image prompts and beat metadata stay intact. This can't be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setClearTarget(null)}
              disabled={clearing}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
            <button
              onClick={confirmClear}
              disabled={clearing}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.5 0.22 25)", color: "white" }}
            >
              {clearing ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Clearing…
                </span>
              ) : "Clear"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
