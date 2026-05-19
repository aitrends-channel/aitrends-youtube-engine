"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import { Settings, LogOut, BarChart3, FileText, Wand2, ScrollText, Mic, Sparkles, Film, Download, ChevronRight, Image as ImageIcon } from "lucide-react";
import useSWR from "swr";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SubscriptionModal } from "@/components/SubscriptionModal";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

const PIPELINE_STEPS = [
  { label: "Transcript", Icon: FileText },
  { label: "Style DNA", Icon: Wand2 },
  { label: "Script", Icon: ScrollText },
  { label: "Voiceover", Icon: Mic },
  { label: "AI Images", Icon: Sparkles },
  { label: "Thumbnail", Icon: ImageIcon },
  { label: "Video Clips", Icon: Film },
  { label: "Export", Icon: Download },
];

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface Project {
  id: string;
  channel_name?: string;
  channel_url?: string;
  current_state: number;
  created_at: string;
  selected_topic?: string;
  assembly_status?: string | null;
}

interface ChannelGroup {
  channelName: string;
  channelUrl?: string;
  projects: Project[];
  lastActive: string;
}

const PHASE_LABELS: Record<number, string> = {
  1: "Setup", 2: "Setup", 3: "Setup", 4: "Analyzing", 5: "Analyzing",
  6: "Topic", 7: "Visuals", 8: "Visuals", 9: "Prompts", 10: "Prompts",
  11: "Visuals", 12: "Visuals", 13: "Prompts", 14: "Generate", 15: "Complete",
};

const PHASE_PATHS: Record<number, string> = {
  1: "channel", 2: "channel", 3: "channel", 4: "channel", 5: "channel",
  6: "topic", 7: "visuals", 8: "visuals", 9: "prompts", 10: "prompts",
  11: "visuals", 12: "visuals", 13: "prompts", 14: "generate", 15: "assemble",
};

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
}

