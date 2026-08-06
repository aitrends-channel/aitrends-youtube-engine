"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

interface NextVideoPanelProps {
  projectId: string;
  project: {
    channel_url?: string;
    channel_name?: string;
    channel_analysis?: unknown;
    channel_info?: unknown;
    transcripts?: unknown;
    visual_profile?: unknown;
    thumbnail_analysis?: unknown;
    video_ideas?: string[];
  } | null;
}

export function NextVideoPanel({ projectId, project }: NextVideoPanelProps) {
  const router = useRouter();
  const [nextTopic, setNextTopic] = useState("");
  const [extraIdeas, setExtraIdeas] = useState<string[]>([]);
  const [generatingIdeas, setGeneratingIdeas] = useState(false);
  const [creatingNext, setCreatingNext] = useState(false);
  const [navigatingDashboard, setNavigatingDashboard] = useState(false);

  const allIdeas: string[] = [...(project?.video_ideas ?? []), ...extraIdeas];

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

  async function startNextVideo() {
    const topic = nextTopic.trim();
    if (!topic) return;
    setCreatingNext(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fork: {
            channelUrl:        project?.channel_url,
            channelName:       project?.channel_name,
            channelAnalysis:   project?.channel_analysis,
            channelInfo:       project?.channel_info,
            transcripts:       project?.transcripts,
            visualProfile:     project?.visual_profile,
            thumbnailAnalysis: project?.thumbnail_analysis,
            videoIdeas:        allIdeas.filter((idea) => idea !== topic),
            selectedTopic:     topic,
          },
        }),
      });
      const data = await res.json() as { id?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to create project");
      router.push(`/projects/${data.id}/script`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreatingNext(false);
    }
  }

  return (
    <div className="rounded-2xl p-5 space-y-4" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
      <div>
        <p className="text-sm font-semibold">Start Your Next Video</p>
        <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
          Same channel — pick a topic and jump straight to the script
        </p>
      </div>

      {allIdeas.length > 0 && (
        <div className="space-y-1">
          {allIdeas.map((idea, i) => {
            const selected = nextTopic === idea;
            return (
              <button key={i} onClick={() => setNextTopic(idea)}
                className="w-full text-left px-3 py-2.5 rounded-xl text-xs transition-all flex items-center gap-2"
                style={selected ? {
                  background: "oklch(0.72 0.25 285 / 0.12)",
                  border: "1px solid oklch(0.72 0.25 285 / 0.35)",
                  color: "var(--c-90)",
                } : {
                  background: "var(--bg-input)",
                  border: "1px solid var(--bd-7)",
                  color: "var(--c-55)",
                }}>
                {selected ? (
                  <span className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
                    style={{ background: "oklch(0.55 0.15 145)", color: "var(--bg-page-2)" }}>
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                ) : (
                  <span className="font-mono text-[9px] shrink-0"
                    style={{ color: "color-mix(in oklch, var(--brand-text) 60%, transparent)" }}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                )}
                <span className="min-w-0">{idea}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="relative">
        <input
          type="text"
          value={nextTopic}
          onChange={(e) => setNextTopic(e.target.value)}
          placeholder={allIdeas.length > 0 ? "Or type a custom topic…" : "Type your next topic…"}
          className="w-full px-3 py-2.5 rounded-xl text-sm outline-none transition-all"
          style={{
            background: "var(--bg-input)",
            border: `1px solid ${nextTopic.trim() ? "oklch(0.55 0.15 145 / 0.45)" : "var(--bd-10)"}`,
            color: "var(--c-90)",
            paddingRight: nextTopic.trim() ? "2.25rem" : undefined,
          }}
        />
        {nextTopic.trim() && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full flex items-center justify-center"
            style={{ background: "oklch(0.55 0.15 145)", color: "var(--bg-page-2)" }}>
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <button onClick={generateMoreIdeas} disabled={generatingIdeas || !project?.channel_analysis}
          className="w-full py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
          style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}>
          {generatingIdeas ? (
            <span className="flex items-center justify-center gap-1.5">
              <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Generating…
            </span>
          ) : "Generate More Ideas"}
        </button>
        <div className="flex gap-2">
          <button onClick={startNextVideo} disabled={!nextTopic.trim() || creatingNext || navigatingDashboard}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
            {creatingNext ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Starting…
              </span>
            ) : "Continue"}
          </button>
          <button
            onClick={() => { setNavigatingDashboard(true); router.push("/dashboard"); }}
            disabled={creatingNext || navigatingDashboard}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-80"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
            {navigatingDashboard ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Redirecting…
              </span>
            ) : "Go to Dashboard"}
          </button>
        </div>
      </div>
    </div>
  );
}
