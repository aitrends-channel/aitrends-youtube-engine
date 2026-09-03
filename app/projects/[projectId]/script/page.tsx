"use client";

import { useState, use, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { StepCostCard } from "@/components/StepCostCard";
import { CostTipsModal } from "@/components/CostTipsModal";
import { StepBalanceCard } from "@/components/StepBalanceCard";
import { useProject } from "@/hooks/useProject";
import { useStreamingScript } from "@/hooks/useStreamingScript";
import { getEffectiveScriptTargetWordCount } from "@/lib/claude/prompts";
import { friendlyError } from "@/lib/errors/friendly";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface PageProps {
  params: { projectId: string };
}

// Rotating engagement caption shown during script generation. Pure UX —
// the messages are static script-themed strings cycled every ~2.4s so
// the UI never looks frozen during the 5-30s gap between hitting
// Generate and tokens actually starting to stream (Anthropic via KIE
// has noticeable think-time before the first chunk). Same pattern as
// the prompts page's RunningCaption.
const SCRIPT_RUNNING_CAPTIONS = [
  "Reviewing the topic",
  "Outlining the structure",
  "Drafting the opening hook",
  "Shaping the narrative arc",
  "Pacing the beats",
  "Matching the channel's voice",
  "Refining the wording",
  "Tightening the transitions",
];

function ScriptRunningCaption({ size = "md", emphasis = false }: { size?: "sm" | "md"; emphasis?: boolean }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % SCRIPT_RUNNING_CAPTIONS.length), 2400);
    return () => clearInterval(t);
  }, []);
  if (emphasis) {
    // Hero placement — fills the previous "Your script is still being
    // generated…" blurb slot, so it needs to be the visual anchor of
    // the panel: brand color, semibold, larger text.
    return (
      <p
        key={idx}
        className="text-base font-semibold animate-pulse"
        style={{ color: "var(--brand-text)" }}
      >
        {SCRIPT_RUNNING_CAPTIONS[idx]}…
      </p>
    );
  }
  return (
    <span
      key={idx}
      className={`${size === "sm" ? "text-[11px]" : "text-xs"} italic animate-pulse`}
      style={{ color: "var(--c-50)" }}
    >
      {SCRIPT_RUNNING_CAPTIONS[idx]}…
    </span>
  );
}

// Swallows pointer events for a moment after the Continue bar mounts.
// The bar only appears once the script is non-empty, so a bulk paste
// makes it materialize UNDER the user's cursor mid-interaction — the
// very next click (positioning the caret, dismissing the context
// menu) landed on "Continue →" and silently advanced to the Visuals
// step. A short pointer-events dead zone absorbs exactly that class
// of layout-shift misclick without delaying deliberate clicks
// noticeably.
function ContinueBarGuard({ children }: { children: React.ReactNode }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 500);
    return () => clearTimeout(t);
  }, []);
  return <div style={armed ? undefined : { pointerEvents: "none", opacity: 0.85 }}>{children}</div>;
}