export default function HomePage() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPaid, setIsPaid] = useState<boolean | null>(null);
  const [userEmail, setUserEmail] = useState("");
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      const user = data.user;
      if (!user) { router.replace("/login"); return; }
      if (user.email === ADMIN_EMAIL) setIsAdmin(true);
      setUserEmail(user.email ?? "");
      setIsPaid(user.app_metadata?.paid === true);
    });
  }, [router]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const { data: projects } = useSWR<Project[]>("/api/projects", fetcher);

  const channelGroups = useMemo<ChannelGroup[]>(() => {
    if (!Array.isArray(projects)) return [];
    const map = new Map<string, ChannelGroup>();
    for (const p of projects) {
      const key = p.channel_name ?? "Untitled Channel";
      if (!map.has(key)) {
        map.set(key, { channelName: key, channelUrl: p.channel_url, projects: [], lastActive: p.created_at });
      }
      const group = map.get(key)!;
      group.projects.push(p);
      if (p.created_at > group.lastActive) group.lastActive = p.created_at;
    }
    return Array.from(map.values()).sort((a, b) => b.lastActive.localeCompare(a.lastActive));
  }, [projects]);

  function requireSubscription(action: () => void) {
    if (isPaid || isAdmin) {
      action();
    } else {
      setPendingAction(() => action);
      setShowSubscriptionModal(true);
    }
  }

  function handleSubscriptionSuccess() {
    setIsPaid(true);
    setShowSubscriptionModal(false);
    if (pendingAction) {
      pendingAction();
      setPendingAction(null);
    }
  }

  async function doCreateProject() {
    setCreating(true);
    try {
      const res = await fetch("/api/projects", { method: "POST" });
      const project = await res.json();
      if (project.id) {
        router.push(`/projects/${project.id}/channel`);
      } else {
        toast.error("Failed to create project");
      }
    } catch {
      toast.error("Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  function createProject() {
    requireSubscription(doCreateProject);
  }

  async function doCreateVideoForChannel(group: ChannelGroup) {
    if (creatingFor) return;
    const source = [...group.projects].sort((a, b) => b.current_state - a.current_state)[0];
    setCreatingFor(group.channelName);
    try {
      const fullRes = await fetch(`/api/projects/${source.id}`);
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
          },
        }),
      });
      const project = await forkRes.json();
      if (project.id) {
        router.push(`/projects/${project.id}/topic`);
      } else {
        toast.error("Failed to create video");
      }
    } catch {
      toast.error("Failed to create video");
    } finally {
      setCreatingFor(null);
    }
  }

  function createVideoForChannel(group: ChannelGroup) {
    requireSubscription(() => doCreateVideoForChannel(group));
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-page)" }}>
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isAdmin && (
            <Link
              href="/admin"
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80"
              style={{ background: "oklch(0.72 0.25 285 / 0.1)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}
            >
              <BarChart3 size={15} />
              <span>Admin</span>
            </Link>
          )}
          <Link
            href="/settings"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80"
            style={{ background: "var(--bg-control)", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
          >
            <Settings size={15} />
            <span>Settings</span>
          </Link>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80 cursor-pointer"
            style={{ background: "var(--bg-control)", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
          >
            <LogOut size={15} />
            <span>Sign Out</span>
          </button>
          <ThemeToggle />
          <button
            onClick={createProject}
            disabled={creating}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
          >
            {creating ? "Creating…" : "+ New Project"}
          </button>
        </div>
      </header>

      <main className="flex-1 w-full px-24 py-12 space-y-12">

        {/* Channel groups */}
        {channelGroups.length > 0 && (
          <div className="space-y-12">
            {channelGroups.map((group) => {
              const isCreatingThis = creatingFor === group.channelName;
              return (
                <div key={group.channelName}>
                  {/* Channel header */}
                  <div className="flex items-center justify-between mb-5">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-xl flex items-center justify-center text-base font-bold shrink-0"
                        style={{
                          background: "oklch(0.72 0.25 285 / 0.15)",
                          color: "oklch(0.72 0.25 285)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.25)",
                        }}>
                        {group.channelName.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-foreground">{group.channelName}</h2>
                        {group.channelUrl && (
                          <p className="text-xs mt-0.5" style={{ color: "var(--c-38)" }}>
                            {group.channelUrl}
                          </p>
                        )}
                      </div>
                    </div>
                    <span className="text-xs px-3 py-1 rounded-full"
                      style={{ background: "var(--bg-elevated)", border: "1px solid var(--bd-6)", color: "var(--c-42)" }}>
                      {group.projects.length} {group.projects.length === 1 ? "video" : "videos"}
                    </span>
                  </div>

                  {/* Project cards — auto-fill grid */}
                  <div className="grid gap-7"
                    style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
                    {group.projects.map((p) => {
                      const assembled = p.assembly_status === "done";
                      const effectiveState = assembled ? 15 : p.current_state;
                      const path = assembled
                        ? "assemble"
                        : (p.current_state === 6 && p.selected_topic)
                          ? "script"
                          : (PHASE_PATHS[p.current_state] ?? "channel");
                      const stateLabel = assembled
                        ? "Complete"
                        : (p.current_state === 6 && p.selected_topic)
                          ? "Script"
                          : (PHASE_LABELS[p.current_state] ?? "Setup");
                      const progress = Math.min(100, Math.round((effectiveState / 15) * 100));
                      const isComplete = effectiveState >= 15;

                      return (
                        <button
                          key={p.id}
                          onClick={() => router.push(`/projects/${p.id}/${path}`)}
                          className="text-left p-6 rounded-2xl transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
                          style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.35)"; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-7)"; }}
                        >
                          <div className="flex items-start justify-between mb-3">
                            <span className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                              style={isComplete ? {
                                background: "oklch(0.55 0.15 145 / 0.15)",
                                color: "oklch(0.65 0.15 145)",
                                border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                              } : {
                                background: "oklch(0.72 0.25 285 / 0.1)",
                                color: "oklch(0.72 0.25 285)",
                                border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                              }}>
                              {stateLabel}
                            </span>
                            <span className="text-xs" style={{ color: "var(--c-38)" }}>
                              {timeAgo(p.created_at)}
                            </span>
                          </div>

                          <p className="text-lg font-semibold leading-snug mb-5"
                            style={{ color: p.selected_topic ? "var(--c-88)" : "var(--c-40)" }}>
                            {p.selected_topic ?? "No topic selected"}
                          </p>

                          <div className="space-y-1.5">
                            <div className="flex justify-between text-xs" style={{ color: "var(--c-38)" }}>
                              <span>Progress</span>
                              <span>{progress}%</span>
                            </div>
                            <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                              <div className="h-full rounded-full transition-all"
                                style={{
                                  width: `${progress}%`,
                                  background: isComplete
                                    ? "oklch(0.55 0.15 145)"
                                    : "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                                }}
                              />
                            </div>
                          </div>
                        </button>
                      );
                    })}

                    {/* New video — pre-loaded with this channel's data */}
                    <button
                      onClick={() => createVideoForChannel(group)}
                      disabled={!!creatingFor}
                      className="text-left p-10 rounded-2xl transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                      style={{ background: "var(--bg-card-subtle)", border: "1px dashed var(--bd-9)" }}
                      onMouseEnter={(e) => {
                        if (!creatingFor) (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.3)";
                      }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-9)"; }}
                    >
                      <div className="flex flex-col items-center justify-center min-h-[160px] gap-3">
                        {isCreatingThis ? (
                          <>
                            <span className="text-xl animate-spin" style={{ color: "oklch(0.72 0.25 285)" }}>◌</span>
                            <span className="text-sm" style={{ color: "var(--c-50)" }}>Setting up…</span>
                          </>
                        ) : (
                          <>
                            <span className="text-3xl" style={{ color: "var(--c-28)" }}>+</span>
                            <span className="text-sm font-medium" style={{ color: "var(--c-42)" }}>New video</span>
                            <span className="text-xs" style={{ color: "var(--c-30)" }}>
                              {group.channelName}
                            </span>
                          </>
                        )}
                      </div>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Loading skeleton */}
        {projects === undefined && (
          <div className="space-y-12">
            {[0, 1].map((g) => (
              <div key={g}>
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-11 h-11 rounded-xl animate-pulse" style={{ background: "var(--bg-card)" }} />
                  <div className="space-y-2">
                    <div className="h-4 w-36 rounded animate-pulse" style={{ background: "var(--bg-card)" }} />
                    <div className="h-3 w-52 rounded animate-pulse" style={{ background: "var(--bg-card)" }} />
                  </div>
                </div>
                <div className="grid gap-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="p-6 rounded-2xl space-y-4"
                      style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}>
                      <div className="flex items-start justify-between">
                        <div className="h-5 w-20 rounded-full animate-pulse" style={{ background: "var(--bg-elevated)" }} />
                        <div className="h-4 w-14 rounded animate-pulse" style={{ background: "var(--bg-elevated)" }} />
                      </div>
                      <div className="h-6 w-4/5 rounded animate-pulse" style={{ background: "var(--bg-elevated)" }} />
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <div className="h-3 w-14 rounded animate-pulse" style={{ background: "var(--bg-elevated)" }} />
                          <div className="h-3 w-8 rounded animate-pulse" style={{ background: "var(--bg-elevated)" }} />
                        </div>
                        <div className="h-1 w-full rounded-full animate-pulse" style={{ background: "var(--bg-elevated)" }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {channelGroups.length === 0 && projects !== undefined && (
          <div className="text-center py-20 space-y-3">
            <p className="text-sm" style={{ color: "var(--c-38)" }}>No projects yet.</p>
            <p className="text-xs" style={{ color: "var(--c-28)" }}>Click "Start New Project" to get started.</p>
          </div>
        )}
      </main>

      {showSubscriptionModal && (
        <SubscriptionModal
          email={userEmail}
          onClose={() => { setShowSubscriptionModal(false); setPendingAction(null); }}
          onSuccess={handleSubscriptionSuccess}
        />
      )}
    </div>
  );
}
