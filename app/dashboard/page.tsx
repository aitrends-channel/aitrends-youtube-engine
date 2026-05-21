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
import { PageLoader } from "@/components/PageLoader";

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
  const [selectedPlan, setSelectedPlan] = useState<string | undefined>(undefined);
  const [hoveredPoint, setHoveredPoint] = useState<number | null>(null);
  const [userPlan, setUserPlan] = useState<string>("starter");
  const [memberSince, setMemberSince] = useState<string>("");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const { data: apiStatus } = useSWR("/api/api-status", fetcher, { revalidateOnFocus: false });

  useEffect(() => {
    let cancelled = false;
    const supabase = createSupabaseBrowserClient();

    function applyUser(user: { id: string; email?: string | null; created_at?: string; app_metadata?: Record<string, unknown> }) {
      if (cancelled) return;
      if (user.email === ADMIN_EMAIL) setIsAdmin(true);
      setUserEmail(user.email ?? "");
      if (user.created_at) {
        setMemberSince(new Date(user.created_at).toLocaleDateString("en", { month: "short", year: "numeric" }));
      }
      const paid = (user.app_metadata?.paid === true) || false;
      setIsPaid(paid);
      if (user.app_metadata?.plan) setUserPlan(user.app_metadata.plan as string);
      if (!paid) {
        const plan = localStorage.getItem("heclus_selected_plan");
        if (plan) {
          setSelectedPlan(plan);
          localStorage.removeItem("heclus_selected_plan");
          setShowSubscriptionModal(true);
        }
      }
    }

    // Phase 1: instant local session read — populates UI immediately, no network call
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      if (!session?.user) return; // phase 2 will handle the redirect
      applyUser(session.user as Parameters<typeof applyUser>[0]);
    });

    // Phase 2: verified server-side check — corrects stale data & redirects if truly logged out
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      if (!data.user) { router.replace("/login"); return; }
      applyUser(data.user as Parameters<typeof applyUser>[0]);
    });

    return () => { cancelled = true; };
  }, [router]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }
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

  const { nicheLimit, atNicheLimit } = useMemo(() => {
    const PLAN_LIMITS: Record<string, number | null> = { founder: 20, starter: 5, pro: null };
    const limit = isAdmin ? null : (PLAN_LIMITS[userPlan] ?? 5);
    return { nicheLimit: limit, atNicheLimit: limit !== null && channelGroups.length >= limit };
  }, [isAdmin, userPlan, channelGroups]);

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
    setPendingAction(null);
    router.push("/dashboard");
  }

  async function doCreateProject() {
    setCreating(true);
    try {
      const res = await fetch("/api/projects", { method: "POST" });
      const project = await res.json();
      if (res.status === 403 && project.limitReached) {
        toast.error(`You've reached your ${nicheLimit}-niche limit. Upgrade your plan to add more.`);
        return;
      }
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
    const source = [...group.projects].sort((a, b) => b.current_state - a.current_state)[0];
    setCreating(true);
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
        toast.error("Failed to create project");
      }
    } catch {
      toast.error("Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  function createVideoForChannel(group: ChannelGroup) {
    requireSubscription(() => doCreateVideoForChannel(group));
  }

  const authReady = !!userEmail || isAdmin;

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
          <ThemeToggle />
          {/* Profile avatar + dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowProfileMenu(v => !v)}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              {userEmail ? userEmail[0].toUpperCase() : "?"}
            </button>

            {showProfileMenu && (
              <>
                {/* Backdrop */}
                <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
                {/* Dropdown */}
                <div className="absolute right-0 top-12 z-50 w-64 rounded-2xl py-3 shadow-2xl"
                  style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}>

                  {/* Avatar + info */}
                  <div className="px-4 pb-3" style={{ borderBottom: "1px solid oklch(1 0 0 / 0.07)" }}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center text-base font-bold shrink-0"
                        style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
                        {userEmail ? userEmail[0].toUpperCase() : "?"}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate" style={{ color: "var(--c-88)" }}>{userEmail}</p>
                        {memberSince && (
                          <p className="text-[10px]" style={{ color: "var(--c-38)" }}>Member since {memberSince}</p>
                        )}
                      </div>
                    </div>

                    {/* Plan badge */}
                    <div className="flex items-center gap-2">
                      {isAdmin ? (
                        <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full capitalize"
                          style={{ background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }}>
                          Admin
                        </span>
                      ) : (
                        <Link
                          href="/plan"
                          onClick={() => setShowProfileMenu(false)}
                          className="text-[10px] font-semibold px-2.5 py-1 rounded-full capitalize transition-opacity hover:opacity-75"
                          style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
                          {isPaid ? userPlan : "Free"} plan →
                        </Link>
                      )}
                    </div>
                  </div>

                  {/* Menu items */}
                  <div className="px-2 pt-2">
                    <Link
                      href="/setup"
                      onClick={() => setShowProfileMenu(false)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80"
                      style={{ color: "var(--c-60)" }}
                    >
                      <Settings size={15} />
                      <span>Setup</span>
                    </Link>
                    <button
                      onClick={() => { setShowProfileMenu(false); handleSignOut(); }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80 cursor-pointer"
                      style={{ color: "#f87171" }}
                    >
                      <LogOut size={15} />
                      <span>Sign Out</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <button
              onClick={createProject}
              disabled={creating || !authReady || atNicheLimit}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
            >
              {creating ? "Creating…" : "+ New Niche"}
            </button>
            {atNicheLimit && (
              <span className="text-[10px]" style={{ color: "oklch(0.7 0.2 25)" }}>
                {nicheLimit}-niche limit reached · <a href="/plan" className="underline hover:opacity-80">Upgrade</a>
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full px-24 py-12 space-y-12">

        {(() => {
          const allProjects = channelGroups.flatMap(g => g.projects);
          const total = allProjects.length;
          const completed = allProjects.filter(p => p.assembly_status === "done").length;
          const inProgress = allProjects.filter(p => p.assembly_status !== "done" && p.current_state > 0).length;
          const niches = channelGroups.length;

          return (
            <div className="space-y-6">
              <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "10px", marginBottom: "10px" }}>General Stats</h3>
              {/* Stat cards */}
              {(() => {
                const R = 18, CX = 22, CY = 22, stroke = 5;
                const circ = 2 * Math.PI * R;

                function PieRing({ id, pct, color, centerText, full }: { id: string; pct: number; color: string; centerText: string; full?: boolean }) {
                  const dash = pct * circ;
                  return (
                    <svg width={44} height={44} viewBox="0 0 44 44">
                      <defs>
                        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0%" stopColor={color} stopOpacity="0.7" />
                          <stop offset="100%" stopColor={color} />
                        </linearGradient>
                      </defs>
                      <circle cx={CX} cy={CY} r={R} fill="none" stroke={color} strokeOpacity="0.12" strokeWidth={stroke} />
                      {(full || pct >= 1) ? (
                        <circle cx={CX} cy={CY} r={R} fill="none" stroke={`url(#${id})`} strokeWidth={stroke} />
                      ) : pct > 0 ? (
                        <circle cx={CX} cy={CY} r={R} fill="none"
                          stroke={`url(#${id})`} strokeWidth={stroke}
                          strokeDasharray={`${dash} ${circ}`}
                          strokeDashoffset={circ / 4}
                          strokeLinecap="round"
                        />
                      ) : null}
                      <text x={CX} y={CY + 1} textAnchor="middle" dominantBaseline="middle"
                        fontSize="8.5" fontWeight="700" fill={color}>
                        {centerText}
                      </text>
                    </svg>
                  );
                }

                const PLAN_LIMITS: Record<string, number | null> = { founder: 20, starter: 5, pro: null };
                const nicheLimit = isAdmin ? null : (PLAN_LIMITS[userPlan] ?? 5);
                const unlimited = nicheLimit === null;
                const nichePct = unlimited ? 1 : Math.min(niches / nicheLimit!, 1);
                const nicheColor = nichePct >= 1 ? "#e8745a" : "#9b7ff5";

                const completedPct = total > 0 ? completed / total : 0;
                const inProgressPct = total > 0 ? inProgress / total : 0;

                return (
                  <div className="grid grid-cols-4 gap-4">
                    {/* Total Videos — plain */}
                    <div className="rounded-xl px-5 py-4"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
                      <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{total}</p>
                      <p className="text-xs" style={{ color: "var(--c-42)" }}>Total Videos</p>
                    </div>

                    {/* Completed */}
                    <div className="rounded-xl px-5 py-4 flex items-center justify-between"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
                      <div>
                        <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{completed}</p>
                        <p className="text-xs" style={{ color: "var(--c-42)" }}>Completed</p>
                        <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>
                          {total > 0 ? `${Math.round(completedPct * 100)}% of total` : "0%"}
                        </p>
                      </div>
                      <PieRing id="compGrad" pct={completedPct} color="#5bc48a"
                        centerText={total > 0 ? `${Math.round(completedPct * 100)}%` : "0%"} />
                    </div>

                    {/* In Progress */}
                    <div className="rounded-xl px-5 py-4 flex items-center justify-between"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
                      <div>
                        <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{inProgress}</p>
                        <p className="text-xs" style={{ color: "var(--c-42)" }}>In Progress</p>
                        <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>
                          {total > 0 ? `${Math.round(inProgressPct * 100)}% of total` : "0%"}
                        </p>
                      </div>
                      <PieRing id="progGrad" pct={inProgressPct} color="#f0a855"
                        centerText={total > 0 ? `${Math.round(inProgressPct * 100)}%` : "0%"} />
                    </div>

                    {/* Niches */}
                    <div className="rounded-xl px-5 py-4 flex items-center justify-between"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
                      <div>
                        <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{niches}</p>
                        <p className="text-xs" style={{ color: "var(--c-42)" }}>Niches</p>
                        <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>
                          {unlimited ? "Unlimited" : `of ${nicheLimit}`}
                        </p>
                      </div>
                      <PieRing id="nicheGrad" pct={nichePct} color={nicheColor}
                        centerText={unlimited ? "∞" : `${niches}/${nicheLimit}`} full={unlimited} />
                    </div>
                  </div>
                );
              })()}

              <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "40px", marginBottom: "10px" }}>Niches/Video Chart</h3>
              {/* Bar chart — videos per niche */}
              {(() => {
                const W = 600, PAD_X = 16, PAD_T = 16;
                const points = channelGroups.length > 0
                  ? channelGroups.map(g => ({ label: g.channelName, count: g.projects.length }))
                  : Array.from({ length: 7 }, (_, i) => ({ label: `Niche ${i + 1}`, count: 0 }));
                const maxCount = Math.max(...points.map(p => p.count), 1);
                const n = points.length;
                const plotW = W - PAD_X * 2;
                const slotW = plotW / n;
                const barW = Math.min(52, slotW * 0.6);
                const r = Math.min(5, barW / 3);

                // Word-wrap label into lines that fit within the slot width
                const CHAR_W = 5.8; // approx px per char at font-size 10
                const maxCharsPerLine = Math.max(6, Math.floor(slotW / CHAR_W));
                function wrapLabel(text: string): string[] {
                  const words = text.split(" ");
                  const lines: string[] = [];
                  let current = "";
                  for (const word of words) {
                    const candidate = current ? `${current} ${word}` : word;
                    if (candidate.length <= maxCharsPerLine) {
                      current = candidate;
                    } else {
                      if (current) lines.push(current);
                      // If a single word is too long, split it hard
                      if (word.length > maxCharsPerLine) {
                        let remaining = word;
                        while (remaining.length > maxCharsPerLine) {
                          lines.push(remaining.slice(0, maxCharsPerLine));
                          remaining = remaining.slice(maxCharsPerLine);
                        }
                        current = remaining;
                      } else {
                        current = word;
                      }
                    }
                  }
                  if (current) lines.push(current);
                  return lines;
                }

                const LINE_H = 13; // px between label lines
                const wrappedLabels = points.map(p => wrapLabel(p.label));
                const maxLines = Math.max(...wrappedLabels.map(l => l.length));
                const PAD_B = 8 + maxLines * LINE_H;
                const H = 140 + (maxLines - 1) * LINE_H;
                const plotH = H - PAD_T - PAD_B;

                return (
                  <div className="rounded-2xl px-6 py-5" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
                    <div className="flex items-center justify-between mb-5">
                      <div>
                        <p className="text-sm font-semibold" style={{ color: "var(--c-75)" }}>Videos per niche</p>
                        <p className="text-xs mt-0.5" style={{ color: "var(--c-35)" }}>All time</p>
                      </div>
                      <span className="text-2xl font-bold" style={{ color: "var(--c-90)" }}>{total}</span>
                    </div>
                    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ overflow: "visible" }}>
                      <defs>
                        <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#9b7ff5" stopOpacity="0.95" />
                          <stop offset="100%" stopColor="#9b7ff5" stopOpacity="0.45" />
                        </linearGradient>
                        <linearGradient id="barHov" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#b89dff" stopOpacity="1" />
                          <stop offset="100%" stopColor="#9b7ff5" stopOpacity="0.7" />
                        </linearGradient>
                      </defs>
                      {/* Baseline */}
                      <line x1={PAD_X} y1={PAD_T + plotH} x2={W - PAD_X} y2={PAD_T + plotH}
                        stroke="white" strokeOpacity="0.08" strokeWidth="1" />
                      {/* Grid lines */}
                      {[0.25, 0.5, 0.75, 1].map(f => (
                        <line key={f}
                          x1={PAD_X} y1={PAD_T + plotH - f * plotH}
                          x2={W - PAD_X} y2={PAD_T + plotH - f * plotH}
                          stroke="white" strokeOpacity="0.05" strokeWidth="1"
                        />
                      ))}
                      {/* Bars */}
                      {points.map((pt, i) => {
                        const cx = PAD_X + slotW * i + slotW / 2;
                        const barH = Math.max((pt.count / maxCount) * plotH, pt.count > 0 ? 4 : 0);
                        const x = cx - barW / 2;
                        const y = PAD_T + plotH - barH;
                        const hov = hoveredPoint === i;
                        const isEmpty = channelGroups.length === 0;
                        return (
                          <g key={i}
                            onMouseEnter={() => setHoveredPoint(i)}
                            onMouseLeave={() => setHoveredPoint(null)}
                            style={{ cursor: pt.count > 0 ? "pointer" : "default" }}
                          >
                            {/* Hit area */}
                            <rect x={x} y={PAD_T} width={barW} height={plotH} fill="transparent" />
                            {/* Bar */}
                            {barH > 0 && (
                              <path
                                d={`M ${x + r} ${y} H ${x + barW - r} Q ${x + barW} ${y} ${x + barW} ${y + r} V ${y + barH} H ${x} V ${y + r} Q ${x} ${y} ${x + r} ${y}`}
                                fill={hov ? "url(#barHov)" : "url(#barGrad)"}
                              />
                            )}
                            {/* Count label above bar */}
                            {pt.count > 0 && !hov && (
                              <text x={cx} y={y - 5} textAnchor="middle" fontSize="10" fill="#9b7ff5" fontWeight="600">
                                {pt.count}
                              </text>
                            )}
                            {/* Tooltip */}
                            {hov && (() => {
                              const TW = 90, TH = 32;
                              const TX = Math.min(Math.max(cx - TW / 2, PAD_X), W - PAD_X - TW);
                              const TY = Math.max(y - TH - 8, 2);
                              const nicheLabel = pt.label.length > 14 ? pt.label.slice(0, 13) + "…" : pt.label;
                              return (
                                <g>
                                  <rect x={TX} y={TY} width={TW} height={TH} rx={5} ry={5}
                                    fill="#1e1533" stroke="#9b7ff5" strokeOpacity="0.4" strokeWidth="1" />
                                  <text x={TX + TW / 2} y={TY + 12} textAnchor="middle" fontSize="9.5" fill="rgba(255,255,255,0.7)" fontWeight="500">
                                    {nicheLabel}
                                  </text>
                                  <text x={TX + TW / 2} y={TY + 24} textAnchor="middle" fontSize="10" fill="#9b7ff5" fontWeight="700">
                                    {pt.count} {pt.count === 1 ? "Video" : "Videos"}
                                  </text>
                                </g>
                              );
                            })()}
                            {/* X-axis label — word-wrapped */}
                            <text x={cx} textAnchor="middle" fontSize="10"
                              fill={isEmpty ? "rgba(255,255,255,0.12)" : hov ? "#9b7ff5" : "rgba(255,255,255,0.3)"}
                              fontWeight={hov ? "600" : "400"}>
                              {wrappedLabels[i].map((line, li) => (
                                <tspan key={li} x={cx} dy={li === 0 ? PAD_T + plotH + LINE_H : LINE_H}>
                                  {line}
                                </tspan>
                              ))}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                );
              })()}

              {/* API Keys Status */}
              {(() => {
                const el    = apiStatus?.elevenlabs as { configured: boolean; valid: boolean | null; charUsed?: number; charLimit?: number; tier?: string } | undefined;
                const kie   = apiStatus?.kie        as { configured: boolean; valid: boolean | null; credits?: number } | undefined;
                const yt    = apiStatus?.youtube    as { configured: boolean; valid: boolean | null; quotaPerDay?: number } | undefined;
                const anth  = apiStatus?.anthropic  as { configured: boolean; valid: boolean | null } | undefined;

                function StatusBadge({ data, color }: { data: { configured: boolean; valid: boolean | null } | undefined; color: string }) {
                  const loading = !apiStatus;
                  const statusColor = loading ? "var(--c-35)" : !data?.configured ? "#94a3b8" : data.valid === false ? "#f87171" : "#34d399";
                  const label      = loading ? "Checking…"   : !data?.configured ? "Not set"              : data.valid === false ? "Invalid key"          : "Active";
                  return (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: `${statusColor}22`, color: statusColor }}>
                      {label}
                    </span>
                  );
                }

                function UsageBar({ used, limit, color }: { used: number; limit: number; color: string }) {
                  const pct = Math.min(used / limit, 1);
                  const barColor = pct > 0.9 ? "#f87171" : color;
                  return (
                    <div>
                      <div className="flex justify-between text-[10px] mb-1" style={{ color: "var(--c-40)" }}>
                        <span>{used.toLocaleString()} used</span>
                        <span>{limit.toLocaleString()} limit</span>
                      </div>
                      <div className="w-full rounded-full h-1.5" style={{ background: "oklch(1 0 0 / 0.08)" }}>
                        <div className="h-1.5 rounded-full" style={{ width: `${pct * 100}%`, background: barColor }} />
                      </div>
                    </div>
                  );
                }

                function StaticInfo({ label, value, color }: { label: string; value: string; color: string }) {
                  return (
                    <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
                      {label}: <span className="font-semibold" style={{ color }}>{value}</span>
                    </p>
                  );
                }

                const cardStyle = { background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" };

                return (
                  <div style={{ marginTop: "40px" }}>
                    <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "10px", marginBottom: "10px" }}>Your API Keys Status</h3>
                    <div className="grid grid-cols-4 gap-4">

                      {/* Anthropic */}
                      <div className="rounded-xl px-5 py-4" style={cardStyle}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="w-2 h-2 rounded-full" style={{ background: "#c084fc" }} />
                          <StatusBadge data={anth} color="#c084fc" />
                        </div>
                        <p className="text-sm font-bold mb-0.5" style={{ color: "var(--c-88)" }}>Anthropic</p>
                        <p className="text-[10px] mb-3" style={{ color: "var(--c-38)" }}>Claude AI — scripts & analysis</p>
                        <StaticInfo label="Billing" value="Pay-per-token" color="#c084fc" />
                        <p className="text-[10px] mt-0.5" style={{ color: "var(--c-30)" }}>No credit pool — billed by usage</p>
                      </div>

                      {/* YouTube */}
                      <div className="rounded-xl px-5 py-4" style={cardStyle}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="w-2 h-2 rounded-full" style={{ background: "#f87171" }} />
                          <StatusBadge data={yt} color="#f87171" />
                        </div>
                        <p className="text-sm font-bold mb-0.5" style={{ color: "var(--c-88)" }}>YouTube</p>
                        <p className="text-[10px] mb-3" style={{ color: "var(--c-38)" }}>Channel lookup & metadata</p>
                        <StaticInfo label="Quota" value={`${(yt?.quotaPerDay ?? 10000).toLocaleString()} units / day`} color="#f87171" />
                        <p className="text-[10px] mt-0.5" style={{ color: "var(--c-30)" }}>Resets daily · View in Google Console</p>
                      </div>

                      {/* KIE */}
                      <div className="rounded-xl px-5 py-4" style={cardStyle}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="w-2 h-2 rounded-full" style={{ background: "#60a5fa" }} />
                          <StatusBadge data={kie} color="#60a5fa" />
                        </div>
                        <p className="text-sm font-bold mb-0.5" style={{ color: "var(--c-88)" }}>KIE</p>
                        <p className="text-[10px] mb-3" style={{ color: "var(--c-38)" }}>TTS, images & video generation</p>
                        {kie?.configured && kie.valid && kie.credits !== undefined ? (
                          <StaticInfo label="Credits remaining" value={kie.credits.toLocaleString()} color="#60a5fa" />
                        ) : kie?.configured && kie.valid ? (
                          <p className="text-[10px]" style={{ color: "var(--c-30)" }}>Check balance in KIE dashboard</p>
                        ) : null}
                      </div>

                      {/* ElevenLabs */}
                      <div className="rounded-xl px-5 py-4" style={cardStyle}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="w-2 h-2 rounded-full" style={{ background: "#34d399" }} />
                          <StatusBadge data={el} color="#34d399" />
                        </div>
                        <p className="text-sm font-bold mb-0.5" style={{ color: "var(--c-88)" }}>ElevenLabs</p>
                        <p className="text-[10px] mb-3" style={{ color: "var(--c-38)" }}>Voiceover & captions</p>
                        {el?.configured && el.valid && el.charLimit !== undefined ? (
                          <div>
                            <UsageBar used={el.charUsed ?? 0} limit={el.charLimit} color="#34d399" />
                            {el.tier && <p className="text-[10px] mt-1.5 capitalize" style={{ color: "var(--c-35)" }}>{el.tier} plan</p>}
                          </div>
                        ) : null}
                      </div>

                    </div>
                  </div>
                );
              })()}

              <h2 className="text-xl font-bold tracking-tight" style={{ color: "var(--c-85)", marginTop: "60px" }}>Your Niches & Videos</h2>
            </div>
          );
        })()}

        {/* Channel groups */}
        {channelGroups.length > 0 && (
          <div className="space-y-12">
            {channelGroups.map((group) => {
              return (
                <div key={group.channelName} className="rounded-2xl px-6" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)", paddingTop: "34px", paddingBottom: "34px" }}>
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
                    <div className="flex items-center gap-3">
                      <span className="text-xs px-3 py-1 rounded-full"
                        style={{ background: "var(--bg-elevated)", border: "1px solid var(--bd-6)", color: "var(--c-42)" }}>
                        {group.projects.length} {group.projects.length === 1 ? "video" : "videos"}
                      </span>
                      <button
                        onClick={() => createVideoForChannel(group)}
                        disabled={creating || !authReady}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
                        style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
                      >
                        + New Video
                      </button>
                    </div>
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
          <div className="flex flex-col items-center justify-center py-32 gap-6">
            <button
              onClick={createProject}
              disabled={creating || !authReady || atNicheLimit}
              className="w-16 h-16 rounded-2xl flex items-center justify-center transition-all hover:scale-105 active:scale-95 disabled:opacity-50 cursor-pointer"
              style={{
                background: "oklch(0.72 0.25 285 / 0.08)",
                border: "2px dashed oklch(0.72 0.25 285 / 0.35)",
                color: "oklch(0.72 0.25 285)",
              }}
            >
              <span className="text-3xl leading-none">+</span>
            </button>
            <div className="text-center space-y-2">
              <p className="text-base font-semibold" style={{ color: "var(--c-70)" }}>Start your first video</p>
              <p className="text-sm max-w-xs leading-relaxed" style={{ color: "var(--c-38)" }}>
                Paste a YouTube channel URL and Heclus will generate a full script, voiceover, AI images, and video clips — automatically.
              </p>
            </div>
            <button
              onClick={createProject}
              disabled={creating || !authReady || atNicheLimit}
              className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
            >
              {creating ? "Creating…" : "New Project →"}
            </button>
          </div>
        )}
      </main>

      {showSubscriptionModal && (
        <SubscriptionModal
          email={userEmail}
          defaultPlan={selectedPlan}
          onClose={() => { setShowSubscriptionModal(false); setPendingAction(null); }}
          onSuccess={handleSubscriptionSuccess}
        />
      )}
    </div>
  );
}
