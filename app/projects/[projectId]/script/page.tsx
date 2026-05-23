"use client";

import { useState, use, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { useStreamingScript } from "@/hooks/useStreamingScript";
import { toast } from "sonner";
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
  const { project } = useProject(projectId);
  const { script, setScript, isStreaming, streamingRef, wordCount, error, startStreaming } =
    useStreamingScript();

  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const targetWordCount = project?.target_word_count ?? project?.channel_analysis?.targetWordCount ?? 900;
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
    if (selectedTopic) await generateScript(selectedTopic);
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
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={6} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 flex flex-col overflow-hidden pt-14 md:pt-0">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-4 sm:px-8 py-3 sm:py-4 shrink-0"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div className="flex-1 min-w-0 mr-2">
            <h1 className="font-bold text-base sm:text-lg text-foreground">Script Editor</h1>
            {selectedTopic && (
              <p className="text-xs truncate max-w-xs sm:max-w-sm mt-0.5" style={{ color: "var(--c-50)" }}>
                {selectedTopic}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {script && (
              <div className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-mono"
                style={{
                  background: wordCountOk ? "oklch(0.55 0.15 145 / 0.1)" : "oklch(0.72 0.25 285 / 0.1)",
                  border: `1px solid ${wordCountOk ? "oklch(0.55 0.15 145 / 0.3)" : "oklch(0.72 0.25 285 / 0.3)"}`,
                  color: wordCountOk ? "oklch(0.7 0.15 145)" : "oklch(0.72 0.25 285)",
                }}>
                <span>{wordCount}</span>
                <span style={{ opacity: 0.5 }}>/</span>
                <span>{targetWordCount}</span>
                <span className="hidden sm:inline" style={{ opacity: 0.5 }}>words</span>
              </div>
            )}
            {script && (
              <button
                onClick={() => navigator.clipboard.writeText(script).then(() => toast.success("Copied"))}
                className="px-2.5 py-1.5 rounded-lg text-xs transition-all"
                style={{ background: "var(--bg-control)", border: "1px solid var(--bd-8)", color: "var(--c-60)" }}
              >
                Copy
              </button>
            )}
            {script && !isStreaming && (
              <button
                onClick={() => setConfirmRegen(true)}
                className="hidden sm:block px-2.5 py-1.5 rounded-lg text-xs transition-all"
                style={{ background: "var(--bg-control)", border: "1px solid var(--bd-8)", color: "var(--c-60)" }}
              >
                Regen
              </button>
            )}
            {script && !isStreaming && (
              <button
                onClick={saveScript}
                disabled={saving}
                className="px-2.5 py-1.5 rounded-lg text-xs transition-all"
                style={{ background: "var(--bg-control)", border: "1px solid var(--bd-8)", color: "var(--c-60)" }}
              >
                {saving ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Saving…
                  </span>
                ) : "Save"}
              </button>
            )}
            <button
              onClick={handleContinue}
              disabled={!script || isStreaming || navigating}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-40"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              {navigating ? (
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Saving…
                </span>
              ) : "Continue →"}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-8">
          {/* No-script state */}
          {!script && !isStreaming && (
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
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full"
                      style={{ background: isStreaming ? "oklch(0.72 0.25 285)" : "oklch(0.55 0.15 145)", boxShadow: isStreaming ? "0 0 6px oklch(0.72 0.25 285)" : "none" }}
                    />
                    <span className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
                      {isStreaming ? "Generating..." : "Script"}
                    </span>
                  </div>
                  {isStreaming && (
                    <span className="text-xs font-mono" style={{ color: "oklch(0.72 0.25 285)" }}>
                      {wordCount} words
                    </span>
                  )}
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

      {/* Regenerate confirm dialog */}
      <Dialog open={confirmRegen} onOpenChange={setConfirmRegen}>
        <DialogContent style={{ background: "var(--bg-elevated)", border: "1px solid var(--bd-10)" }}>
          <DialogHeader>
            <DialogTitle className="text-foreground">Regenerate Script?</DialogTitle>
            <DialogDescription style={{ color: "var(--c-50)" }}>
              This will discard your current script and generate a fresh one. Any manual edits will be lost.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 justify-end mt-2">
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
        </DialogContent>
      </Dialog>
    </div>
  );
}
