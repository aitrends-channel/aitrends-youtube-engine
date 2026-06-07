"use client";

import { useState, use, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { useStreamingScript } from "@/hooks/useStreamingScript";
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

export default function ScriptPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project, mutate } = useProject(projectId);
  const { script, setScript, isStreaming, streamingRef, wordCount, error, startStreaming, stopStreaming } =
    useStreamingScript();

  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const targetWordCount = project?.target_word_count ?? project?.channel_analysis?.targetWordCount ?? 900;
  // Paused-draft state: a previous generation was Stopped, partial was
  // saved, current_state never reached 7 (the success-save sentinel).
  // No active run id either — distinguishes from "still generating in
  // the background", which has its own UI.
  const isPausedDraft =
    !!script &&
    !isStreaming &&
    !project?.script_active_run_id &&
    (project?.current_state ?? 0) < 7;
  const deviation = Math.abs(wordCount - targetWordCount) / targetWordCount;
  const wordCountOk = deviation <= 0.05;

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

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);


  async function generateScript(topic: string) {
    setSelectedTopic(topic);
    await startStreaming(projectId, project?.channel_analysis, topic);
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
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleRegenerate() {
    setConfirmRegen(false);
    if (!selectedTopic) return;
    // Atomic clear before the new run: zero the DB script, the local
    // hook state, and any stale script_active_run_id. Without this,
    // a failed regen lets SWR re-hydrate the old text the next time
    // isStreaming flips back to false, and the user sees stale content
    // instead of being returned to the Generate button.
    setScript("");
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: null, word_count: 0, script_active_run_id: null }),
      });
      await mutate();
    } catch { /* best-effort — the new stream will overwrite on success */ }
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
      setScript("");
      mutate();
    } finally {
      setCancellingDraft(false);
    }
  }

  async function handleContinue() {
    if (!script.trim()) { toast.error("Generate a script first"); return; }
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
      <WizardNav projectId={projectId} currentState={6} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 flex flex-col overflow-hidden pt-[105px] md:pt-0">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-4 sm:px-8 md:pr-44 py-3 sm:py-4 shrink-0"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div className="flex-1 min-w-0 mr-2">
            <h1 className="font-bold text-base sm:text-lg text-foreground">Script Editor</h1>
            {selectedTopic && (
              <p className="text-xs truncate max-w-xs sm:max-w-sm mt-0.5" style={{ color: "var(--c-50)" }}>
                {selectedTopic}
              </p>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto pb-[70px] p-4 sm:p-8">
          {/* Background-generation state — user refreshed mid-stream
              or has another tab generating. project.script_active_run_id
              is the server-side "in flight" flag; useProject's 5s SWR
              poll picks up project.script the moment the run finishes
              and the next render switches to the script-display branch. */}
          {!script && !isStreaming && project?.script_active_run_id && (
            <div className="max-w-xl mx-auto">
              <div className="text-center space-y-5 p-10 rounded-2xl"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <div className="flex justify-center">
                  <div className="w-10 h-10 border-2 rounded-full animate-spin"
                    style={{ borderColor: "oklch(0.72 0.25 285 / 0.3)", borderTopColor: "oklch(0.72 0.25 285)" }} />
                </div>
                <div className="space-y-2">
                  <p className="text-base font-medium text-foreground">Generation in progress</p>
                  <p className="text-xs leading-relaxed" style={{ color: "var(--c-45)" }}>
                    Your script is still being generated in the background. This page will update automatically when it&apos;s ready — no need to click anything.
                  </p>
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

          {/* No-script state */}
          {!script && !isStreaming && !project?.script_active_run_id && (
            <div className="max-w-xl mx-auto">
              {project?.selected_topic ? (
                <div className="text-center space-y-5 p-10 rounded-2xl"
                  style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Topic</p>
                    <p className="text-base font-medium text-foreground">{project.selected_topic}</p>
                  </div>
                  <button
                    onClick={() => generateScript(project.selected_topic!)}
                    className="px-8 py-3 rounded-xl text-sm font-semibold"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                  >
                    Generate Script
                  </button>
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

          {/* Script display / editor */}
          {(script || isStreaming) && (
            <div className="max-w-3xl mx-auto">
              <div className="rounded-2xl overflow-hidden"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
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
                                color: showGreen ? "oklch(0.7 0.15 145)" : "oklch(0.72 0.25 285)",
                              }}>
                              <span className="text-[9px] uppercase tracking-wide" style={{ opacity: 0.7 }}>Your Script</span>
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
                          <span className="text-[9px] uppercase tracking-wide" style={{ opacity: 0.6 }}>Channel Avg</span>
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
                    onChange={(e) => setScript(e.target.value)}
                    onBlur={saveScript}
                    readOnly={isStreaming}
                    className="w-full min-h-[560px] bg-transparent text-foreground/90 text-sm leading-8 resize-none outline-none font-sans"
                    placeholder="Script will appear here..."
                    style={{ caretColor: "oklch(0.72 0.25 285)" }}
                  />
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
        <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
          <div className="max-w-3xl mx-auto px-4 sm:px-8 flex gap-3">
            <button
              onClick={() => setConfirmRegen(true)}
              disabled={navigating}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 hover:opacity-90 flex items-center justify-center gap-2"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              <RefreshCw size={14} strokeWidth={2.5} />
              Regenerate
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
      )}

      {/* Regenerate confirm dialog */}
      <Dialog open={confirmRegen} onOpenChange={setConfirmRegen}>
        <DialogContent style={{ background: "var(--bg-elevated)", border: "1px solid var(--bd-10)" }}>
          <DialogHeader>
            <DialogTitle className="text-foreground">Regenerate Script?</DialogTitle>
            <DialogDescription style={{ color: "var(--c-50)" }}>
              This will discard your current script and generate a fresh one. Any manual edits will be lost.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-end gap-3 mt-2">
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmRegen(false)}
                className="px-4 py-2 rounded-lg text-sm"
                style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
              >
                Cancel
              </button>
              <button
                onClick={handleRegenerate}
                className="px-4 py-2 rounded-lg text-sm font-semibold"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                Regenerate
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
