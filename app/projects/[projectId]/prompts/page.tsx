"use client";

import { useState, useEffect, useRef, use } from "react";
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
  /** Live tally of beats Claude has emitted within the current chunk,
   *  via the route's `chunk_beat_progress` SSE event. Resets on each
   *  new `progress` event (which fires when a chunk completes). */
  liveBeatsInChunk?: number;
  error?: string;
}

interface StepCardProps {
  num: number;
  title: string;
  description: string;
  state: StepState;
  doneLabel?: string;
  /** Shown in the idle state when partial work was persisted (user
   *  stopped mid-run, or a prior error left beats behind). Lets the
   *  user see "138 generated, ~92 remaining" before clicking Resume. */
  pendingLabel?: string;
  disabled?: boolean;
  optional?: boolean;
  /** Custom button label for non-running, non-done states (e.g. "Generate Remaining 9"). */
  actionLabel?: string | null;
  /** When set, renders a secondary "Clear" button. The handler should wipe persisted state for this step. */
  onClear?: (() => Promise<void> | void) | null;
  /** Stop handler — when set and the step is running, renders a Stop button alongside the spinner. */
  onStop?: (() => void | Promise<void>) | null;
  onGenerate: () => void;
}

// Rotating engagement caption shown on the right of a StepCard while a
// chunked generation is in flight. Pure UX — the messages are static
// strings cycled every ~2.4s so the card never looks frozen during a
// 30-60s chunk where neither the progress bar nor the live beat tally
// is ticking. Section number is derived from progress (which counts
// completed chunks, so current+1 is the chunk actually in flight).
const RUNNING_CAPTIONS = [
  "Studying the script",
  "Choosing camera angles",
  "Drafting visual cues",
  "Composing the next scene",
  "Shaping the mood",
  "Polishing the prompts",
  "Wiring the visuals",
];

function RunningCaption({ progress }: { progress?: { current: number; total: number } }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % RUNNING_CAPTIONS.length), 2400);
    return () => clearInterval(t);
  }, []);
  const sectionNum = progress ? Math.min(progress.current + 1, progress.total) : null;
  return (
    <div className="hidden md:flex flex-col items-end gap-1 max-w-[180px] mt-[15px]">
      {sectionNum !== null && progress && (
        <span className="text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap"
          style={{ color: "oklch(0.65 0.15 75)" }}>
          Section {sectionNum} of {progress.total}
        </span>
      )}
      <span
        key={idx}
        className="text-[11px] italic text-right animate-pulse"
        style={{ color: "var(--c-50)" }}
      >
        {RUNNING_CAPTIONS[idx]}…
      </span>
    </div>
  );
}

