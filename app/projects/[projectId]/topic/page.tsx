"use client";

import { useState, use, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";
import { WizardNav } from "@/components/wizard/WizardNav";
import { StepCostCard } from "@/components/StepCostCard";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";

interface PageProps {
  params: { projectId: string };
}

export default function TopicPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const searchParams = useSearchParams();

  const isFork = projectId === "new-fork";
  const sourceId = isFork ? (searchParams.get("from") ?? null) : null;

  const { project, mutate } = useProject(isFork ? sourceId : projectId);

  const [selectedTopic, setSelectedTopic] = useState("");
  const [saving, setSaving] = useState(false);
  const [generatingIdeas, setGeneratingIdeas] = useState(false);

  // Single source of truth for the ideas list — the persisted
  // video_ideas array on the project row. The ideas API appends
  // generated ideas back into this column, so after a successful
  // "Generate More Ideas" + SWR mutate, the list naturally extends.
  // Previously the appended ideas only lived in a local React state
  // and vanished on refresh; now they survive across reloads.
  const allIdeas: string[] = project?.video_ideas ?? [];
  const isTopicLocked = !isFork && !!(project?.selected_topic && project?.script);

  useEffect(() => {
    if (project?.selected_topic && !selectedTopic && !isFork) {
      setSelectedTopic(project.selected_topic);
    }
  }, [project]);

  async function generateMoreIdeas() {
    const ideasProjectId = isFork ? sourceId : projectId;
    if (!ideasProjectId) return;
    setGeneratingIdeas(true);
    try {
      const res = await fetch("/api/workflow/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: ideasProjectId }),
      });
      const data = await res.json() as { ideas?: string[]; allIdeas?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to generate ideas");
      // Re-read the project so video_ideas reflects the server-side
      // append. mutate() refetches via SWR; the UI re-renders with
      // the combined list. No optimistic update needed — the network
      // call is fast enough and we already showed the spinner.
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate ideas");
    } finally {
      setGeneratingIdeas(false);
    }
  }

  async function handleContinue() {
    const topic = selectedTopic.trim();
    if (!topic) { toast.error("Select or enter a topic first"); return; }
    setSaving(true);
    try {
      if (isFork && sourceId) {
        const fullRes = await fetch(`/api/projects/${sourceId}`);
        const full = await fullRes.json();
        const forkRes = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fork: {
              channelUrl:        full.channel_url,
              channelName:       full.channel_name,
              channelAnalysis:   full.channel_analysis,
              channelInfo:       full.channel_info,
              transcripts:       full.transcripts,
              visualProfile:     full.visual_profile,
              thumbnailAnalysis: full.thumbnail_analysis,
              videoIdeas:        full.video_ideas,
              selectedTopic:     topic,
            },
          }),
        });
        const newProject = await forkRes.json();
        if (forkRes.status === 403 && newProject.limitReached) {
          toast.error("You've reached your niche limit. Upgrade your plan to add more.");
          setSaving(false);
          return;
        }
        if (!newProject.id) {
          toast.error("Failed to create video");
          setSaving(false);
          return;
        }
        router.push(`/projects/${newProject.id}/script`);
      } else {
        await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selected_topic: topic }),
        });
        router.push(`/projects/${projectId}/script`);
      }
    } catch {
      toast.error("Failed to save topic");
      setSaving(false);
    }
  }

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={isFork ? "new-fork" : projectId} currentState={6} highestState={isFork ? 6 : project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 overflow-y-auto pt-[105px] md:pt-0">
        <div className="sm:px-8 py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div>
            <h1 className="font-bold text-lg">Choose Your Topic</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              {isTopicLocked ? "Topic is locked — already used in script generation" : "Select a video idea or enter a custom topic"}
            </p>
            <div className="mt-3">
              <StepCostCard projectId={projectId} column="topic" />
            </div>
          </div>
        </div>

        <div className="sm:px-8 pt-6 sm:pt-8 pb-24 space-y-5">

          {isTopicLocked ? (
            <>
              {/* Locked topic display */}
              <div className="rounded-2xl p-5 space-y-3"
                style={{ background: "var(--bg-panel)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
                    Selected Topic
                  </p>
                  <span className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full"
                    style={{ background: "oklch(0.55 0.15 145 / 0.12)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }}>
                    <Lock size={10} strokeWidth={2.5} />
                    Locked
                  </span>
                </div>
                <p className="text-base font-semibold leading-snug" style={{ color: "var(--c-90)" }}>
                  {project?.selected_topic}
                </p>
                <p className="text-xs" style={{ color: "var(--c-40)" }}>
                  This topic has been used in script generation and cannot be changed.
                </p>
              </div>

              <button
                onClick={() => router.push(`/projects/${projectId}/script`)}
                className="w-full py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                Go to Script →
              </button>
            </>
          ) : (
            <>
              {/* Ideas list */}
              {allIdeas.length > 0 && (
                <div className="space-y-2">
                  {allIdeas.map((idea, i) => {
                    const selected = selectedTopic === idea;
                    return (
                      <button
                        key={i}
                        onClick={() => setSelectedTopic(idea)}
                        className="w-full text-left p-4 rounded-xl transition-all"
                        style={selected ? {
                          background: "oklch(0.72 0.25 285 / 0.12)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.35)",
                        } : {
                          background: "var(--bg-panel)",
                          border: "1px solid var(--bd-7)",
                        }}
                        onMouseEnter={(e) => {
                          if (!selected)
                            (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.2)";
                        }}
                        onMouseLeave={(e) => {
                          if (!selected)
                            (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-7)";
                        }}
                      >
                        <div className="flex items-start gap-3">
                          {selected ? (
                            <span className="shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center"
                              style={{ background: "oklch(0.55 0.15 145)", color: "var(--bg-page-2)" }}>
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </span>
                          ) : (
                            <span className="text-xs font-mono mt-0.5 shrink-0"
                              style={{
                                color: "oklch(0.72 0.25 285)",
                                background: "oklch(0.72 0.25 285 / 0.1)",
                                padding: "2px 6px",
                                borderRadius: "4px",
                              }}>
                              {String(i + 1).padStart(2, "0")}
                            </span>
                          )}
                          <span className="text-sm leading-relaxed"
                            style={{ color: selected ? "var(--c-90)" : "var(--c-65)" }}>
                            {idea}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Generate more button */}
              {project?.channel_analysis && (
                <div className="space-y-2">
                  <button
                    onClick={generateMoreIdeas}
                    disabled={generatingIdeas}
                    className="w-full py-2.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                    style={{ background: "var(--bg-input)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}
                  >
                    {generatingIdeas ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Generating ideas…
                      </span>
                    ) : allIdeas.length > 0 ? "Generate More Ideas" : "Generate Ideas"}
                  </button>
                </div>
              )}

              {/* Custom topic input */}
              <div className="rounded-2xl p-5 space-y-3" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
                  {allIdeas.length > 0 ? "Or enter a custom topic" : "Your topic"}
                </p>
                <div className="relative">
                  <input
                    type="text"
                    value={selectedTopic}
                    onChange={(e) => setSelectedTopic(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !saving && handleContinue()}
                    placeholder="Type a video topic…"
                    className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{
                      background: "var(--bg-progress)",
                      border: `1px solid ${selectedTopic.trim() ? "oklch(0.55 0.15 145 / 0.45)" : "var(--bd-8)"}`,
                      color: "var(--c-90)",
                      paddingRight: selectedTopic.trim() ? "2.5rem" : undefined,
                    }}
                    onFocus={(e) => {
                      if (!selectedTopic.trim()) (e.target as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.4)";
                    }}
                    onBlur={(e) => {
                      if (!selectedTopic.trim()) (e.target as HTMLElement).style.borderColor = "var(--bd-8)";
                    }}
                  />
                  {selectedTopic.trim() && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center"
                      style={{ background: "oklch(0.55 0.15 145)", color: "var(--bg-page-2)" }}>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </div>
              </div>

              {/* Continue button */}
              <button
                onClick={handleContinue}
                disabled={!selectedTopic.trim() || saving}
                className="w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                {saving ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Saving…
                  </span>
                ) : "Continue to Script →"}
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
