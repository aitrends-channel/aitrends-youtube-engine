"use client";

import { useState, use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";

interface PageProps {
  params: { projectId: string };
}

export default function TopicPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project } = useProject(projectId);

  const [selectedTopic, setSelectedTopic] = useState("");
  const [saving, setSaving] = useState(false);
  const [extraIdeas, setExtraIdeas] = useState<string[]>([]);
  const [generatingIdeas, setGeneratingIdeas] = useState(false);

  const baseIdeas: string[] = project?.video_ideas ?? [];
  const allIdeas = [...baseIdeas, ...extraIdeas];

  useEffect(() => {
    if (project?.selected_topic && !selectedTopic) {
      setSelectedTopic(project.selected_topic);
    }
  }, [project]);

  async function generateMoreIdeas() {
    setGeneratingIdeas(true);
    try {
      const res = await fetch("/api/workflow/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json() as { ideas?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to generate ideas");
      setExtraIdeas((prev) => [...prev, ...(data.ideas ?? [])]);
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
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected_topic: topic }),
      });
      router.push(`/projects/${projectId}/script`);
    } catch {
      toast.error("Failed to save topic");
      setSaving(false);
    }
  }

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={6} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 overflow-y-auto">
        <div className="px-8 py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <h1 className="font-bold text-lg">Choose Your Topic</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
            Select a video idea or enter a custom topic
          </p>
        </div>

        <div className="max-w-2xl mx-auto px-8 py-8 space-y-5">

          {/* Ideas list */}
          {allIdeas.length > 0 && (
            <div className="space-y-2">
              {allIdeas.map((idea, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedTopic(idea)}
                  className="w-full text-left p-4 rounded-xl transition-all"
                  style={selectedTopic === idea ? {
                    background: "oklch(0.72 0.25 285 / 0.12)",
                    border: "1px solid oklch(0.72 0.25 285 / 0.35)",
                  } : {
                    background: "var(--bg-panel)",
                    border: "1px solid var(--bd-7)",
                  }}
                  onMouseEnter={(e) => {
                    if (selectedTopic !== idea)
                      (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.2)";
                  }}
                  onMouseLeave={(e) => {
                    if (selectedTopic !== idea)
                      (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-7)";
                  }}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-xs font-mono mt-0.5 shrink-0"
                      style={{
                        color: "oklch(0.72 0.25 285)",
                        background: "oklch(0.72 0.25 285 / 0.1)",
                        padding: "2px 6px",
                        borderRadius: "4px",
                      }}>
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="text-sm leading-relaxed"
                      style={{ color: selectedTopic === idea ? "var(--c-90)" : "var(--c-65)" }}>
                      {idea}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Generate more button */}
          {project?.channel_analysis && (
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
          )}

          {/* Custom topic input */}
          <div className="rounded-2xl p-5 space-y-3" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
              {allIdeas.length > 0 ? "Or enter a custom topic" : "Your topic"}
            </p>
            <input
              type="text"
              value={selectedTopic}
              onChange={(e) => setSelectedTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !saving && handleContinue()}
              placeholder="Type a video topic…"
              className="w-full px-4 py-2.5 rounded-xl text-sm outline-none transition-all"
              style={{
                background: "var(--bg-progress)",
                border: "1px solid var(--bd-8)",
                color: "var(--c-90)",
              }}
              onFocus={(e) => { (e.target as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.4)"; }}
              onBlur={(e) => { (e.target as HTMLElement).style.borderColor = "var(--bd-8)"; }}
            />
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
        </div>
      </main>
    </div>
  );
}