function StepCard({ num, title, description, state, doneLabel, pendingLabel, disabled, optional, actionLabel, onClear, onStop, onGenerate }: StepCardProps) {
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
        {!isRunning && !isDone && !isError && pendingLabel && (
          <p className="text-xs" style={{ color: "oklch(0.65 0.15 75)" }}>{pendingLabel}</p>
        )}
        {isError && (
          <p className="text-xs leading-relaxed" style={{ color: "oklch(0.65 0.15 25)" }}>{state.error}</p>
        )}
      </div>

      {/* Right column — buttons on top, animated caption directly
          underneath the Stop button while running. */}
      <div className="shrink-0 flex flex-col items-end gap-2">
        <div className="flex items-start gap-2">
          {onClear && !isRunning && (
            <button
              onClick={() => { Promise.resolve(onClear()).catch(() => { /* surfaced via toast in caller */ }); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity"
              style={{ background: "transparent", color: "var(--c-50)", border: "1px solid var(--bd-8)" }}
            >
              Clear
            </button>
          )}
          {onStop && isRunning && (
            <button
              onClick={() => { Promise.resolve(onStop()).catch(() => { /* swallow — UI updates via state */ }); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity hover:opacity-90"
              style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
            >
              Stop
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
        {isRunning && <RunningCaption progress={state.progress} />}
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
  onUpdate: (s: StepState) => void,
  signal?: AbortSignal
): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw new Error(await res.text());
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneReceived = false;
  // Snapshot of the current StepState we've published to the caller.
  // chunk_beat_progress events arrive between status/progress updates
  // and need to MERGE — losing message or progress.current here would
  // make the section counter blink off mid-chunk.
  let localState: StepState = { status: "running", message: "" };

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
            // Status events drop progress + live count — they fire at
            // the start of the run before any chunk reports in.
            localState = { status: "running", message: event.message };
            onUpdate(localState);
          } else if (event.type === "progress") {
            // A new chunk just completed — bump section counters and
            // reset the live beat tally for the next chunk's stream.
            localState = {
              status: "running",
              message: `Section ${event.current} of ${event.total}`,
              progress: { current: event.current, total: event.total },
              liveBeatsInChunk: 0,
            };
            onUpdate(localState);
          } else if (event.type === "chunk_beat_progress") {
            // Per-beat tick during a chunk's Claude stream. Merge into
            // localState so message / progress survive the update.
            localState = { ...localState, liveBeatsInChunk: event.beatsInChunk };
            onUpdate(localState);
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
  // "User clicked Stop on this step" sticky flag. Pure UX state — overrides
  // the derived `effectiveImage`/`effectiveVideo` "done" branch so the user
  // sees Clear + Resume after a stop, not Clear + Regenerate, even when
  // the route happened to write `current_state >= 14` before the abort
  // landed. Cleared the moment the user picks an explicit next action
  // (Resume kicks off a new run; Clear wipes state).
  const [imageStoppedByUser, setImageStoppedByUser] = useState(false);
  const [videoStoppedByUser, setVideoStoppedByUser] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("beats");
  const [navigating, setNavigating] = useState(false);
  // Per-step AbortControllers so the user's Stop click can kill the
  // local SSE fetch alongside the server-side run-id PATCH. Without
  // the abort the fetch keeps the connection open until the server
  // closes it (a few seconds later when its next assertPromptsRunActive
  // fires); the abort makes the UI snap to "stopped" instantly.
  const imageAbortRef = useRef<AbortController | null>(null);
  const videoAbortRef = useRef<AbortController | null>(null);
  const [clearTarget, setClearTarget] = useState<"image" | "video" | null>(null);
  const [clearing, setClearing] = useState(false);
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
  // Video resume requires image beats to actually exist on the server.
  // If they were cleared or never generated, fall back to the plain
  // "Retry" so users don't fire a request that can't possibly succeed.
  const videoActionLabel = videoStep.status === "error" && videoRemaining > 0 && hasImageBeats
    ? `Generate Remaining ${videoRemaining}`
    : null;

  // Server-side run flag — set when ANY prompts generation is in flight
  // (image OR video). On a fresh page load after refresh/nav-away, local
  // step state is "idle" but project.prompts_active_run_id is still
  // populated by the running route; surface that as "running" so the
  // user sees a spinner instead of an idle StepCard with a Generate
  // button they could accidentally double-click.
  const remoteRunInProgress = !!project?.prompts_active_run_id;
  // True image-step completion lives in `current_state >= 14` — the route
  // only writes that after the final chunk finishes and every beat has
  // an image_prompt. `beats.every(b => !!b.imagePrompt)` alone is NOT a
  // safe completion signal: mid-run, the chunks that already persisted
  // each carry their imagePrompt, so `every` is trivially true the moment
  // chunk 1 lands and the UI would otherwise flip to "done" while the
  // server is still working on chunks 2..N.
  const imageStepCompleteOnServer =
    (project?.current_state ?? 0) >= 14
    && hasImageBeats
    && beats.every((b) => !!b.imagePrompt);
  // No local activity but a server run is going AND image isn't yet
  // marked complete → must be the image step running. SWR's 5s refresh
  // (see useProject) is what eventually flips this off.
  //
  // Note: we deliberately do NOT derive a `videoRemoteRunning` flag.
  // `prompts_active_run_id` is shared between the image and video
  // routes — there's no way to tell which step claimed it from the
  // client. The video step only enters a running state via an explicit
  // local click.
  const imageRemoteRunning =
    remoteRunInProgress && imageStep.status === "idle" && videoStep.status === "idle" && !imageStepCompleteOnServer;

  // Partial work the user can resume — beats already persisted but the
  // step never reached the server's "complete" mark (current_state >= 14),
  // OR the user explicitly clicked Stop (we honour their intent even if
  // a racing completion check inside the route had already flipped
  // current_state to 14). The route's chunk walk natively resumes
  // (skips chunks already covered by existing beats), so clicking
  // Resume just continues from where the last run left off — no
  // destructive regenerate needed.
  // Resumable covers three cases:
  //  (1) Partial beats persisted + step not server-complete (normal
  //      mid-run Stop with some chunks done).
  //  (2) User clicked Stop — regardless of whether beats landed yet.
  //      Even with 0 beats, the in-flight chunk Claude was working on
  //      will still persist (the route no longer asserts-active
  //      between Claude completion and DB insert) and the user needs
  //      a Resume button to pick the work back up.
  //  (3) Step had previously completed but the user stopped a regen
  //      mid-flight (imageStoppedByUser flips on then).
  const imageStepResumable =
    (hasImageBeats && !imageStepCompleteOnServer) || imageStoppedByUser;
  const imageActionLabel = imageStep.status === "error"
    ? "Resume"
    : (imageStepResumable && imageStep.status === "idle")
    ? "Resume"
    : null;

  // Estimate the target beat count from the script's word count so the
  // image-step progress bar can show actual progress on reconnect
  // instead of restarting at 0. The prompt instructs Claude to produce
  // roughly one beat per 12 words of narration; this is approximate
  // (a long-form script will land anywhere in the 10–15 words/beat
  // range) but it's enough to give the user a meaningful "halfway
  // there" instead of "starting from scratch". Capped so the visible
  // percentage never claims to be more than 99% before the actual
  // done signal flips the card to its done state.
  const scriptWords = (project?.word_count as number | undefined) ?? 0;
  const estimatedTotalBeats = scriptWords > 0 ? Math.max(1, Math.ceil(scriptWords / 12)) : 0;
  const imageProgress = estimatedTotalBeats > 0
    ? { current: Math.min(beats.length, estimatedTotalBeats - 1), total: estimatedTotalBeats }
    : undefined;
  // When the step is resumable surface a status line so the user can
  // see the work-so-far before deciding Resume vs Clear. Three flavors:
  //  • beats persisted → "N generated, ~M remaining"
  //  • stopped before any beats landed, in-flight chunk likely still
  //    finishing server-side → "0 generated, first segment still
  //    processing". SWR's 5s poll picks up the chunk's beats when
  //    they land and the label flips to the first variant.
  //  • no script word_count yet → bare "N generated"
  // estimatedTotalBeats is approximate (~1 beat per 12 script words),
  // so the remaining count is prefixed with "~" — accurate enough to
  // be useful, honest enough not to mislead.
  const imagePendingLabel = imageStepResumable
    ? !hasImageBeats
      ? "0 generated, first segment still processing"
      : estimatedTotalBeats > 0
        ? `${beats.length} generated, ~${Math.max(0, estimatedTotalBeats - beats.length)} remaining`
        : `${beats.length} generated`
    : undefined;

  // Derive effective step state: prefer live state, then server-side
  // remote run, then DB presence. The "running" branch here only fires
  // on refresh / nav-away → return; in that case we synthesize a fresh
  // running state with real progress derived from the persisted beat
  // count so the user sees actual work instead of an idle bar.
  const baseImage: StepState =
    imageStep.status !== "idle" ? imageStep :
    imageStoppedByUser ? IDLE :
    imageRemoteRunning ? {
      status: "running",
      message: estimatedTotalBeats > 0
        ? `Generating — ${beats.length} of ~${estimatedTotalBeats} beats generated`
        : hasImageBeats
          ? `Generating — ${beats.length} beats so far, still generating`
          : "Generating — still generating in the background",
      progress: imageProgress,
    } :
    imageStepCompleteOnServer ? { status: "done", message: "" } : IDLE;

  // Rewrite the running message to combine the live persisted beat
  // count with the current chunk's section progress and, when
  // available, the per-beat tally Claude is streaming for the chunk
  // in flight. streamStep emits a generic "Section N of M" message;
  // the page knows beats.length (persisted), section indices, and the
  // live in-chunk beat count, and composes the richer line:
  //   "X ready, section N/M (Y beats in this section)"
  // Only rewrite for the streamStep case — the Generating-after-refresh
  // branch already has its own beat-count-aware message and doesn't
  // have real chunk indices or a live tally to point at.
  const effectiveImage: StepState =
    baseImage.status === "running" && baseImage.progress && baseImage.message.startsWith("Section ")
      ? {
          ...baseImage,
          message: typeof baseImage.liveBeatsInChunk === "number" && baseImage.liveBeatsInChunk > 0
            ? `${beats.length} ready, section ${baseImage.progress.current}/${baseImage.progress.total} (${baseImage.liveBeatsInChunk} beats in this section)`
            : `${beats.length} ready, section ${baseImage.progress.current} in progress (${baseImage.progress.current}/${baseImage.progress.total})`,
        }
      : baseImage;

  const effectiveVideo: StepState =
    videoStep.status !== "idle" ? videoStep :
    videoStoppedByUser ? IDLE :
    hasVideoBeats ? { status: "done", message: "" } : IDLE;

  async function runImageStep() {
    if (!project?.script || !project?.visual_profile) {
      toast.error("Script and visual analysis required first");
      return;
    }
    // User picked Resume (or Generate). Clear the "stopped" sticky so
    // the derived state reflects the new run rather than the prior
    // user-initiated stop.
    setImageStoppedByUser(false);
    setImageStep({ status: "running", message: "Starting..." });
    imageAbortRef.current = new AbortController();
    try {
      const doneReceived = await streamStep("/api/workflow/prompts", {
        step: "images",
        projectId,
        script: project.script,
        visualProfile: project.visual_profile,
      }, setImageStep, imageAbortRef.current.signal);

      // The SSE channel is unreliable — Vercel edge / intermediate
      // proxies routinely truncate long-lived streams, and a single
      // chunk's progress event can arrive seconds before the route's
      // remaining workers actually settle. Treating stream end == work
      // end caused the card to flip to "done" mid-run after the first
      // chunk persisted (status: "running" → status: "done") because
      // the route's success-path `current_state: 14` write hadn't
      // landed yet but the SSE stream had already closed.
      //
      // Instead: poll the project row until we have an authoritative
      // signal. The route only writes `current_state >= 14` after the
      // full worker pool settles successfully; on failure it clears
      // `prompts_active_run_id` (via the try/finally in the route).
      // Either signal terminates the loop. Until then, keep the card
      // in "running" with live beat counts and a Stop button.
      const POLL_MS = 3000;
      let fresh = await mutate();
      while (true) {
        if (imageAbortRef.current?.signal.aborted) {
          setImageStep(IDLE);
          await mutate();
          return;
        }
        const freshBeats = (fresh?.beats ?? []) as Beat[];
        const completedOnServer = (fresh?.current_state ?? 0) >= 14;
        const beatsReady = freshBeats.length > 0 && freshBeats.every((b) => !!b.imagePrompt);
        const serverStillActive = !!fresh?.prompts_active_run_id;

        if (completedOnServer && beatsReady) {
          setImageStep({ status: "done", message: "" });
          toast.success("Image prompts generated");
          if (hasVideoBeats) setVideoStep(IDLE);
          return;
        }
        if (completedOnServer) {
          throw new Error("Generation reported done but some beats are missing prompts. Try again — the existing beats are preserved.");
        }
        if (!serverStillActive) {
          // Route released its run id without writing current_state=14
          // → it threw and the finally cleared the flag. Surface as
          // error so the user can retry.
          throw new Error(doneReceived
            ? "Generation reported done but the server didn't mark the step complete. Try again — the existing beats are preserved."
            : "Generation stopped before completing. Any beats saved so far are preserved. Try again to complete the rest.");
        }

        // Server is still working — keep the card live.
        setImageStep({
          status: "running",
          message: estimatedTotalBeats > 0
            ? `Generating — ${freshBeats.length} of ~${estimatedTotalBeats} beats so far`
            : `Generating — ${freshBeats.length} beats so far`,
          progress: estimatedTotalBeats > 0
            ? { current: Math.min(freshBeats.length, estimatedTotalBeats - 1), total: estimatedTotalBeats }
            : undefined,
        });

        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, POLL_MS);
          imageAbortRef.current?.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
        });
        fresh = await mutate();
      }
    } catch (err) {
      // User-initiated Stop comes through as an AbortError — don't
      // surface that as a failure. Whatever was persisted before the
      // abort is still in the DB.
      if (err instanceof Error && err.name === "AbortError") {
        setImageStep(IDLE);
        await mutate();
      } else {
        const msg = err instanceof Error ? err.message : "Failed";
        setImageStep({ status: "error", message: "", error: msg });
      }
    } finally {
      imageAbortRef.current = null;
    }
  }

  // Intercept onGenerate when the step is already complete: a click on
  // "Regenerate" is destructive (it wipes finished beats) and must pass
  // through a confirmation modal first. Idle/error states fire the
  // normal run path — the route's chunk-resume logic keeps partial
  // beats and only fills the gap.
  function requestRunImageStep() {
    if (effectiveImage.status === "done") { setRegenTarget("image"); return; }
    runImageStep();
  }
  function requestRunVideoStep() {
    if (effectiveVideo.status === "done") { setRegenTarget("video"); return; }
    runVideoStep();
  }

  async function confirmRegen() {
    if (!regenTarget) return;
    setRegenerating(true);
    try {
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
        throw new Error(err.error ?? "Failed to clear before regenerating");
      }
      const target = regenTarget;
      // Image clear also wipes video prompts (they live on the same
      // rows), mirroring confirmClear above.
      if (target === "image") {
        setImageStep(IDLE);
        setVideoStep(IDLE);
      } else {
        setVideoStep(IDLE);
      }
      await mutate();
      setRegenTarget(null);
      setRegenerating(false);
      if (target === "image") {
        await runImageStep();
      } else {
        await runVideoStep();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to regenerate");
      setRegenerating(false);
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
        setImageStoppedByUser(false);
        setVideoStoppedByUser(false);
      } else {
        setVideoStep(IDLE);
        setVideoStoppedByUser(false);
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
    setVideoStoppedByUser(false);
    setVideoStep({ status: "running", message: "Starting..." });
    videoAbortRef.current = new AbortController();
    try {
      const doneReceived = await streamStep("/api/workflow/prompts", {
        step: "videos",
        projectId,
      }, setVideoStep, videoAbortRef.current.signal);

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
      if (err instanceof Error && err.name === "AbortError") {
        setVideoStep(IDLE);
        await mutate();
      } else {
        const msg = err instanceof Error ? err.message : "Failed";
        setVideoStep({ status: "error", message: "", error: msg });
      }
    } finally {
      videoAbortRef.current = null;
    }
  }

  // Stop handler shared by both StepCards. Two-sided cancellation
  // matching the script step:
  //   1) Null prompts_active_run_id so the server-side run's next
  //      assertPromptsRunActive throws and exits cleanly.
  //   2) Abort the local SSE fetch (if any) so the UI snaps to "stopped"
  //      instantly instead of waiting up to a chunk-cycle for the server
  //      to close the stream.
  // Beats already persisted to the DB are kept.
  async function handleStopPrompts() {
    // Capture which step the user was actually stopping. A non-null
    // abort ref means runImageStep/runVideoStep is still in flight on
    // this client — that's what they Stop button is acting on.
    const wasImageActive = !!imageAbortRef.current;
    const wasVideoActive = !!videoAbortRef.current;
    if (imageAbortRef.current) {
      try { imageAbortRef.current.abort(); } catch { /* ignore */ }
      imageAbortRef.current = null;
    }
    if (videoAbortRef.current) {
      try { videoAbortRef.current.abort(); } catch { /* ignore */ }
      videoAbortRef.current = null;
    }
    // Force the step the user actively stopped to IDLE, regardless of
    // whether a racing completion check inside the polling loop just
    // flipped it to "done". User-initiated Stop wins.
    if (wasImageActive) {
      setImageStep(IDLE);
      setImageStoppedByUser(true);
    }
    if (wasVideoActive) {
      setVideoStep(IDLE);
      setVideoStoppedByUser(true);
    }
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompts_active_run_id: null }),
      });
      await mutate();
    } catch {
      // Best-effort — the local abort is the more important signal.
    }
  }

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "beats", label: "Image Beats", count: beats.length },
    { id: "video", label: "Video Beats", count: videoBeats.length },
  ];

  const anyRunning =
    imageStep.status === "running" ||
    videoStep.status === "running";

  // Hash the current script in the browser so we can compare it against
  // the hash stored when these beats were generated. If they differ, the
  // saved beats describe an older version of the script and the user
  // should be warned before they continue downstream into images/videos.
  // Mirrors the voiceover-stale detection on the generate page.
  const [currentScriptHash, setCurrentScriptHash] = useState<string | null>(null);
  useEffect(() => {
    const script = project?.script as string | undefined;
    if (!script) { setCurrentScriptHash(null); return; }
    let cancelled = false;
    (async () => {
      const buf = new TextEncoder().encode(script);
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (!cancelled) setCurrentScriptHash(hex);
    })();
    return () => { cancelled = true; };
  }, [project?.script]);
  const beatsStale = hasImageBeats
    && !anyRunning
    && !remoteRunInProgress
    && !!project?.prompts_script_hash
    && !!currentScriptHash
    && project.prompts_script_hash !== currentScriptHash;

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={9} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 overflow-y-auto pt-[105px] md:pt-0">
        {/* Header */}
        

        <div className="mx-5">
        {/* Step cards. md:pr-44 keeps the right-edge action buttons
            (Clear/Resume/Regenerate) clear of the fixed top-right
            Back + ThemeToggle + Profile cluster in WizardNav. md:pt-16
            drops the first card below that cluster's vertical band so
            they don't visually collide near the top edge. */}
        <div className="px-4 sm:px-8 md:pr-44 py-4 sm:py-5 md:pt-16 space-y-3"
          style={{ borderBottom: hasImageBeats ? "1px solid var(--bd-6)" : "none" }}>
          {beatsStale && (
            <div className="rounded-xl px-3 py-2.5 flex items-start gap-2 text-xs"
              style={{ background: "oklch(0.72 0.16 70 / 0.12)", border: "1px solid oklch(0.72 0.16 70 / 0.35)", color: "oklch(0.85 0.12 70)" }}>
              <span aria-hidden>⚠</span>
              <span>
                Script was edited after these beats were generated. The image prompts below no longer match your current script — click <strong>Regenerate</strong> to update them.
              </span>
            </div>
          )}
          <StepCard
            num={1}
            title="Image Prompts"
            description="One AI image prompt per script beat, matched to your channel's visual style"
            state={effectiveImage}
            doneLabel={beats.length > 0 ? `${beats.length} beats ready` : undefined}
            pendingLabel={imagePendingLabel}
            actionLabel={imageActionLabel}
            onClear={hasImageBeats ? () => setClearTarget("image") : null}
            onStop={handleStopPrompts}
            onGenerate={requestRunImageStep}
          />
          <StepCard
            num={2}
            title="Video Prompts"
            description="Camera movement and motion instructions layered on top of each image beat"
            state={effectiveVideo}
            doneLabel={videoBeats.length > 0 ? `${videoBeats.length} beats ready` : undefined}
            actionLabel={videoActionLabel}
            onClear={hasVideoBeats ? () => setClearTarget("video") : null}
            onStop={handleStopPrompts}
            disabled={!hasImageBeats}
            optional
            onGenerate={requestRunVideoStep}
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
                ? `This discards all ${beats.length} existing image beat${beats.length === 1 ? "" : "s"} (and any video prompts attached to them) and rebuilds them from your current script. This can't be undone.`
                : `This discards the existing video prompts on all ${videoBeats.length} beat${videoBeats.length === 1 ? "" : "s"} and rebuilds them. Image prompts and beat metadata stay intact. This can't be undone.`}
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
              onClick={confirmRegen}
              disabled={regenerating}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              {regenerating ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Clearing…
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