export default function ScriptPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project, mutate } = useProject(projectId);
  const { script, setScript, isStreaming, streamingRef, wordCount, error, startStreaming, stopStreaming } =
    useStreamingScript();

  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  // Manual-writing mode: opens the editor with an empty textarea
  // instead of streaming. Persisted as projects.script_source so a
  // reload doesn't misread the manual draft as a paused AI generation
  // (both look like "script present, current_state < 7").
  const [manualMode, setManualMode] = useState(false);
  const scriptIsManual = manualMode || project?.script_source === "manual";
  const [saving, setSaving] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  // Submitting flag for the Regenerate confirm dialog. Holds the modal
  // open with a spinner during the slow wipe (PATCH × 2, R2 prefix
  // delete) instead of dismissing instantly — otherwise the user
  // clicks Regenerate and stares at an empty editor for ~2s with no
  // feedback that anything is happening. Closes when the wipe is done
  // and the new stream kick-off has started.
  const [regenSubmitting, setRegenSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Mirrors the script-route cap so the on-screen "Channel Avg" target
  // matches what the model was asked to hit. For channels whose true
  // average exceeds the 45-min consent gate we display the capped
  // value, not the raw channel average.
  const rawTarget = project?.target_word_count ?? project?.channel_analysis?.targetWordCount ?? 900;
  const targetWordCount = project?.channel_analysis
    ? getEffectiveScriptTargetWordCount({
        targetWordCount: rawTarget,
        wordsPerSecond: project.channel_analysis.wordsPerSecond,
      })
    : rawTarget;
  // Paused-draft state: a previous generation was Stopped, partial was
  // saved, current_state never reached 7 (the success-save sentinel).
  // No active run id either — distinguishes from "still generating in
  // the background", which has its own UI.
  const isPausedDraft =
    !!script &&
    !isStreaming &&
    !scriptIsManual &&
    !project?.script_active_run_id &&
    (project?.current_state ?? 0) < 7;
  const deviation = Math.abs(wordCount - targetWordCount) / targetWordCount;
  const wordCountOk = deviation <= 0.05;

  // True once this viewer has typed. Until then the textarea is a view of the
  // row, not a draft, so it can keep following a run happening elsewhere.
  const editedRef = useRef(false);

  // Load saved script/topic from DB — but never overwrite an active stream
  useEffect(() => {
    if (streamingRef.current) return;
    if (project?.script && !script) {
      setScript(project.script);
    }
    if (project?.selected_topic && !selectedTopic) {
      setSelectedTopic(project.selected_topic);
    }
  }, [project]);

  // Follow a run happening somewhere else: another tab, or an admin acting as
  // this account. The route checkpoints the partial script onto the row every
  // 3,000 characters and useProject polls faster while a run is in flight, so
  // mirroring the row is enough to watch it being written. Guarded on not
  // having typed here, so it can never eat an edit.
  useEffect(() => {
    if (streamingRef.current || editedRef.current) return;
    const fromDb = project?.script;
    if (typeof fromDb === "string" && fromDb && fromDb !== script) {
      setScript(fromDb);
    }
  }, [project?.script, project?.script_active_run_id]);

  useEffect(() => {
    // Never surface a raw provider payload — friendlyError maps upstream
    // errors (LLM 500s, rate limits, key problems) to something actionable.
    if (error) toast.error(friendlyError(error));
  }, [error]);


  async function generateScript(topic: string) {
    setSelectedTopic(topic);
    setManualMode(false);
    // Mark the source before streaming so a mid-stream reload doesn't
    // leave a stale 'manual' marker suppressing the paused-draft UI.
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script_source: "generated" }),
    }).catch(() => { /* best-effort — NULL is treated as generated */ });
    await startStreaming(projectId, project?.channel_analysis, topic);
  }

  async function chooseManual() {
    setManualMode(true);
    // Persist immediately: the paused-draft heuristic must never see a
    // manual draft, even after refresh with zero words typed.
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script_source: "manual" }),
    }).catch(() => { /* local manualMode still gates this session */ });
    mutate();
    textareaRef.current?.focus();
  }

  async function saveScript() {
    if (!script.trim()) return;
    setSaving(true);
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: script.trim(), word_count: wordCount, selected_topic: selectedTopic }),
      });
      toast.success("Script saved");
    } catch {
      toast.error("Couldn\u2019t save your script \u2014 check your connection and try again");
    } finally {
      setSaving(false);
    }
  }

  async function handleRegenerate() {
    if (!selectedTopic) return;
    setRegenSubmitting(true);
    // Atomic clear before the new run: zero the DB script, the local
    // hook state, and any stale script_active_run_id. Without this,
    // a failed regen lets SWR re-hydrate the old text the next time
    // isStreaming flips back to false, and the user sees stale content
    // instead of being returned to the Generate button.
    editedRef.current = false;
    setScript("");
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: null, word_count: 0, script_active_run_id: null }),
      });
      // Full downstream wipe: re-scripting invalidates everything
      // generated against the old text — image prompts, video prompts,
      // image files, video clips, per-beat voiceovers, the assembled
      // mp4, thumbnails, every cached preview. clear_for_script_regen
      // deletes the project's entire R2 prefix, every beat row, every
      // thumbnail row, and resets all derived columns on the project
      // row in one atomic call. Matches user expectation: re-script
      // means re-everything-downstream.
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_for_script_regen: true }),
      });
      await mutate();
    } catch { /* best-effort — the new stream will overwrite on success */ }
    // Close the modal AFTER the wipe completes — the user has now seen
    // the spinner the entire time the destructive work was running.
    // generateScript starts streaming below; the editor's own progress
    // UI takes over from here, so dismissing is safe.
    setRegenSubmitting(false);
    setConfirmRegen(false);
    await generateScript(selectedTopic);
  }

  // Two-sided stop: aborts the local SSE fetch (if any) and nulls
  // script_active_run_id on the server. The route's catch branch now
  // saves the partial so the user can Resume or Cancel from a draft
  // state. mutate() flushes SWR so the UI transitions immediately.
  const [stopping, setStopping] = useState(false);
  async function handleStop() {
    if (stopping) return;
    setStopping(true);
    try {
      await stopStreaming(projectId);
    } finally {
      setStopping(false);
      mutate();
    }
  }

  // Resume: pick up exactly where the saved draft ends via assistant
  // prefill on the server. Costs only continuation tokens, not a full
  // re-run from scratch.
  const [resuming, setResuming] = useState(false);
  async function handleResume() {
    if (resuming || !selectedTopic) return;
    setResuming(true);
    try {
      await startStreaming(projectId, project?.channel_analysis, selectedTopic, {
        mode: "continue",
        startWith: script,
      });
    } finally {
      setResuming(false);
    }
  }

  // Cancel from the paused state: wipe the draft and current_state so
  // the page returns to the "Generate Script" entry point. Confirmed
  // by the modal-style confirm flow already set up for regenerate.
  const [cancellingDraft, setCancellingDraft] = useState(false);
  async function handleCancelDraft() {
    if (cancellingDraft) return;
    setCancellingDraft(true);
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: null, word_count: 0, script_active_run_id: null }),
      });
      editedRef.current = false;
      setScript("");
      mutate();
    } finally {
      setCancellingDraft(false);
    }
  }

  async function handleContinue() {
    if (!script.trim()) { toast.error("Write or generate a script first"); return; }
    setNavigating(true);
    await saveScript();
    if ((project?.current_state ?? 0) < 7) {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_state: 7 }),
      });
    }
    router.push(`/projects/${projectId}/visuals`);
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={6} highestState={project?.current_state} channelName={project?.channel_name} channelUrl={project?.channel_url} />

      <main className="flex-1 flex flex-col overflow-hidden pt-14 md:pt-0 lg:px-[15px]">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-5 sm:px-8 md:pr-44 py-3 sm:py-4 shrink-0"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div className="flex-1 min-w-0 mr-2">
            <h1 className="font-bold text-base sm:text-lg text-foreground">Script Editor</h1>
            {selectedTopic && (
              <p className="text-xs truncate max-w-xs mt-0.5" style={{ color: "var(--c-50)" }}>
                {selectedTopic}
              </p>
            )}
            <div className="mt-3 flex items-center gap-2 flex-wrap min-w-0 w-full">
              <StepCostCard projectId={projectId} column="script" />
              <StepBalanceCard />
              <CostTipsModal />
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto pb-[70px] px-5 py-4 sm:p-8">
          {/* Background-generation state — user refreshed mid-stream
              or has another tab generating. project.script_active_run_id
              is the server-side "in flight" flag; useProject's 5s SWR
              poll picks up project.script the moment the run finishes
              and the next render switches to the script-display branch. */}
          {!script && !isStreaming && project?.script_active_run_id && (
            <div className="max-w-xl mx-auto">
              <div className="text-center space-y-5 p-10 rounded-2xl"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <div className="flex justify-center">
                  <div className="w-10 h-10 border-2 rounded-full animate-spin"
                    style={{ borderColor: "oklch(0.72 0.25 285 / 0.3)", borderTopColor: "oklch(0.72 0.25 285)" }} />
                </div>
                <div className="space-y-3">
                  <p className="text-base font-medium text-foreground">Generation in progress</p>
                  <ScriptRunningCaption emphasis />
                </div>
                {project?.selected_topic && (
                  <div className="pt-2 border-t" style={{ borderColor: "var(--bd-6)" }}>
                    <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--c-40)" }}>Topic</p>
                    <p className="text-sm font-medium text-foreground">{project.selected_topic}</p>
                  </div>
                )}
                <button
                  onClick={handleStop}
                  disabled={stopping}
                  className="px-4 py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-50"
                  style={{ background: "transparent", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                >
                  {stopping ? "Stopping…" : "Stop generation"}
                </button>
              </div>
            </div>
          )}

          {/* No-script state — the user chooses how the script gets
              written: AI generation (streams into the editor) or
              manual (opens an empty editor). Nothing starts on its
              own. */}
          {!script && !isStreaming && !manualMode && !project?.script_active_run_id && (
            <div className="max-w-xl mx-auto">
              {project?.selected_topic ? (
                <div className="text-center space-y-5 p-10 rounded-2xl"
                  style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Topic</p>
                    <p className="text-base font-medium text-foreground">{project.selected_topic}</p>
                  </div>
                  <div className="flex flex-col sm:flex-row items-stretch justify-center gap-3">
                    <button
                      onClick={() => generateScript(project.selected_topic!)}
                      className="px-8 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                    >
                      Generate with AI
                    </button>
                    <button
                      onClick={chooseManual}
                      className="px-8 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                      style={{ background: "transparent", border: "1px solid var(--bd-8)", color: "var(--c-60)" }}
                    >
                      Write manually
                    </button>
                  </div>
                  <p className="text-xs" style={{ color: "var(--c-40)" }}>
                    AI matches your channel&apos;s style and length · manual gives you full control
                  </p>
                </div>
              ) : (
                <div className="text-center p-10 space-y-4">
                  <p className="text-sm" style={{ color: "var(--c-45)" }}>No topic selected yet.</p>
                  <button
                    onClick={() => router.push(`/projects/${projectId}/topic`)}
                    className="px-5 py-2 rounded-xl text-sm font-medium transition-all"
                    style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-8)", color: "var(--c-60)" }}
                  >
                    ← Choose a Topic
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Script display / editor — also opens (empty) in manual
              mode so the user can start typing right away. */}
          {(script || isStreaming || manualMode) && (
            <div className="mb-[50px]">
              <div className="rounded-2xl overflow-hidden"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                {/* Script header bar */}
                <div className="flex items-center justify-between px-5 py-3"
                  style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-card-subtle)" }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="w-2 h-2 rounded-full"
                      style={{
                        background: isStreaming ? "oklch(0.72 0.25 285)" : isPausedDraft ? "oklch(0.72 0.18 65)" : "oklch(0.55 0.15 145)",
                        boxShadow: isStreaming ? "0 0 6px oklch(0.72 0.25 285)" : isPausedDraft ? "0 0 6px oklch(0.72 0.18 65 / 0.6)" : "none",
                      }}
                    />
                    <span className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
                      {isStreaming ? "Generating..." : isPausedDraft ? "Draft — paused" : "Script"}
                    </span>
                    {isPausedDraft && (
                      <>
                        <button
                          onClick={handleResume}
                          disabled={resuming || cancellingDraft}
                          className="ml-1 text-[11px] font-semibold px-2.5 py-1 rounded-md transition-all hover:opacity-90 disabled:opacity-50"
                          style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                        >
                          {resuming ? "Resuming…" : "Resume"}
                        </button>
                        <button
                          onClick={handleCancelDraft}
                          disabled={resuming || cancellingDraft}
                          className="text-[11px] font-medium px-2.5 py-1 rounded-md transition-all hover:opacity-90 disabled:opacity-50"
                          style={{ background: "transparent", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                        >
                          {cancellingDraft ? "…" : "Cancel"}
                        </button>
                      </>
                    )}
                    {isStreaming && (() => {
                      const pct = Math.min(100, Math.round((wordCount / targetWordCount) * 100));
                      return (
                        <>
                          <div className="w-24 sm:w-32 h-1 rounded-full overflow-hidden ml-1"
                            style={{ background: "var(--bg-track)" }}>
                            <div className="h-full rounded-full transition-all duration-200"
                              style={{
                                width: `${pct}%`,
                                background: "oklch(0.55 0.15 145)",
                              }}
                            />
                          </div>
                          <span className="text-xs font-mono tabular-nums"
                            style={{ color: "oklch(0.7 0.15 145)", minWidth: "2.5em" }}>
                            {pct}%
                          </span>
                          <button
                            onClick={handleStop}
                            disabled={stopping}
                            className="ml-2 text-[10px] font-medium px-2 py-0.5 rounded-md transition-all hover:opacity-90 disabled:opacity-50"
                            style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.3)", color: "oklch(0.7 0.22 25)" }}
                          >
                            {stopping ? "…" : "Stop"}
                          </button>
                        </>
                      );
                    })()}
                  </div>
                  <div className="flex items-center gap-2">
                    {script && (
                      <div className="flex items-stretch gap-1.5 text-[10px] font-mono">
                        {(() => {
                          const showGreen = isStreaming || wordCountOk;
                          return (
                            <div className="flex flex-col items-center px-2.5 py-1 rounded-lg"
                              style={{
                                background: showGreen ? "oklch(0.55 0.15 145 / 0.1)" : "oklch(0.72 0.25 285 / 0.1)",
                                border: `1px solid ${showGreen ? "oklch(0.55 0.15 145 / 0.3)" : "oklch(0.72 0.25 285 / 0.3)"}`,
                                color: showGreen ? "oklch(0.7 0.15 145)" : "var(--brand-text)",
                              }}>
                              <span className="text-[10px] uppercase tracking-wide" style={{ opacity: 0.7 }}>Your Script</span>
                              <span className="tabular-nums font-semibold">{wordCount.toLocaleString()}</span>
                            </div>
                          );
                        })()}
                        <div className="flex flex-col items-center px-2.5 py-1 rounded-lg"
                          style={{
                            background: "var(--bg-control)",
                            border: "1px solid var(--bd-8)",
                            color: "var(--c-55)",
                          }}>
                          <span className="text-[10px] uppercase tracking-wide" style={{ opacity: 0.6 }}>Channel Avg</span>
                          <span className="tabular-nums font-semibold" style={{ color: "var(--c-80)" }}>{targetWordCount.toLocaleString()}</span>
                        </div>
                      </div>
                    )}
                    {script && (
                      <button
                        onClick={() => navigator.clipboard.writeText(script).then(() => toast.success("Copied"))}
                        className="px-2.5 py-1 rounded-lg text-xs transition-all"
                        style={{ background: "var(--bg-control)", border: "1px solid var(--bd-8)", color: "var(--c-60)" }}
                      >
                        Copy
                      </button>
                    )}
                  </div>
                </div>

                <div className="relative p-6">
                  <textarea
                    ref={textareaRef}
                    value={script}
                    onChange={(e) => { editedRef.current = true; setScript(e.target.value); }}
                    onBlur={saveScript}
                    readOnly={isStreaming}
                    className="w-full min-h-[560px] bg-transparent text-foreground/90 text-sm leading-8 resize-none outline-none font-sans"
                    // Hide the static placeholder while streaming — the
                    // rotating caption overlay below stands in for it
                    // and is a stronger "we're working" signal than
                    // "Script will appear here…" which never changes.
                    placeholder={isStreaming ? "" : scriptIsManual ? "Write your script here..." : "Script will appear here..."}
                    style={{ caretColor: "oklch(0.72 0.25 285)" }}
                  />
                  {isStreaming && !script && (
                    <div className="pointer-events-none absolute inset-0 p-6 flex items-start">
                      <ScriptRunningCaption emphasis />
                    </div>
                  )}
                  {isStreaming && (
                    <span className="inline-block w-0.5 h-[18px] align-middle rounded-full animate-pulse ml-0.5"
                      style={{ background: "oklch(0.72 0.25 285)" }} />
                  )}
                </div>
              </div>

              {/* Bottom hint */}
              {!isStreaming && script && (
                <p className="text-center text-xs mt-4" style={{ color: "var(--c-35)" }}>
                  Click anywhere in the script to edit · Auto-saves on focus loss
                </p>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Fixed Continue bar */}
      {!isStreaming && script && (
        <ContinueBarGuard>
        <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
          <div className="sm:px-8 flex gap-3">
            {/* Beside Continue: "Generate with AI" for a manual script
                (produces an AI draft), "Regenerate" for an AI script.
                Both open the confirm dialog before discarding the
                current script. */}
            <button
              onClick={() => setConfirmRegen(true)}
              disabled={navigating}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 hover:opacity-90 flex items-center justify-center gap-2"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              <RefreshCw size={14} strokeWidth={2.5} />
              {scriptIsManual ? "Generate with AI" : "Regenerate"}
            </button>
            <button
              onClick={handleContinue}
              disabled={navigating}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              {navigating ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Saving…
                </span>
              ) : "Continue →"}
            </button>
          </div>
        </div>
        </ContinueBarGuard>
      )}

      {/* Regenerate confirm dialog */}
      <Dialog open={confirmRegen} onOpenChange={(o) => { if (!regenSubmitting && !o) setConfirmRegen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{scriptIsManual ? "Generate with AI?" : "Regenerate Script?"}</DialogTitle>
            <DialogDescription>
              {scriptIsManual
                ? "This will replace your manually written script with an AI-generated one. Your current script will be lost."
                : "This will discard your current script and generate a fresh one. Any manual edits will be lost."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-end gap-3 mt-2">
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmRegen(false)}
                disabled={regenSubmitting}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleRegenerate}
                disabled={regenSubmitting}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-60"
                style={{ background: "oklch(0.72 0.25 285)" }}
              >
                {regenSubmitting ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Clearing previous run…
                  </span>
                ) : scriptIsManual ? "Generate with AI" : "Regenerate"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
