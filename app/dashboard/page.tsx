"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import { Settings, LogOut, BarChart3, Trash2, Download, KeyRound, SlidersHorizontal, Wand2, ChevronRight, Clapperboard, Gift, X, Menu, List, LayoutGrid, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import useSWR, { mutate as globalMutate } from "swr";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { ADMIN_EMAILS } from "@/lib/admin";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SubscriptionModal } from "@/components/SubscriptionModal";
import { NicheLimitModal } from "@/components/NicheLimitModal";
import { CopyButton } from "@/components/CopyButton";
import { ApiKeysRequiredModal } from "@/components/ApiKeysRequiredModal";
import { CreditsAnnouncement } from "@/components/CreditsAnnouncement";
import type { ApiKeysStatus } from "@/app/api/me/api-keys-status/route";
import type { ElevenLabsCheck, KieCheck } from "@/lib/key-check";
import { DEMO_DATA } from "@/lib/demo-data";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { OneClickControls } from "@/components/one-click/OneClickControls";
import { UsageStats } from "@/components/UsageStats";
import { forkAndStartOneClick } from "@/lib/one-click/kickoff";
import { ONE_CLICK_HIDDEN } from "@/lib/feature-flags";
import { planLabel } from "@/lib/plan-tier";


// ── Demo dashboard helpers ────────────────────────────────────────────────────

type DashTab = "stats" | "keys" | "niches";
const DASH_TAB_KEY = "heclus.dashboard.tab";
const DASH_NAV: { id: DashTab; label: string; short: string; icon: LucideIcon }[] = [
  { id: "stats",  label: "Stats",            short: "Stats",  icon: BarChart3 },
  { id: "keys",   label: "API keys & usage", short: "Keys",   icon: KeyRound },
  { id: "niches", label: "Niches & Videos",  short: "Niches", icon: Clapperboard },
];

// Free-resources teaser. Shown to every account until dismissed. The suffix
// is the user id, added at render time.
// Niche is a filter over one flat video list, not a container around its own
// grid. NICHE_ALL is the unfiltered default.
const NICHE_ALL = "__all__";
const NICHE_FILTER_KEY = "heclus.dashboard.niche";
const VIDEO_VIEW_KEY = "heclus.dashboard.videoView";

const DEMO_STEP_LABELS = ["Channel", "Topic", "Script", "Visuals", "Prompts", "Generate", "Assemble", "Complete"];
const DEMO_STEP_HREFS  = [
  "/demo/channel", "/demo/topic", "/demo/script", "/demo/visuals",
  "/demo/prompts", "/demo/generate", "/demo/assemble", "/demo/thumbnails",
];
const DEMO_DEFAULT_TOPIC = "How Did Ancient Humans Name Their Children?";

interface DemoProgress {
  topic: string;
  highestStep: number;
  channelDone: boolean;
}

const R_PIE = 18, CX_PIE = 22, CY_PIE = 22, STROKE_PIE = 5;
const CIRC_PIE = 2 * Math.PI * R_PIE;

function DemoPieRing({ id, pct, color, centerText }: { id: string; pct: number; color: string; centerText: string }) {
  const dash = pct * CIRC_PIE;
  return (
    <svg width={44} height={44} viewBox="0 0 44 44">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.7" />
          <stop offset="100%" stopColor={color} />
        </linearGradient>
      </defs>
      <circle cx={CX_PIE} cy={CY_PIE} r={R_PIE} fill="none" stroke={color} strokeOpacity="0.12" strokeWidth={STROKE_PIE} />
      {pct >= 1 ? (
        <circle cx={CX_PIE} cy={CY_PIE} r={R_PIE} fill="none"
          stroke={`url(#${id})`} strokeWidth={STROKE_PIE} />
      ) : pct > 0 ? (
        <circle cx={CX_PIE} cy={CY_PIE} r={R_PIE} fill="none"
          stroke={`url(#${id})`} strokeWidth={STROKE_PIE}
          strokeDasharray={`${dash} ${CIRC_PIE}`}
          strokeDashoffset={CIRC_PIE / 4}
          strokeLinecap="round"
        />
      ) : null}
      <text x={CX_PIE} y={CY_PIE + 1} textAnchor="middle" dominantBaseline="middle"
        fontSize="8.5" fontWeight="700" fill={color}>{centerText}</text>
    </svg>
  );
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface Project {
  id: string;
  channel_name?: string;
  channel_url?: string;
  current_state: number;
  created_at: string;
  selected_topic?: string;
  assembly_status?: string | null;
  assembled_url?: string | null;
  auto_pilot?: boolean;
  auto_pilot_status?: string | null;
  auto_pilot_error?: string | null;
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

const PHASE_RANK: Record<string, number> = {
  channel: 0, topic: 1, script: 2, visuals: 3, prompts: 4, generate: 5, assemble: 6, thumbnails: 7,
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

// ── Demo dashboard content component ─────────────────────────────────────────

function DemoDashboardContent({ onSubscribe, demoProgress, demoNicheCreated }: { onSubscribe: () => void; demoProgress: DemoProgress; demoNicheCreated: boolean }) {
  const router = useRouter();
  const [hoveredBar, setHoveredBar] = useState(false);
  const [navigatingTo, setNavigatingTo] = useState<string | null>(null);

  // Prefetch the demo entry + the current resumable demo step so navigation
  // feels immediate. The parent already prefetches /demo/channel, but this
  // catches the resumable href (different per progress) as well.
  const step       = Math.min(demoProgress.highestStep, 7);
  const href       = DEMO_STEP_HREFS[step];

  useEffect(() => {
    router.prefetch("/demo/channel");
    if (href) router.prefetch(href);
  }, [router, href]);

  const hasStartedDemo = demoNicheCreated || demoProgress.topic !== "" || demoProgress.highestStep > 0;

  const isComplete = step === 7;
  const progress   = Math.round(((step + 1) / 8) * 100);
  const stateLabel = DEMO_STEP_LABELS[step];
  const title      = demoProgress.topic || DEMO_DEFAULT_TOPIC;

  const total     = hasStartedDemo ? 1 : 0;
  const completed = hasStartedDemo ? (isComplete ? 1 : 0) : 0;
  const inProg    = hasStartedDemo ? (isComplete ? 0 : 1) : 0;
  const niches    = hasStartedDemo ? 1 : 0;

  const STATIC_NICHE = {
    name: "MoneyMindset",
    url: "youtube.com/@moneymindset",
    videos: [
      { title: "5 Passive Income Streams That Actually Work in 2025", state: "Complete" },
      { title: "How I Built a $10K/Month Portfolio with ETFs", state: "Complete" },
      { title: "The Truth About Index Funds Nobody Tells You", state: "Complete" },
    ],
  };
  const nicheLimit = 1;

  const cardStyle = { background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" };

  const W = 600, PAD_X = 16, PAD_T = 16, PAD_B = 32, H = 160;
  const plotH = H - PAD_T - PAD_B;
  const barW = 52, rx = 5;
  const bars = [
    { label: "AncientHeclus", count: 1 },
  ];
  const maxCount = 1;
  const plotW = W - PAD_X * 2;
  const slotW = plotW / bars.length;

  return (
    <div className="space-y-12">
      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginBottom: "10px" }}>General Stats</h3>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {/* Niches — first, mirrors the real dashboard layout */}
          <div className="hover-lift rounded-xl px-5 py-4 flex items-center justify-between gap-3 transition-all duration-200" style={cardStyle}>
            <div className="min-w-0">
              <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{niches}</p>
              <p className="text-xs" style={{ color: "var(--c-42)" }}>Niches Used</p>
              <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>of {nicheLimit} lifetime</p>
            </div>
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <DemoPieRing id="dcNiche" pct={niches / nicheLimit} color="#5bc48a" centerText={`${niches}/${nicheLimit}`} />
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"
                style={{
                  background: "oklch(0.55 0.15 145 / 0.15)",
                  color: "oklch(0.65 0.15 145)",
                  border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                }}
              >
                Free
              </span>
            </div>
          </div>
          <div className="hover-lift rounded-xl px-5 py-4 transition-all duration-200" style={cardStyle}>
            <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{total}</p>
            <p className="text-xs" style={{ color: "var(--c-42)" }}>Total Videos</p>
          </div>
          <div className="hover-lift rounded-xl px-5 py-4 flex items-center justify-between transition-all duration-200" style={cardStyle}>
            <div>
              <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{completed}</p>
              <p className="text-xs" style={{ color: "var(--c-42)" }}>Completed</p>
              <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>{total > 0 ? `${Math.round((completed / total) * 100)}% of total` : "0%"}</p>
            </div>
            <DemoPieRing id="dcComp" pct={total > 0 ? completed / total : 0} color="#5bc48a" centerText={total > 0 ? `${Math.round((completed / total) * 100)}%` : "0%"} />
          </div>
          <div className="hover-lift rounded-xl px-5 py-4 flex items-center justify-between transition-all duration-200" style={cardStyle}>
            <div>
              <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{inProg}</p>
              <p className="text-xs" style={{ color: "var(--c-42)" }}>In Progress</p>
              <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>{total > 0 ? `${Math.round((inProg / total) * 100)}% of total` : "0%"}</p>
            </div>
            <DemoPieRing id="dcProg" pct={total > 0 ? inProg / total : 0} color="#f0a855" centerText={total > 0 ? `${Math.round((inProg / total) * 100)}%` : "0%"} />
          </div>
        </div>

        <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "40px", marginBottom: "10px" }}>Niches/Video Chart</h3>
        {!hasStartedDemo ? (
          <div className="rounded-2xl px-6 py-10 flex flex-col items-center justify-center text-center" style={cardStyle}>
            <p className="text-sm font-medium" style={{ color: "var(--c-40)" }}>No data yet</p>
            <p className="text-xs mt-1" style={{ color: "var(--c-30)" }}>Chart will populate once you start your first niche</p>
          </div>
        ) : (
        <div className="rounded-2xl px-4 py-4 sm:px-6 sm:py-5" style={cardStyle}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="text-sm font-semibold" style={{ color: "var(--c-75)" }}>Videos per niche</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--c-35)" }}>All time</p>
            </div>
            <span className="text-2xl font-bold" style={{ color: "var(--c-90)" }}>{total}</span>
          </div>
          <div style={{ overflowX: "clip" }}>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
            <defs>
              <linearGradient id="dcBarG" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#9b7ff5" stopOpacity="0.95" />
                <stop offset="100%" stopColor="#9b7ff5" stopOpacity="0.45" />
              </linearGradient>
              <linearGradient id="dcBarH" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#b89dff" stopOpacity="1" />
                <stop offset="100%" stopColor="#9b7ff5" stopOpacity="0.7" />
              </linearGradient>
            </defs>
            <line x1={PAD_X} y1={PAD_T + plotH} x2={W - PAD_X} y2={PAD_T + plotH} style={{ stroke: "oklch(1 0 0 / 0.08)" }} strokeWidth="1" />
            {[0.33, 0.67, 1].map(f => (
              <line key={f} x1={PAD_X} y1={PAD_T + plotH - f * plotH} x2={W - PAD_X} y2={PAD_T + plotH - f * plotH} style={{ stroke: "oklch(1 0 0 / 0.05)" }} strokeWidth="1" />
            ))}
            {bars.map((bar, i) => {
              const cx = PAD_X + slotW * i + slotW / 2;
              const bx = cx - barW / 2;
              const barH = (bar.count / maxCount) * plotH;
              const by = PAD_T + plotH - barH;
              return (
                <g key={bar.label}>
                  <path d={`M ${bx+rx} ${by} H ${bx+barW-rx} Q ${bx+barW} ${by} ${bx+barW} ${by+rx} V ${PAD_T+plotH} H ${bx} V ${by+rx} Q ${bx} ${by} ${bx+rx} ${by}`}
                    fill="url(#dcBarG)" opacity={0.85 + i * 0.15} />
                  <text x={cx} y={by - 5} textAnchor="middle" fontSize="10" fill="#9b7ff5" fontWeight="600">{bar.count}</text>
                  <text x={cx} y={PAD_T + plotH + 18} textAnchor="middle" fontSize="10"
                    style={{ fill: "var(--c-40)" }}>{bar.label}</text>
                </g>
              );
            })}
          </svg>
          </div>
        </div>
        )}

        <div style={{ marginTop: "40px" }}>
          <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "10px", marginBottom: "10px" }}>Start for free</h3>
          <div className="grid grid-cols-1 gap-4">
            <div className="rounded-xl px-5 py-4" style={cardStyle}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-bold leading-tight" style={{ color: "var(--c-88)" }}>Free tools</p>
                  <p className="text-[10px] font-medium mt-0.5" style={{ color: "oklch(0.65 0.15 145)" }}>No card needed</p>
                  <p className="text-[10px] mt-0.5" style={{ color: "var(--c-38)" }}>
                    Connect free image and voiceover providers and start generating on their free quotas.
                  </p>
                </div>
                <button
                  type="button"
                  disabled
                  title="Available once you subscribe"
                  className="text-[11px] font-semibold px-3 py-1.5 rounded-lg shrink-0 opacity-40 cursor-not-allowed"
                  style={{ background: "oklch(0.72 0.25 285 / 0.12)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                >
                  Set up free tools →
                </button>
              </div>
            </div>
          </div>
        </div>

        <h2 className="text-xl font-bold tracking-tight" style={{ color: "var(--c-85)", marginTop: "60px" }}>Your Niches & Videos</h2>
      </div>

      {!hasStartedDemo ? (
        <div className="rounded-2xl px-6 py-16 flex flex-col items-center justify-center text-center" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}>
          <p className="text-sm font-medium mb-1" style={{ color: "var(--c-45)" }}>No niches yet</p>
          <p className="text-xs mb-6" style={{ color: "var(--c-30)" }}>Try the demo to see how a niche looks, or subscribe to create your first one.</p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setNavigatingTo("try-demo"); router.push("/demo/channel"); }}
              disabled={navigatingTo === "try-demo"}
              className="px-4 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-60 cursor-pointer"
              style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-8)", color: "var(--c-60)" }}
            >
              {navigatingTo === "try-demo" ? "Loading…" : "Try demo →"}
            </button>
            <button
              onClick={onSubscribe}
              className="px-4 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
            >
              Subscribe & Start →
            </button>
          </div>
        </div>
      ) : (
      <>
      {/* AncientHeclus channel group */}
      <div>
        <div className="rounded-2xl px-4 sm:px-6 py-6 sm:py-8" style={cardStyle}>
          <div className="flex items-center justify-between gap-3 mb-5">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center text-base font-bold shrink-0"
                style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
                F
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-bold truncate">{DEMO_DATA.channel.name}</h2>
                <p className="text-xs mt-0.5 truncate" style={{ color: "var(--c-38)" }}>{DEMO_DATA.channel.url}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="hidden sm:inline text-xs px-3 py-1 rounded-full" style={{ background: "var(--bg-elevated)", border: "1px solid var(--bd-6)", color: "var(--c-42)" }}>
                {total} videos
              </span>
              <button
                onClick={onSubscribe}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 cursor-pointer"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
              >
                + New Video
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <button
              onClick={() => { setNavigatingTo("resume-demo"); router.push(href); }}
              disabled={navigatingTo === "resume-demo"}
              className="text-left p-4 sm:p-6 rounded-2xl transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer disabled:opacity-70"
              style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.35)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-card)"; }}
            >
              <div className="flex items-start justify-between mb-3">
                <span className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                  style={isComplete ? {
                    background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                  } : {
                    background: "oklch(0.72 0.25 285 / 0.1)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                  }}>
                  {stateLabel}
                </span>
                {isComplete && (
                  <span
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      const link = document.createElement("a");
                      link.href = "/demo/assemble/Heclus demo video.mp4";
                      link.download = "Heclus demo video.mp4";
                      document.body.appendChild(link);
                      link.click();
                      document.body.removeChild(link);
                    }}
                    className="p-1 rounded-lg transition-all hover:opacity-90"
                    style={{ color: "oklch(0.65 0.15 145)", cursor: "pointer" }}
                    title="Download assembled video"
                  >
                    <Download size={13} />
                  </span>
                )}
              </div>
              <p className="text-lg font-semibold leading-snug mb-5" style={{ color: "var(--c-88)" }}>{title}</p>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs" style={{ color: "var(--c-38)" }}>
                  <span>Progress</span><span>{progress}%</span>
                </div>
                <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                  <div className="h-full rounded-full transition-all" style={{
                    width: `${progress}%`,
                    background: isComplete ? "oklch(0.55 0.15 145)" : "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                  }} />
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* Static niche group — locked/grayed */}
      <div style={{ opacity: 0.18, pointerEvents: "none", userSelect: "none" }} >
        <div className="rounded-2xl px-4 sm:px-6 py-6 sm:py-8" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}>
          <div className="flex items-center justify-between gap-3 mb-5">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center text-base font-bold shrink-0"
                style={{ background: "oklch(0.5 0 0 / 0.15)", color: "oklch(0.5 0 0)", border: "1px solid oklch(0.5 0 0 / 0.25)" }}>
                M
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-bold truncate">{STATIC_NICHE.name}</h2>
                <p className="text-xs mt-0.5 truncate" style={{ color: "var(--c-38)" }}>{STATIC_NICHE.url}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="hidden sm:inline text-xs px-3 py-1 rounded-full" style={{ background: "var(--bg-elevated)", border: "1px solid var(--bd-6)", color: "var(--c-42)" }}>
                {STATIC_NICHE.videos.length} videos
              </span>
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
                style={{ background: "oklch(0.3 0 0)", color: "oklch(0.5 0 0)" }}>
                + New Video
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {STATIC_NICHE.videos.map((v) => (
              <div
                key={v.title}
                className="text-left p-4 sm:p-6 rounded-2xl"
                style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}
              >
                <div className="flex items-start justify-between mb-3">
                  <span className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                    style={{ background: "oklch(0.3 0 0 / 0.3)", color: "oklch(0.45 0 0)", border: "1px solid oklch(0.3 0 0 / 0.2)" }}>
                    {v.state}
                  </span>
                  <span className="p-1 rounded-lg" style={{ color: "oklch(0.45 0 0)" }} title="Download video">
                    <Download size={13} />
                  </span>
                </div>
                <p className="text-lg font-semibold leading-snug mb-5" style={{ color: "var(--c-88)" }}>{v.title}</p>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs" style={{ color: "var(--c-38)" }}>
                    <span>Progress</span><span>100%</span>
                  </div>
                  <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                    <div className="h-full rounded-full" style={{ width: "100%", background: "oklch(0.4 0 0)" }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

// ── Real dashboard ────────────────────────────────────────────────────────────

// Module-level cache so navigating away and back doesn't re-fetch
// metadata for the same video URL. Keyed by URL; value is duration in
// seconds (or null when the metadata load failed).
const videoDurationCache = new Map<string, number | null>();

function formatVideoDuration(sec: number): string {
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

function VideoDurationBadge({ src }: { src: string }) {
  const [duration, setDuration] = useState<number | null>(() =>
    videoDurationCache.has(src) ? videoDurationCache.get(src) ?? null : null,
  );
  const already = videoDurationCache.has(src);
  useEffect(() => {
    if (already) return;
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    let cancelled = false;
    const onLoaded = () => {
      if (cancelled) return;
      const d = isFinite(v.duration) ? v.duration : null;
      videoDurationCache.set(src, d);
      setDuration(d);
    };
    const onError = () => {
      if (cancelled) return;
      videoDurationCache.set(src, null);
      setDuration(null);
    };
    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("error", onError);
    v.src = src;
    return () => {
      cancelled = true;
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("error", onError);
      v.removeAttribute("src");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (v as any).load?.();
    };
  }, [src, already]);
  if (duration == null) return null;
  return (
    <span
      className="text-xs px-2 py-0.5 rounded-full font-medium tabular-nums"
      style={{
        background: "oklch(0 0 0 / 0.4)",
        color: "var(--c-88)",
        border: "1px solid oklch(1 0 0 / 0.08)",
      }}
      title="Assembled video length"
    >
      {formatVideoDuration(duration)}
    </span>
  );
}

export default function HomePage() {
  const router = useRouter();
  // Dashboard sections as tabs. Lazily read from localStorage so returning
  // from a project lands on the tab you left, and guarded because this runs
  // during hydration where storage may be unavailable.
  const [dashTab, setDashTab] = useState<DashTab>(() => {
    if (typeof window === "undefined") return "stats";
    try {
      const saved = window.localStorage.getItem(DASH_TAB_KEY);
      return saved === "keys" || saved === "niches" ? saved : "stats";
    } catch { return "stats"; }
  });
  const selectDashTab = (t: DashTab) => {
    setDashTab(t);
    setSidebarOpen(false);
    try { window.localStorage.setItem(DASH_TAB_KEY, t); } catch { /* storage disabled */ }
  };

  const [nicheFilter, setNicheFilter] = useState<string>(NICHE_ALL);
  const [videoView, setVideoView] = useState<"list" | "cards">("list");
  useEffect(() => {
    try {
      const n = window.localStorage.getItem(NICHE_FILTER_KEY);
      if (n) setNicheFilter(n);
      const v = window.localStorage.getItem(VIDEO_VIEW_KEY);
      if (v === "cards" || v === "list") setVideoView(v);
    } catch { /* storage disabled */ }
  }, []);
  const selectNiche = (name: string) => {
    setNicheFilter(name);
    setSidebarOpen(false);
    // The filter only means anything on the video list, so choosing one takes
    // you there rather than silently filtering a section you cannot see.
    setDashTab("niches");
    try { window.localStorage.setItem(DASH_TAB_KEY, "niches"); } catch { /* storage disabled */ }
    try { window.localStorage.setItem(NICHE_FILTER_KEY, name); } catch { /* storage disabled */ }
  };
  const selectVideoView = (v: "list" | "cards") => {
    setVideoView(v);
    try { window.localStorage.setItem(VIDEO_VIEW_KEY, v); } catch { /* storage disabled */ }
  };

  // Below lg the sidebar is a drawer. Same layout, just off-canvas until the
  // header's menu button opens it.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [creating, setCreating] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPaid, setIsPaid] = useState<boolean | null>(null);
  // Has this account ever completed a purchase? Distinct from isPaid, which is
  // only about right now. An ex-subscriber whose period lapsed keeps their own
  // dashboard; only a never-subscribed visitor sees the demo one.
  const [everSubscribed, setEverSubscribed] = useState(false);
  const [demoProgress, setDemoProgress] = useState<DemoProgress>({ topic: "", highestStep: 0, channelDone: false });
  const [demoNicheCreated, setDemoNicheCreated] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [showNicheLimitModal, setShowNicheLimitModal] = useState(false);
  const [showApiKeysModal, setShowApiKeysModal] = useState(false);
  const [navigatingTo, setNavigatingTo] = useState<string | null>(null);

  // Prefetch the most common destinations so navigation is near-instant once
  // the user clicks. Forks (/projects/[id]/topic) prefetch via the dynamic
  // segment's shared bundle.
  useEffect(() => {
    router.prefetch("/projects/new/channel");
    router.prefetch("/demo/channel");
  }, [router]);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<string | undefined>(undefined);
  const [hoveredPoint, setHoveredPoint] = useState<number | null>(null);
  const [userPlan, setUserPlan] = useState<string>("starter");
  const [memberSince, setMemberSince] = useState<string>("");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showProfileMenu) return;
    function handleClick(e: MouseEvent) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showProfileMenu]);
  const { data: apiStatus } = useSWR("/api/api-status", fetcher, { revalidateOnFocus: false });

  useEffect(() => {
    let cancelled = false;
    const supabase = createSupabaseBrowserClient();

    function applyUser(user: { id: string; email?: string | null; created_at?: string; app_metadata?: Record<string, unknown> }) {
      if (cancelled) return;
      // Admins (legacy founder + dashboard-promoted via
      // app_metadata.is_admin) get the Admin button. Inlined
      // instead of using isAdminUser because applyUser's param
      // shape is the projected payload from auth.getUser, not the
      // full User type. Logic mirrors lib/admin.ts:isAdminUser.
      const adminFlag = user.app_metadata?.is_admin === true
        || ADMIN_EMAILS.has((user.email ?? "").toLowerCase());
      if (adminFlag) setIsAdmin(true);
      setUserEmail(user.email ?? "");
      if (user.created_at) {
        setMemberSince(new Date(user.created_at).toLocaleDateString("en", { month: "short", year: "numeric" }));
      }
      const paid = (user.app_metadata?.paid === true) || false;
      setIsPaid(paid);
      // Same predicate as subscriptionExpired() in lib/subscription.ts, read
      // off the session user so it resolves in the same tick as isPaid. Going
      // through /api/usage instead would leave a frame where this is unknown,
      // and the dashboard would visibly swap itself out.
      {
        const meta = user.app_metadata ?? {};
        const dodo = (meta.dodo ?? {}) as Record<string, unknown>;
        setEverSubscribed(Boolean(meta.paid_at || meta.plan_expires_at || dodo.subscription_id));
      }
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

  useEffect(() => {
    // Read sessionStorage for in-session step tracking
    try {
      const raw = sessionStorage.getItem("demo_state_v1");
      if (raw) {
        const s = JSON.parse(raw);
        setDemoProgress({
          topic: typeof s.selectedTopic === "string" ? s.selectedTopic : "",
          highestStep: typeof s.highestStep === "number" ? s.highestStep : 0,
          channelDone: s.channelPhase === "done",
        });
      }
    } catch {}

    // Read persistent DB flag
    fetch("/api/demo-niche")
      .then(r => r.json())
      .then(d => { if (d.demo_niche_created) setDemoNicheCreated(true); })
      .catch(() => {});
  }, []);

  async function handleSignOut() {
    try { sessionStorage.removeItem("demo_state_v1"); } catch {}
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }
  const { data: projects, mutate: mutateProjects } = useSWR<Project[]>("/api/projects", fetcher);

  type DeleteTarget =
    | { type: "video"; id: string; label: string }
    | { type: "niche"; channelName: string; projectIds: string[]; count: number };
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  // "New Video" opens a Studio-vs-1Click chooser before creating the fork.
  const [newVideoGroup, setNewVideoGroup] = useState<ChannelGroup | null>(null);
  // Header "New" button: first asks niche-or-video, then (for a video) which
  // niche it belongs to. A video can't be created from the header without one,
  // because it forks an existing niche's channel analysis and visual profile.
  const [newChooser, setNewChooser] = useState(false);
  const [pickNicheForVideo, setPickNicheForVideo] = useState(false);
  const [startingOneClick, setStartingOneClick] = useState(false);
  // Studio-vs-1Click chooser for a brand-new niche (no group to fork).
  const [newNicheChooser, setNewNicheChooser] = useState(false);
  // When 1Click is picked but not configured, the modal swaps to a
  // "set up first" view instead of navigating away.
  const [oneClickNeedsSetup, setOneClickNeedsSetup] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  async function downloadVideo(id: string, url: string, topic: string) {
    setDownloadingId(id);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch video");
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `${topic.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "")}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      toast.error("Failed to download video");
    } finally {
      setDownloadingId(null);
    }
  }

  const channelGroups = useMemo<ChannelGroup[]>(() => {
    if (!Array.isArray(projects)) return [];
    const map = new Map<string, ChannelGroup>();
    for (const p of projects) {
      if (!p.channel_name) continue; // hide until channel step is completed
      const key = p.channel_name;
      if (!map.has(key)) {
        map.set(key, { channelName: key, channelUrl: p.channel_url, projects: [], lastActive: p.created_at });
      }
      const group = map.get(key)!;
      // Whichever video in the niche carries the address. The first one need
      // not have it, and one missing URL there would hide the copy control
      // everywhere the niche appears.
      if (!group.channelUrl && p.channel_url) group.channelUrl = p.channel_url;
      group.projects.push(p);
      if (p.created_at > group.lastActive) group.lastActive = p.created_at;
    }
    return Array.from(map.values()).sort((a, b) => b.lastActive.localeCompare(a.lastActive));
  }, [projects]);

  // Lifetime usage from the server — deletions don't decrement, so this
  // is the source of truth for whether the user can add another niche.
  const { data: usage, mutate: mutateUsage } = useSWR<{
    niches_used: number;
    niche_limit: number | null;
    plan_default_limit?: number | null;
    niche_limit_override?: number | null;
    at_limit: boolean;
    plan: string;
    is_admin: boolean;
    subscription_expired?: boolean;
  }>("/api/usage", fetcher);

  // User-only API keys check (admins skip the gate since they can use
  // platform env vars). Drives the pre-niche modal in createProject.
  const { data: apiKeysStatus } = useSWR<ApiKeysStatus>(
    isAdmin ? null : "/api/me/api-keys-status",
    fetcher,
    { revalidateOnFocus: true },
  );

  // Whether this account has any business being asked for provider keys.
  //
  // Only a BYO-funded account does. Everyone signing up now lands on Heclus
  // Credits, where generations run on our providers and there is nothing to
  // connect, so "KIE — Pending setup" was telling new customers they had an
  // unfinished task that does not exist. Legacy customers on their own key
  // still see it, since for them it is the thing that makes the product work.
  //
  // Hidden until the answer is known: showing it and taking it away is worse
  // than a section that appears a beat late.
  const needsOwnKeys =
    apiKeysStatus?.fundingMode === "byo" && !apiKeysStatus.onHeclusCreditsPlan;


  const nicheLimit = usage?.niche_limit ?? null;
  const nichesUsed = usage?.niches_used ?? 0;
  const atNicheLimit = !!usage?.at_limit;
  // When the admin has set a niche-limit override, show the original
  // plan-derived ratio in the headline (so the user sees their plan
  // honoured) and call out the override separately. `niche_limit` is
  // already the effective value (override ?? plan default) and stays
  // the basis for at-limit gating.
  const planDefaultLimit = usage?.plan_default_limit ?? null;
  const nicheLimitOverride = usage?.niche_limit_override ?? null;
  const hasOverride = nicheLimitOverride !== null;

  function requireSubscription(action: () => void) {
    // An expired subscription (app_metadata.paid can lag true after the
    // period lapses) must route to the renew/subscribe modal — NOT fall
    // through to the API-keys gate. subscription_expired is the same
    // predicate the spend-gated server routes use.
    const expired = usage?.subscription_expired === true;
    if ((isPaid && !expired) || isAdmin) {
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
    mutateUsage();
    router.push("/dashboard");
  }

  // A brand-new niche has no channel analysis yet, so 1Click can't start
  // here the way it can for an existing niche — both modes go to the
  // channel step, and the mode rides along so that page opens on the right
  // one. From there the 1Click path analyses and engages autopilot itself.
  // Studio goes to the wizard's channel step as always. 1Click goes to the
  // 1Click view, which collects the content type + channel itself and then
  // runs the kickoff without leaving that page.
  async function doCreateProject(mode: "studio" | "oneclick" = "studio") {
    if (mode === "studio") {
      setNewNicheChooser(false);
      setNavigatingTo("new-niche");
      router.push("/projects/new/channel");
      return;
    }
    // First-run gate, same as the existing-niche path: a user who has never
    // configured 1Click gets told what's about to happen instead of landing
    // in a setup stepper unannounced.
    setStartingOneClick(true);
    try {
      const cfgRes = await fetch("/api/one-click/config");
      const cfg = (await cfgRes.json().catch(() => ({}))) as { configured?: boolean };
      if (!cfgRes.ok || !cfg.configured) {
        setOneClickNeedsSetup(true);
        return;
      }
      setNewNicheChooser(false);
      setNavigatingTo("new-niche");
      router.push("/one-click?new=1");
    } catch {
      // Can't tell either way — let the 1Click view sort it out.
      setNewNicheChooser(false);
      router.push("/one-click?new=1");
    } finally {
      setStartingOneClick(false);
    }
  }

  function requireApiKeys(action: () => void) {
    // Admins bypass the gate — the platform env-var fallback covers
    // their setup. Paid customers must have entered both keys before
    // we let them burn project resources against shared credentials.
    //
    // readyToGenerate rather than bothSet: a wallet-funded account runs on
    // Heclus's keys and is meant to have none of its own, so gating it on keys
    // would send a customer who owes us nothing to a setup page with nothing to
    // fill in.
    if (isAdmin) { action(); return; }
    // The plan is checked here as well as on the server. This modal asks a
    // customer to go and open a KIE account, and it must not be reachable by
    // somebody whose plan sold them credits instead, whatever a funding read
    // did or did not manage to say.
    if (apiKeysStatus && !apiKeysStatus.readyToGenerate && !apiKeysStatus.onHeclusCreditsPlan) {
      setShowApiKeysModal(true);
      return;
    }
    action();
  }

  function createProject() {
    if (atNicheLimit && nicheLimit !== null) {
      setShowNicheLimitModal(true);
      return;
    }
    // Same shape as createVideoForChannel: gate first, then let the user
    // pick Studio vs 1Click. With 1Click hidden there's nothing to choose,
    // so skip the chooser and go straight to Studio.
    requireSubscription(() => requireApiKeys(() => {
      if (ONE_CLICK_HIDDEN) { doCreateProject("studio"); return; }
      setNewNicheChooser(true);
    }));
  }

  function doCreateVideoForChannel(group: ChannelGroup) {
    const source = [...group.projects].sort((a, b) => b.current_state - a.current_state)[0];
    setNavigatingTo(`new-video-${group.channelName}`);
    router.push(`/projects/new-fork/topic?from=${source.id}`);
  }

  // 1Click path for a new video in an existing niche: fork the niche's
  // channel (analysis/ideas/visual profile already done), engage autopilot,
  // and hand straight off to the live view — 1Click takes over immediately.
  async function doOneClickVideoForChannel(group: ChannelGroup) {
    const source = [...group.projects].sort((a, b) => b.current_state - a.current_state)[0];
    setStartingOneClick(true);
    try {
      // Check 1Click is configured BEFORE forking — otherwise a not-yet-
      // configured user would leave an orphan project behind. If it isn't
      // set up, swap the modal to the "set up first" view (no fork, no nav).
      const cfgRes = await fetch("/api/one-click/config");
      const cfg = (await cfgRes.json().catch(() => ({}))) as { configured?: boolean };
      if (!cfgRes.ok || !cfg.configured) {
        setOneClickNeedsSetup(true);
        return;
      }
      const newProjectId = await forkAndStartOneClick(source.id);
      toast.success("1Click engaged. We'll take it from here.");
      router.push(`/projects/${newProjectId}/one-click`);
    } catch (err) {
      // A config that vanished between the check above and the start call
      // lands here; the stepper is the place to fix that, not the Setup page.
      if ((err as { code?: string }).code === "not_configured") {
        router.push(`/one-click?from=${encodeURIComponent(source.id)}`);
        return;
      }
      toast.error(err instanceof Error ? err.message : "1Click start failed");
    } finally {
      setStartingOneClick(false);
    }
  }

  function createVideoForChannel(group: ChannelGroup) {
    // Gate on subscription + API keys, then let the user pick Studio vs 1Click.
    requireSubscription(() => requireApiKeys(() => {
      if (ONE_CLICK_HIDDEN) { doCreateVideoForChannel(group); return; }
      setNewVideoGroup(group);
    }));
  }

  async function deleteOne(id: string): Promise<{ id: string; ok: boolean; error?: string; warnings?: string[] }> {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({})) as { error?: string; warnings?: string[] };
      if (!res.ok) return { id, ok: false, error: data.error ?? `HTTP ${res.status}` };
      return { id, ok: true, warnings: data.warnings };
    } catch (err) {
      return { id, ok: false, error: err instanceof Error ? err.message : "Network error" };
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const ids = deleteTarget.type === "video" ? [deleteTarget.id] : deleteTarget.projectIds;

      // Chunk parallel deletes to avoid hammering Supabase/R2
      const CONCURRENCY = 3;
      const results: { id: string; ok: boolean; error?: string; warnings?: string[] }[] = [];
      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const chunk = ids.slice(i, i + CONCURRENCY);
        const chunkResults = await Promise.all(chunk.map(deleteOne));
        results.push(...chunkResults);
      }

      const succeeded = results.filter((r) => r.ok).map((r) => r.id);
      const failed = results.filter((r) => !r.ok);
      const warnings = results.flatMap((r) => r.warnings ?? []);

      // Optimistic UI update for successfully deleted projects
      if (succeeded.length > 0) {
        mutateProjects((prev) => prev?.filter((p) => !succeeded.includes(p.id)), false);
        // Wipe per-project SWR caches so any open project page sees the deletion
        for (const id of succeeded) {
          globalMutate(`/api/projects/${id}`, undefined, false);
        }
      }

      // Surface partial failures clearly
      if (failed.length === 0) {
        if (warnings.length > 0) {
          toast.warning(`Deleted, but some cleanup warnings: ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ""}`);
        }
        setDeleteTarget(null);
      } else if (failed.length === ids.length) {
        toast.error(`Failed to delete: ${failed[0].error}`);
      } else {
        toast.error(`${succeeded.length} deleted, ${failed.length} failed — ${failed[0].error}`);
        setDeleteTarget(null);
      }

      // Revalidate to catch any silent server-side discrepancies
      mutateProjects();
    } finally {
      setDeleting(false);
    }
  }

  const authReady = !!userEmail || isAdmin;
  // Show demo data only to users who have NEVER subscribed (once auth is
  // resolved). A lapsed subscriber used to land here too, which swapped their
  // sidebar, niches and videos for demo content and read as though the account
  // had been wiped. They stay on their own dashboard; the spend-triggering
  // actions are gated by requireSubscription, which is the same predicate the
  // server's 403 uses.
  const showDemo = isPaid === false && !isAdmin && !everSubscribed;
  // Lapsed subscriber on their own dashboard: the calls to action have to say
  // renew, not subscribe, to someone who has already paid.
  const isLapsed = isPaid === false && !isAdmin && everSubscribed;

  return (
    <div className={`min-h-screen flex flex-col overflow-x-hidden ${showDemo ? "" : "lg:pl-[300px]"}`} style={{ background: "var(--bg-page)" }}>
      {/* Full-height sidebar, fixed so it spans the viewport rather than
          starting under the header. Everything else is inset by its width
          via lg:pl-[240px] on the page root. Hidden below lg, where the
          horizontal rail above the content takes over. */}
      {!showDemo && (
        <aside className={`fixed left-0 bottom-0 top-[109px] sm:top-[117px] lg:top-0 z-40 flex flex-col transition-all duration-200 lg:translate-x-0 w-[85vw] sm:w-[380px] lg:w-[300px] ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
          style={{ background: "var(--bg-header)", borderRight: "1px solid var(--bd-10)" }}>
          <Link href="/dashboard" className="hidden lg:flex items-center gap-3 px-5 h-[69px] shrink-0 transition-opacity hover:opacity-80"
            style={{ borderBottom: "1px solid var(--bd-6)" }}>
            <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
              <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
            </div>
            <span className="text-base font-bold tracking-tight" style={{ color: "var(--c-90)" }}>Heclus</span>
          </Link>
          <nav className="flex-1 min-h-0 flex flex-col gap-1 pl-5 pr-[30px] py-5">
            {DASH_NAV.map((t) => {
              const active = dashTab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => selectDashTab(t.id)}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-medium text-left transition-all cursor-pointer ${active ? "" : "hover-nudge"}`}
                  style={active ? {
                    background: "oklch(0.72 0.25 285 / 0.15)",
                    border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                    color: "var(--accent-purple-text)",
                  } : {
                    background: "transparent",
                    border: "1px solid transparent",
                    color: "var(--c-55)",
                  }}
                >
                  <Icon size={15} className="shrink-0" />
                  <span className="min-w-0 truncate">{t.label}</span>
                </button>
              );
            })}

            {/* Niches are a filter over the video list, so they belong in the
                nav rather than as headers repeated down the page. */}
            {/* Placeholder rows while projects load. Without them the nav
                shows only the three section links and then jumps as the
                niches arrive, which reads as the list having failed. */}
            {projects === undefined && (
              <div className="pt-2 pl-[5px] flex flex-col gap-1.5" style={{ borderTop: "1px solid var(--bd-6)" }}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center gap-2 px-3.5 py-2">
                    <div className="h-3 rounded animate-pulse" style={{ background: "var(--skeleton)", width: `${["70%", "52%", "64%", "44%", "58%"][i]}` }} />
                  </div>
                ))}
              </div>
            )}

            {channelGroups.length > 0 && (
              <div className="pt-2 pl-[5px] flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5"
                style={{ borderTop: "1px solid var(--bd-6)", scrollbarWidth: "thin" }}>
                <button
                  onClick={() => selectNiche(NICHE_ALL)}
                  className={`flex items-center gap-2 pl-3.5 pr-3 py-2.5 rounded-lg text-[13px] text-left transition-all cursor-pointer ${nicheFilter === NICHE_ALL ? "" : "hover-nudge"}`}
                  style={{ background: nicheFilter === NICHE_ALL ? "oklch(1 0 0 / 0.07)" : "transparent", color: nicheFilter === NICHE_ALL ? "var(--c-85)" : "var(--c-45)" }}
                >
                  <span className="min-w-0 flex-1 truncate">All videos</span>
                  <span className="shrink-0 tabular-nums text-[11px]" style={{ color: "var(--c-38)" }}>
                    {channelGroups.reduce((acc, g) => acc + g.projects.length, 0)}
                  </span>
                </button>

                {channelGroups.map((g) => {
                  const on = nicheFilter === g.channelName;
                  return (
                    // A div, not a button: the copy control lives inside the
                    // row and a button cannot contain another one.
                    <div
                      key={g.channelName}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectNiche(g.channelName)}
                      onKeyDown={(e) => {
                        // Only the row itself. Enter on the copy button inside
                        // it would otherwise copy and change the filter at once.
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectNiche(g.channelName); }
                      }}
                      className={`group flex items-center gap-2 pl-3.5 pr-3 py-2.5 rounded-lg text-[13px] text-left transition-all cursor-pointer ${on ? "" : "hover-nudge"}`}
                      style={{ background: on ? "oklch(1 0 0 / 0.07)" : "transparent", color: on ? "var(--c-85)" : "var(--c-45)" }}
                    >
                      <span className="min-w-0 flex-1 truncate">{g.channelName}</span>
                      {/* Copy takes the count's place on hover rather than
                          sitting beside it: one slot, so the name does not
                          shorten and the row does not shuffle under the
                          pointer. The count is not what you are reaching for
                          at that moment anyway. */}
                      <span className="relative shrink-0 flex items-center justify-center min-w-5 h-5">
                        <span className={`tabular-nums text-[11px] transition-opacity ${g.channelUrl ? "group-hover:opacity-0 group-focus-within:opacity-0" : ""}`}
                          style={{ color: "var(--c-38)" }}>
                          {g.projects.length}
                        </span>
                        {g.channelUrl && (
                          <CopyButton
                            text={g.channelUrl}
                            title="Copy channel URL"
                            className="absolute inset-0 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
                          />
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </nav>
        </aside>
      )}

      {!showDemo && sidebarOpen && (
        <div
          className="lg:hidden fixed left-0 right-0 bottom-0 top-[109px] sm:top-[117px] z-30"
          style={{ background: "oklch(0 0 0 / 0.55)" }}
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      {/* Header. Fixed, so a spacer below stands in for its height. */}
      <header className={`flex items-center justify-between px-4 sm:px-8 py-3 sm:py-4 fixed top-0 left-0 right-0 z-50 ${showDemo ? "" : "lg:left-[300px]"}`}
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <div className="flex items-center gap-2 min-w-0">
        <Link href="/dashboard" className={`items-center gap-3 transition-opacity hover:opacity-80 ${showDemo ? "flex" : "flex lg:hidden"}`}>
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
          </div>
        </Link>
        {/* On lg the brand sits in the sidebar, which left this side of the
            header empty. The section you are in goes here instead, the same
            label the menu row shows on smaller screens. */}
        {!showDemo && (
          <h1 className="hidden lg:block text-sm font-semibold truncate" style={{ color: "var(--c-88)" }}>
            {DASH_NAV.find((t) => t.id === dashTab)?.label ?? ""}
          </h1>
        )}
        </div>
        <div className="flex items-center gap-3">
          {isAdmin && (
            <Link
              href="/admin"
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80"
              style={{ background: "oklch(0.72 0.25 285 / 0.1)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}
            >
              <BarChart3 size={15} />
              <span>Admin</span>
            </Link>
          )}
          <ThemeToggle />
          {/* Profile avatar + dropdown */}
          <div className="relative" ref={profileMenuRef}>
            <button
              onClick={() => setShowProfileMenu(v => !v)}
              className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              {userEmail ? userEmail[0].toUpperCase() : "?"}
            </button>

            {showProfileMenu && (
              <>
                {/* Dropdown */}
                <div className="absolute right-0 top-12 z-[200] w-64 rounded-2xl py-3 shadow-2xl"
                  style={{ background: "var(--bg-card)", border: "1px solid var(--bd-10)" }}>

                  {/* Avatar + info */}
                  <div className="px-4 pb-3" style={{ borderBottom: "1px solid var(--bd-7)" }}>
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
                          style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
                          {planLabel(isPaid || isLapsed ? userPlan : null)} plan →
                        </Link>
                      )}
                    </div>
                  </div>

                  {/* Menu items */}
                  <div className="px-2 pt-2">
                    {isPaid || isAdmin ? (
                      <Link
                        href="/setup"
                        onClick={() => setShowProfileMenu(false)}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80"
                        style={{ color: "var(--c-60)" }}
                      >
                        <Settings size={15} />
                        <span>Config</span>
                      </Link>
                    ) : (
                      <button
                        onClick={() => { setShowProfileMenu(false); setShowSubscriptionModal(true); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80 cursor-pointer"
                        style={{ color: "var(--c-60)" }}
                      >
                        <Settings size={15} />
                        <span>Config</span>
                      </button>
                    )}
                    <Link
                      href="/account"
                      onClick={() => setShowProfileMenu(false)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80"
                      style={{ color: "var(--c-60)" }}
                    >
                      <KeyRound size={15} />
                      <span>Account</span>
                    </Link>
                    <Link
                      href="/billing"
                      onClick={() => setShowProfileMenu(false)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80"
                      style={{ color: "var(--c-60)" }}
                    >
                      <Wallet size={15} />
                      <span>Billing</span>
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
          <button
            onClick={() => setNewChooser(true)}
            disabled={creating || !authReady || navigatingTo === "new-niche"}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
          >
            <span className="w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
              style={{ background: "white", color: "oklch(0.55 0.15 145)" }}>
              {creating || navigatingTo === "new-niche" ? "…" : "+"}
            </span>
            <span className="hidden sm:inline">{navigatingTo === "new-niche" ? "Loading…" : creating ? "Creating…" : "New"}</span>
          </button>
        </div>
      </header>
      <div className="h-[61px] sm:h-[69px] shrink-0" aria-hidden />

      {/* Menu row. Its own bar under the header rather than a control in it,
          fixed so the toggle stays reachable while the drawer is open. */}
      {!showDemo && (
        <>
          <div className="lg:hidden fixed left-0 right-0 top-[61px] sm:top-[69px] z-50 flex items-center gap-2 px-4 sm:px-8 h-[48px]"
            style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={sidebarOpen ? "Close menu" : "Open menu"}
              aria-expanded={sidebarOpen}
              className="inline-flex items-center gap-2 py-1.5 pr-2 -ml-1 pl-1 rounded-lg text-[13px] font-medium transition-opacity hover:opacity-70 cursor-pointer"
              style={{ color: "var(--c-70)" }}
            >
              {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
              <span>{DASH_NAV.find((t) => t.id === dashTab)?.label ?? "Menu"}</span>
            </button>
          </div>
          <div className="lg:hidden h-[48px] shrink-0" aria-hidden />
        </>
      )}

      <main className="flex-1 w-full px-4 sm:px-8 pt-6 pb-4 sm:py-12 space-y-8 sm:space-y-12">

        {/* ── Demo banner for free users ──────────────────────────────── */}
        {showDemo && (() => {
          const hasStartedDemo = demoNicheCreated || demoProgress.channelDone || demoProgress.topic !== "" || demoProgress.highestStep > 0;
          return (
            <div
              className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-5 py-3 rounded-xl text-sm"
              style={{
                background: "oklch(0.72 0.25 285 / 0.08)",
                border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                color: "var(--c-65)",
              }}
            >
              <span>This dashboard is a <strong style={{ color: "var(--accent-purple-text)" }}>demo</strong>. Subscribe to populate it with your real data.</span>
              <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
                {!hasStartedDemo && (
                  <button
                    onClick={() => { setNavigatingTo("try-demo"); router.push("/demo/channel"); }}
                    disabled={navigatingTo === "try-demo"}
                    className="flex-1 sm:flex-initial px-4 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-60"
                    style={{ background: "transparent", color: "var(--c-70)", border: "1px solid oklch(0.72 0.25 285 / 0.35)" }}
                  >
                    {navigatingTo === "try-demo" ? "Loading…" : "Try Demo →"}
                  </button>
                )}
                <button
                  onClick={() => setShowSubscriptionModal(true)}
                  className="flex-1 sm:flex-initial px-4 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
                  style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.06 0 0)" }}
                >
                  Subscribe Now →
                </button>
              </div>
            </div>
          );
        })()}

        {showDemo ? (
          <DemoDashboardContent onSubscribe={() => setShowSubscriptionModal(true)} demoProgress={demoProgress} demoNicheCreated={demoNicheCreated} />
        ) : (

        /* ── Real dashboard content ─────────────────────────────────── */
        <>
        <div className="space-y-8 sm:space-y-12">
          {(() => {
          const allProjects = channelGroups.flatMap(g => g.projects);
          const total = allProjects.length;
          // Complete = final assembled MP4 exists (thumbnails don't count).
          const completed = allProjects.filter(p => !!p.assembled_url).length;
          const inProgress = allProjects.filter(p => !p.assembled_url && p.current_state > 0).length;
          const niches = channelGroups.length;

          return (
            <div className="space-y-6">
              {dashTab === "stats" && (<>
              <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginBottom: "10px" }}>General Stats</h3>
              {/* Stat cards */}
              {projects === undefined ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="rounded-xl min-h-[104px] px-5 py-4 space-y-2" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}>
                      <div className="h-8 w-10 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                      <div className="h-3 w-20 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                      <div className="h-2.5 w-14 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                    </div>
                  ))}
                </div>
              ) : (() => {
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

                // Show the original plan ratio in the card and call out the
                // override separately, so the user sees their plan honoured
                // and any admin grant on top. When the plan is unlimited
                // (admin / pro) but an override has narrowed it, fall back
                // to the override as the visible denominator so the ratio
                // isn't misleadingly "Unlimited".
                //
                // Admins are an exception: they always render as Unlimited
                // regardless of any lingering niche_limit_override in
                // account_settings (e.g. an earlier founder grant before
                // promotion). The /api/usage endpoint already ignores the
                // override for admin gating; this matches that semantic
                // in the display so the ring + denominator don't show a
                // bogus cap.
                const isAdminUsage = !!usage?.is_admin;
                const ratioDenominator = isAdminUsage
                  ? null
                  : (planDefaultLimit ?? nicheLimitOverride);
                const unlimited = ratioDenominator === null;
                const nichePct = unlimited ? 1 : Math.min(nichesUsed / ratioDenominator!, 1);
                const nicheColor = nichePct >= 1 ? "#e8745a" : "#9b7ff5";
                const showOverrideBadge = !isAdminUsage && hasOverride && planDefaultLimit !== null;
                // niches_used is a lifetime counter — deletions never
                // decrement it. The current channel-group count is the
                // live count, so the difference is how many niches have
                // been deleted. Clamp at zero for the post-renewal case
                // where reset_niches_used has zeroed the lifetime counter.
                const deletedNiches = Math.max(0, nichesUsed - niches);

                const completedPct = total > 0 ? completed / total : 0;
                const inProgressPct = total > 0 ? inProgress / total : 0;

                return (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {/* Niches Used (lifetime — deletions don't decrement) — first */}
                    {(() => {
                      const planName = isAdmin ? "Admin" : planLabel(usage?.plan);
                      // Two lines and one badge, so the card matches the
                      // height of its three neighbours. It used to carry two
                      // stacked pills beside the numbers, which wrapped below
                      // them in a 2-col mobile grid and made this card roughly
                      // twice as tall as the rest of the row.
                      return (
                        <div className="hover-lift rounded-xl transition-all min-h-[104px] px-4 sm:px-5 py-4 flex items-start justify-between gap-3"
                          style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}>
                          <div className="min-w-0">
                            <p className="leading-none">
                              <span className="text-2xl font-bold" style={{ color: "var(--c-90)" }}>{nichesUsed}</span>
                              <span className="text-xs ml-1.5" style={{ color: "var(--c-50)" }}>used</span>
                              {deletedNiches > 0 && (
                                <span className="text-xs ml-2" style={{ color: "var(--c-38)" }}>{deletedNiches} deleted</span>
                              )}
                            </p>
                            <p className="text-xs mt-2" style={{ color: "var(--c-42)" }}>
                              {unlimited ? `${planName} · Unlimited` : `of ${ratioDenominator} lifetime · ${planName}`}
                            </p>
                            {showOverrideBadge && (
                              <p className="text-[10px] mt-1 font-semibold" style={{ color: "oklch(0.6 0.18 75)" }}>
                                Override: {nicheLimitOverride}
                              </p>
                            )}
                          </div>
                          <div className="shrink-0">
                            {unlimited ? (
                              <span
                                className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap"
                                style={{
                                  background: "oklch(0.55 0.15 145 / 0.15)",
                                  color: "oklch(0.65 0.15 145)",
                                  border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                                }}
                              >
                                {planName}
                              </span>
                            ) : (
                              <PieRing id="nicheGrad" pct={nichePct} color={nicheColor}
                                centerText={`${nichesUsed}/${ratioDenominator}`} />
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Total Videos — plain */}
                    <div className="hover-lift rounded-xl transition-all min-h-[104px] px-5 py-4 flex flex-col items-center justify-center text-center"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}>
                      <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{total}</p>
                      <p className="text-xs" style={{ color: "var(--c-42)" }}>Total Videos</p>
                    </div>

                    {/* Completed */}
                    <div className="hover-lift rounded-xl transition-all min-h-[104px] px-5 py-4 flex items-center justify-between"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}>
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
                    <div className="hover-lift rounded-xl transition-all min-h-[104px] px-5 py-4 flex items-center justify-between"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}>
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
                  </div>
                );
              })()}

              <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "40px", marginBottom: "10px" }}>Niches/Video Chart</h3>
              {/* Bar chart — videos per niche */}
              {projects === undefined ? (
                <div className="rounded-2xl px-6 py-5" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}>
                  <div className="flex items-center justify-between mb-5">
                    <div className="space-y-2">
                      <div className="h-4 w-32 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                      <div className="h-3 w-16 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                    </div>
                    <div className="h-8 w-10 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                  </div>
                  <div className="flex items-end gap-4 h-24 px-4">
                    {[60, 40, 80, 30].map((h, i) => (
                      <div key={i} className="flex-1 rounded-t animate-pulse" style={{ height: `${h}%`, background: "var(--skeleton)" }} />
                    ))}
                  </div>
                </div>
              ) : channelGroups.length === 0 ? (
                <div className="rounded-2xl px-6 py-10 flex flex-col items-center justify-center text-center" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}>
                  <p className="text-sm font-medium" style={{ color: "var(--c-40)" }}>No niches yet</p>
                  <p className="text-xs mt-1" style={{ color: "var(--c-30)" }}>Create your first niche to see video counts here</p>
                </div>
              ) : (() => {
                // Ten bars fill the card; past that the chart keeps the same
                // slot width and grows wider than its container, so the extra
                // niches are reached by scrolling rather than by squeezing
                // every bar and its label down to nothing.
                const VISIBLE = 10;
                const BASE_W = 600, PAD_X = 16, PAD_T = 16;
                const points = channelGroups.map(g => ({ label: g.channelName, count: g.projects.length }));
                const maxCount = Math.max(...points.map(p => p.count), 1);
                const n = points.length;
                // viewBox and rendered width scale by the same factor, so the
                // aspect ratio holds and the chart does not get taller.
                const wideFactor = n > VISIBLE ? n / VISIBLE : 1;
                const W = Math.round(BASE_W * wideFactor);
                const plotW = W - PAD_X * 2;
                const slotW = plotW / n;
                const barW = Math.min(52, slotW * 0.6);
                const r = Math.min(5, barW / 3);

                // Label type scales with how many niches share the axis. At 10px
                // a 14-niche chart gives each label a ~40px slot, so a name like
                // "Unf*ck Everything" wraps to four stacked fragments and reads
                // as noise. Smaller type fits more characters per line, so the
                // same name wraps once or twice instead.
                const shown = Math.min(n, VISIBLE);
                const LABEL_FONT = shown <= 6 ? 10 : shown <= 9 ? 9 : 8;
                // Wrapping, line spacing and the label block's height are all
                // derived from the font size — hardcoding any of them against
                // 10px is what made the fragments overlap when the type shrank.
                const CHAR_W = LABEL_FONT * 0.58; // approx advance width for Inter
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

                const LINE_H = Math.round(LABEL_FONT * 1.3); // px between label lines
                const wrappedLabels = points.map(p => wrapLabel(p.label));
                const maxLines = Math.max(...wrappedLabels.map(l => l.length));
                const PAD_B = 8 + maxLines * LINE_H;
                const H = 140 + (maxLines - 1) * LINE_H;
                const plotH = H - PAD_T - PAD_B;

                return (
                  <div className="rounded-2xl px-4 sm:px-6 py-5" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}>
                    <div className="flex items-center justify-between mb-5">
                      <div>
                        <p className="text-sm font-semibold" style={{ color: "var(--c-75)" }}>Videos per niche</p>
                        <p className="text-xs mt-0.5" style={{ color: "var(--c-35)" }}>All time</p>
                      </div>
                      <span className="text-2xl font-bold" style={{ color: "var(--c-90)" }}>{total}</span>
                    </div>
                    <div style={{ overflowX: wideFactor > 1 ? "auto" : "clip", scrollbarWidth: "thin" }}>
                    <svg viewBox={`0 0 ${W} ${H}`} className="max-w-none" style={{ width: `${wideFactor * 100}%` }}>
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
                        style={{ stroke: "oklch(1 0 0 / 0.08)" }} strokeWidth="1" />
                      {/* Grid lines */}
                      {[0.25, 0.5, 0.75, 1].map(f => (
                        <line key={f}
                          x1={PAD_X} y1={PAD_T + plotH - f * plotH}
                          x2={W - PAD_X} y2={PAD_T + plotH - f * plotH}
                          style={{ stroke: "oklch(1 0 0 / 0.05)" }} strokeWidth="1"
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
                                    style={{ fill: "oklch(0.12 0.02 285)" }} stroke="#9b7ff5" strokeOpacity="0.4" strokeWidth="1" />
                                  <text x={TX + TW / 2} y={TY + 12} textAnchor="middle" fontSize="9.5" style={{ fill: "oklch(0.88 0 0)" }} fontWeight="500">
                                    {nicheLabel}
                                  </text>
                                  <text x={TX + TW / 2} y={TY + 24} textAnchor="middle" fontSize="10" fill="#9b7ff5" fontWeight="700">
                                    {pt.count} {pt.count === 1 ? "Video" : "Videos"}
                                  </text>
                                </g>
                              );
                            })()}
                            {/* X-axis label — word-wrapped */}
                            <text x={cx} textAnchor="middle" fontSize={LABEL_FONT}
                              style={{ fill: isEmpty ? "var(--c-25)" : hov ? "var(--brand-text)" : "var(--c-40)" }}
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
                  </div>
                );
              })()}

              </>)}

              {dashTab === "keys" && (<>
              {/* API Keys Status */}
              {(() => {
                // Shapes come from lib/key-check, so a new field there (the
                // missing-scope list, most recently) reaches this card without
                // a second declaration drifting out of step with it.
                const kie = apiStatus?.kie as KieCheck | undefined;
                const elevenlabs = apiStatus?.elevenlabs as ElevenLabsCheck | undefined;
                const anthropic = apiStatus?.anthropic as { configured: boolean; directEnabled: boolean; tokens30d?: number } | undefined;

                function StatusBadge({ data, color }: { data: { configured: boolean; valid: boolean | null } | undefined; color: string }) {
                  void color;
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

                // KIE doesn't expose a credit cap — only the live balance.
                // We render against a fixed reference so users get a visual
                // sense of how far they are from running out. Bar fills as
                // credits deplete; always green regardless of fill level.
                // Tweak REFERENCE if 1000 ends up feeling too high/low.
                function CreditsBar({ credits }: { credits: number }) {
                  // Bar fills with remaining credits, not depletion. 1000
                  // is the reference for "fully healthy" — any balance at
                  // or above caps the bar at 100%.
                  const REFERENCE = 1000;
                  const health = Math.max(0, Math.min(credits / REFERENCE, 1));
                  const barColor = "#34d399";
                  return (
                    <div>
                      <div className="flex justify-between text-[10px] mb-1" style={{ color: "var(--c-40)" }}>
                        <span>Credit health</span>
                      </div>
                      <div className="w-full rounded-full h-1.5" style={{ background: "oklch(1 0 0 / 0.08)" }}>
                        <div className="h-1.5 rounded-full transition-all" style={{ width: `${health * 100}%`, background: barColor }} />
                      </div>
                    </div>
                  );
                }

                // Same geometry as CreditsBar/UsageBar, drawn empty, for a
                // card that has a quota but cannot read it right now. Keeps
                // the row of cards visually level instead of leaving one with
                // a bare line of text where its neighbour has a bar.
                function EmptyBar({ label }: { label?: string }) {
                  return (
                    <div>
                      {label && (
                        <div className="flex justify-between text-[10px] mb-1" style={{ color: "var(--c-30)" }}>
                          <span>{label}</span>
                        </div>
                      )}
                      <div className="w-full rounded-full h-1.5" style={{ background: "oklch(1 0 0 / 0.08)" }} />
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

                const cardStyle = { background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" };

                // No top gap now that this opens its own tab rather than
                // following the chart. Three cards across on desktop: the tab
                // gives the section the full width, so a 2-col grid left the
                // third card stranded on its own row.
                if (!needsOwnKeys) return null;

                return (
                  <div>
                    <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "10px", marginBottom: "14px" }}>Your API Key Status</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

                      {/* KIE */}
                      <div className="hover-lift rounded-xl px-5 py-4 transition-all duration-200" style={cardStyle}>
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="min-w-0">
                            <p className="text-sm font-bold leading-tight" style={{ color: "var(--c-88)" }}>KIE</p>
                            {(!isPaid && !isAdmin && !isLapsed) && <p className="text-[10px] font-medium mt-1" style={{ color: "#f0a855" }}>Pending setup</p>}
                            <p className="text-[10px] mt-1.5 leading-relaxed" style={{ color: "var(--c-38)" }}>Script generation, TTS, images & video</p>
                          </div>
                          <div className="flex flex-col items-end gap-1.5 shrink-0">
                            <StatusBadge data={kie} color="#60a5fa" />
                            {kie?.configured && kie.valid && typeof kie.credits === "number" && (
                              <span className="text-[10px] font-medium tabular-nums"
                                style={{ color: kie.credits <= 0 ? "#f87171" : "var(--c-50)" }}>
                                Credits: {kie.credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                              </span>
                            )}
                          </div>
                        </div>
                        <div>
                          {kie?.configured && kie.valid && typeof kie.credits === "number" && (
                            <CreditsBar credits={kie.credits} />
                          )}
                          {kie?.configured && kie.valid && kie.credits === undefined && (
                            <>
                              <EmptyBar label="Balance unknown" />
                              <p className="text-[10px] leading-relaxed mt-2" style={{ color: "var(--c-30)" }}>Check balance in KIE dashboard</p>
                            </>
                          )}
                          {/* Same rule as ElevenLabs: a rejected key gets the
                              reason instead of a bar with nothing in it. */}
                          {kie?.configured && kie.valid === false && (
                            <p className="text-[10px] leading-relaxed" style={{ color: "#f0a855" }}>
                              KIE rejected this key. Create a new one and save it in <Link href="/setup" className="underline">Setup</Link>.
                            </p>
                          )}
                          {/* An empty card under a "Not set" badge left people
                              guessing whether something was still loading. */}
                          {kie && !kie.configured && (
                            <p className="text-[10px] leading-relaxed" style={{ color: "var(--c-30)" }}>
                              No key saved yet. Add yours in <Link href="/setup" className="underline">Setup</Link> to run scripts, images and video.
                            </p>
                          )}
                        </div>
                      </div>

                      {/* ElevenLabs. Uses UsageBar (used/limit) instead of
                          CreditsBar because ElevenLabs quota is bounded per
                          plan — we have both numerator and denominator. */}
                      <div className="hover-lift rounded-xl px-5 py-4 transition-all duration-200" style={cardStyle}>
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="min-w-0">
                            <p className="text-sm font-bold leading-tight" style={{ color: "var(--c-88)" }}>ElevenLabs</p>
                            {(!isPaid && !isAdmin && !isLapsed) && <p className="text-[10px] font-medium mt-1" style={{ color: "#f0a855" }}>Pending setup</p>}
                            <p className="text-[10px] mt-1.5 leading-relaxed" style={{ color: "var(--c-38)" }}>Voiceover generation & transcription</p>
                          </div>
                          <div className="flex flex-col items-end gap-1.5 shrink-0">
                            <StatusBadge data={elevenlabs} color="#c084fc" />
                            {elevenlabs?.configured && elevenlabs.valid && typeof elevenlabs.remaining === "number" && (
                              <span className="text-[10px] font-medium tabular-nums"
                                style={{ color: elevenlabs.remaining <= 0 ? "#f87171" : "var(--c-50)" }}>
                                {elevenlabs.remaining.toLocaleString()} chars left
                              </span>
                            )}
                          </div>
                        </div>
                        <div>
                          {elevenlabs?.configured && elevenlabs.valid && typeof elevenlabs.remaining === "number" && typeof elevenlabs.limit === "number" && (
                            <UsageBar used={elevenlabs.limit - elevenlabs.remaining} limit={elevenlabs.limit} color="#c084fc" />
                          )}
                          {/* Keep a bar in the same place when a working key's
                              quota can't be read, so the card matches KIE
                              instead of collapsing to a line of text. A
                              rejected key gets no bar: it has no quota, and an
                              empty one read as "nothing used yet" rather than
                              "this key does not work". */}
                          {elevenlabs?.configured && elevenlabs.valid === true && !(typeof elevenlabs.remaining === "number" && typeof elevenlabs.limit === "number") && (
                            <EmptyBar label="Usage" />
                          )}
                          {/* Only claim a reason when the API told us one. This
                              used to show the scope hint for any missing balance,
                              including a key that cannot authenticate at all,
                              which sent people to change permissions on a key
                              that needed replacing.

                              voices_read is named here too. A key without it
                              authenticates and synthesizes fine, so nothing
                              failed loudly: the voice picker just fell back to
                              the static list and the user's own voices were
                              missing with no explanation on any screen. */}
                          {elevenlabs?.configured && elevenlabs.valid && (elevenlabs.missingScopes?.length ?? 0) > 0 && (() => {
                            const missing = elevenlabs.missingScopes ?? [];
                            const effects = [
                              missing.includes("user_read") ? "your character balance stays hidden" : null,
                              missing.includes("voices_read") ? "your own voices are missing from the picker" : null,
                            ].filter(Boolean);
                            return (
                              <p className="text-[10px] leading-relaxed" style={{ color: "var(--c-30)" }}>
                                Enable {missing.join(" and ")} on your key. Until then {effects.join(", and ")}.
                              </p>
                            );
                          })()}
                          {/* A rejected key needs the reason, not a bar. The
                              status endpoint already distinguishes the common
                              mistake (the saved value is the key ID, which
                              ElevenLabs shows forever, while the key itself
                              appears once at creation) from a key that is
                              simply bad, so say which one it is. */}
                          {elevenlabs && !elevenlabs.configured && (
                            <p className="text-[10px] leading-relaxed" style={{ color: "var(--c-30)" }}>
                              No key saved yet. Add yours in <Link href="/setup" className="underline">Setup</Link> to generate voiceovers.
                            </p>
                          )}
                          {elevenlabs?.configured && elevenlabs.valid === false && (
                            <p className="text-[10px] leading-relaxed" style={{ color: "#f0a855" }}>
                              {elevenlabs.balanceIssue === "key_id"
                                ? <>This is the key ID, not the key. The key starts with sk_ and is shown once, when you create or rotate it. Save that value in <Link href="/setup" className="underline">Setup</Link>.</>
                                : <>ElevenLabs rejected this key. Create a new one and save it in <Link href="/setup" className="underline">Setup</Link>.</>}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Anthropic. No usage bar: Anthropic bills tokens
                          against the account and exposes no cheap remaining
                          figure, so presence and whether it is switched on is
                          all there is to show. A saved-but-off key is worth
                          calling out, since it changes nothing about who pays
                          and reads as connected otherwise. */}
                      <div className="hover-lift rounded-xl px-5 py-4 transition-all duration-200" style={cardStyle}>
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="min-w-0">
                            <p className="text-sm font-bold leading-tight" style={{ color: "var(--c-88)" }}>Anthropic</p>
                            <p className="text-[10px] mt-1.5 leading-relaxed" style={{ color: "var(--c-38)" }}>Optional. Runs the writing steps on your own account instead of through KIE</p>
                          </div>
                          <div className="flex flex-col items-end gap-1.5 shrink-0">
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
                              style={anthropic?.configured
                                ? (anthropic.directEnabled
                                  ? { background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.3)" }
                                  : { background: "oklch(0.6 0.18 75 / 0.12)", color: "oklch(0.7 0.16 75)", border: "1px solid oklch(0.6 0.18 75 / 0.3)" })
                                : { background: "oklch(1 0 0 / 0.06)", color: "var(--c-40)", border: "1px solid var(--bd-card)" }}>
                              {anthropic?.configured ? (anthropic.directEnabled ? "Active" : "Saved") : "Not set"}
                            </span>
                          </div>
                        </div>
                        <div>
                          {/* There is no quota to fill, so a bar would sit at
                              zero forever. Show what we do know instead: the
                              tokens our own ledger recorded against this
                              account over the last 30 days. */}
                          <div className="flex justify-between text-[10px]" style={{ color: "var(--c-40)" }}>
                            <span>Tokens, 30 days</span>
                            <span className="tabular-nums font-medium">
                              {typeof anthropic?.tokens30d === "number"
                                ? anthropic.tokens30d >= 1_000_000
                                  ? `${(anthropic.tokens30d / 1_000_000).toFixed(1)}M`
                                  : anthropic.tokens30d >= 1_000
                                    ? `${Math.round(anthropic.tokens30d / 1_000)}k`
                                    : anthropic.tokens30d.toLocaleString()
                                : "—"}
                            </span>
                          </div>
                          {(!anthropic?.configured || anthropic.directEnabled) && (
                            <p className="text-[10px] leading-relaxed mt-2" style={{ color: "var(--c-30)" }}>
                              {anthropic?.configured
                                ? "Writing steps bill your Anthropic account. Balance lives at console.anthropic.com."
                                : "Not connected. Writing steps run through your KIE credits."}
                            </p>
                          )}
                        </div>
                      </div>

                    </div>

                    {/* What those keys have actually spent. Same tab, because
                        "is it connected" and "what did it cost" are the two
                        questions people open this view with. */}
                    <UsageStats />
                  </div>
                );
              })()}

              </>)}

            </div>
          );
        })()}

        {/* The niche list, its loading skeleton and its empty state all belong
            to the Niches & Videos tab. Gated together so the tab is either the
            whole section or nothing. */}
        {dashTab === "niches" && (<>
        {/* One flat, filtered video list. The niche used to be a container
            with its own grid inside; it is now a filter in the sidebar, so a
            busy niche can't bury the ones under it and every row gets the
            full width. */}
        {channelGroups.length > 0 && (() => {
          const group = channelGroups.find((g) => g.channelName === nicheFilter) ?? null;
          const scoped = group ? group.projects : channelGroups.flatMap((g) => g.projects);
          // Newest first. Grouping used to impose an order; a flat list needs
          // its own, and recency is what people come back for.
          const visible = [...scoped].sort((a, b) => b.created_at.localeCompare(a.created_at));
          const nicheOf = new Map();
          // Its address too, so the niche a video belongs to can be copied
          // from the video, without going to the niche first.
          const nicheUrlOf = new Map<string, string | undefined>();
          for (const g of channelGroups) for (const pr of g.projects) {
            nicheOf.set(pr.id, g.channelName);
            nicheUrlOf.set(pr.id, g.channelUrl);
          }

          return (
            <div className="space-y-5">
              {/* Toolbar: what you are looking at, and the actions for it. */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-bold text-foreground truncate">
                    {group ? group.channelName : "All videos"}
                  </h2>
                  {group?.channelUrl ? (
                    <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                      <Link href={group.channelUrl} target="_blank" rel="noopener noreferrer"
                        className="text-xs min-w-0 truncate underline underline-offset-2 hover:opacity-80 transition-opacity"
                        style={{ color: "var(--brand-text)", textDecorationColor: "color-mix(in oklch, var(--brand-text) 60%, transparent)" }}
                        title={group.channelUrl}>
                        {group.channelUrl}
                      </Link>
                      <CopyButton text={group.channelUrl} title="Copy channel URL" />
                    </div>
                  ) : (
                    <p className="text-xs mt-0.5" style={{ color: "var(--c-38)" }}>
                      {visible.length} {visible.length === 1 ? "video" : "videos"} across {channelGroups.length} {channelGroups.length === 1 ? "niche" : "niches"}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto sm:shrink-0">
                  <div className="flex-1 sm:flex-none flex gap-0.5 p-0.5 rounded-lg" style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
                    {(["list", "cards"] as const).map((v) => (
                      <button key={v} onClick={() => selectVideoView(v)}
                        aria-label={v === "list" ? "List view" : "Card view"}
                        className="flex-1 sm:flex-none flex items-center justify-center p-1.5 sm:py-1.5 rounded-md transition-all cursor-pointer"
                        style={videoView === v
                          ? { background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)" }
                          : { background: "transparent", color: "var(--c-45)" }}>
                        {v === "list" ? <List size={14} /> : <LayoutGrid size={14} />}
                      </button>
                    ))}
                  </div>
                  {group && (
                    <button
                      onClick={() => setDeleteTarget({ type: "niche", channelName: group.channelName, projectIds: group.projects.map((pr) => pr.id), count: group.projects.length })}
                      className="p-2 rounded-lg transition-all hover:opacity-90 shrink-0"
                      style={{ color: "var(--c-55)", border: "1px solid var(--bd-7)" }}
                      title="Delete niche"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => group ? createVideoForChannel(group) : createProject()}
                    disabled={creating || !authReady || navigatingTo === `new-video-${group?.channelName ?? ""}` || navigatingTo === "new-niche"}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-2.5 sm:py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
                  >
                    {group
                      ? (navigatingTo === `new-video-${group.channelName}` ? "Loading…" : "+ New Video")
                      : (navigatingTo === "new-niche" ? "Loading…" : "+ New Niche")}
                  </button>
                </div>
              </div>

              {videoView === "list" ? (
                <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid var(--bd-card)" }}>
                  {visible.map((pr, i) => {
                    const assembled = !!pr.assembled_url;
                    const path = assembled ? "thumbnails"
                      : (pr.current_state === 6 && pr.selected_topic) ? "script"
                      : (PHASE_PATHS[pr.current_state] ?? "channel");
                    const stateLabel = assembled ? "Complete"
                      : (pr.current_state === 6 && pr.selected_topic) ? "Script"
                      : (PHASE_LABELS[pr.current_state] ?? "Setup");
                    const progress = assembled ? 100 : Math.round(((PHASE_RANK[path] ?? 0) + 1) / 8 * 100);
                    const isNavigating = navigatingTo === `open-video-${pr.id}`;
                    return (
                      <Link
                        key={pr.id}
                        href={(pr.auto_pilot && !assembled && pr.auto_pilot_status !== "stopped") ? `/projects/${pr.id}/one-click` : `/projects/${pr.id}/${path}`}
                        prefetch
                        onClick={() => setNavigatingTo(`open-video-${pr.id}`)}
                        className={`relative flex items-center gap-3 px-4 py-3 transition-all ${isNavigating ? "pointer-events-none" : ""}`}
                        style={{
                          background: "oklch(1 0 0 / 0.04)",
                          borderTop: i === 0 ? "none" : "1px solid var(--bd-6)",
                        }}
                        onMouseEnter={(e) => { if (!isNavigating) (e.currentTarget as HTMLElement).style.background = "oklch(1 0 0 / 0.08)"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "oklch(1 0 0 / 0.04)"; }}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-semibold leading-snug truncate"
                            style={{ color: pr.selected_topic ? "var(--c-88)" : "var(--c-40)" }}>
                            {pr.selected_topic ?? "No topic selected"}
                          </p>
                          <div className="flex items-center gap-2 mt-1 text-[11px]" style={{ color: "var(--c-38)" }}>
                            {/* The niche column is redundant once one is selected. */}
                            {!group && <span className="truncate max-w-[40%]">{nicheOf.get(pr.id)}</span>}
                            {!group && nicheUrlOf.get(pr.id) && (
                              <CopyButton text={nicheUrlOf.get(pr.id)!} title="Copy channel URL" size={11} style={{ color: "var(--c-38)" }} />
                            )}
                            {!group && <span aria-hidden>·</span>}
                            <span>{timeAgo(pr.created_at)}</span>
                          </div>
                        </div>

                        <div className="hidden sm:flex items-center gap-2 w-[120px] shrink-0">
                          <div className="h-1 flex-1 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                            <div className="h-full rounded-full"
                              style={{ width: `${progress}%`, background: assembled ? "oklch(0.55 0.15 145)" : "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))" }} />
                          </div>
                          <span className="text-[11px] tabular-nums shrink-0" style={{ color: "var(--c-38)" }}>{progress}%</span>
                        </div>

                        <span className="text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0"
                          style={assembled ? {
                            background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                          } : {
                            background: "oklch(0.72 0.25 285 / 0.1)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                          }}>
                          {stateLabel}
                        </span>

                        <div className="flex items-center gap-1 shrink-0">
                          {assembled && pr.assembled_url && (
                            <button
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); downloadVideo(pr.id, pr.assembled_url!, pr.selected_topic ?? "video"); }}
                              disabled={downloadingId === pr.id}
                              className="p-1.5 rounded-lg transition-all hover:opacity-90 disabled:opacity-50"
                              style={{ color: "oklch(0.65 0.15 145)" }}
                              title="Download video"
                            >
                              {downloadingId === pr.id
                                ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
                                : <Download size={13} />}
                            </button>
                          )}
                          <button
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteTarget({ type: "video", id: pr.id, label: pr.selected_topic ?? "this video" }); }}
                            className="p-1.5 rounded-lg transition-all hover:opacity-90"
                            style={{ color: "var(--c-55)" }}
                            title="Delete video"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>

                        {isNavigating && (
                          <div className="absolute inset-0 flex items-center justify-center gap-2"
                            style={{ background: "oklch(0.06 0 0 / 0.55)", backdropFilter: "blur(2px)" }}>
                            <Spinner size={14} />
                            <span className="text-[11px] font-medium" style={{ color: "var(--c-90)" }}>Opening…</span>
                          </div>
                        )}
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))" }}>
                  {visible.map((pr) => {
                    const assembled = !!pr.assembled_url;
                    const path = assembled ? "thumbnails"
                      : (pr.current_state === 6 && pr.selected_topic) ? "script"
                      : (PHASE_PATHS[pr.current_state] ?? "channel");
                    const stateLabel = assembled ? "Complete"
                      : (pr.current_state === 6 && pr.selected_topic) ? "Script"
                      : (PHASE_LABELS[pr.current_state] ?? "Setup");
                    const progress = assembled ? 100 : Math.round(((PHASE_RANK[path] ?? 0) + 1) / 8 * 100);
                    const isNavigating = navigatingTo === `open-video-${pr.id}`;
                    return (
                      <Link
                        key={pr.id}
                        href={(pr.auto_pilot && !assembled && pr.auto_pilot_status !== "stopped") ? `/projects/${pr.id}/one-click` : `/projects/${pr.id}/${path}`}
                        prefetch
                        onClick={() => setNavigatingTo(`open-video-${pr.id}`)}
                        className={`block relative text-left p-5 rounded-2xl transition-all ${isNavigating ? "pointer-events-none" : "hover:scale-[1.01] active:scale-[0.99]"}`}
                        style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}
                        onMouseEnter={(e) => { if (!isNavigating) (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.35)"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-card)"; }}
                      >
                        <div className="flex items-start justify-between mb-3 gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-xs px-2.5 py-0.5 rounded-full font-medium shrink-0"
                              style={assembled ? {
                                background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                              } : {
                                background: "oklch(0.72 0.25 285 / 0.1)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                              }}>
                              {stateLabel}
                            </span>
                            {assembled && pr.assembled_url && <VideoDurationBadge src={pr.assembled_url} />}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-xs" style={{ color: "var(--c-38)" }}>{timeAgo(pr.created_at)}</span>
                            {assembled && pr.assembled_url && (
                              <button
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); downloadVideo(pr.id, pr.assembled_url!, pr.selected_topic ?? "video"); }}
                                disabled={downloadingId === pr.id}
                                className="p-1 rounded-lg transition-all hover:opacity-90 disabled:opacity-50"
                                style={{ color: "oklch(0.65 0.15 145)" }}
                                title="Download video"
                              >
                                {downloadingId === pr.id
                                  ? <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
                                  : <Download size={13} />}
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteTarget({ type: "video", id: pr.id, label: pr.selected_topic ?? "this video" }); }}
                              className="p-1 rounded-lg transition-all hover:opacity-90"
                              style={{ color: "var(--c-55)" }}
                              title="Delete video"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>

                        <p className="text-[13px] sm:text-[15px] font-semibold leading-snug mb-2"
                          style={{ color: pr.selected_topic ? "var(--c-88)" : "var(--c-40)" }}>
                          {pr.selected_topic ?? "No topic selected"}
                        </p>
                        {!group && (
                          <div className="flex items-center gap-1.5 mb-4 min-w-0">
                            <span className="text-[11px] truncate" style={{ color: "var(--c-38)" }}>{nicheOf.get(pr.id)}</span>
                            {nicheUrlOf.get(pr.id) && (
                              <CopyButton text={nicheUrlOf.get(pr.id)!} title="Copy channel URL" size={12} style={{ color: "var(--c-38)" }} />
                            )}
                          </div>
                        )}

                        {pr.auto_pilot && !assembled && !ONE_CLICK_HIDDEN && (
                          <div className="mb-4">
                            <OneClickControls
                              projectId={pr.id}
                              status={pr.auto_pilot_status ?? null}
                              error={pr.auto_pilot_error ?? null}
                              onChanged={() => mutateProjects()}
                            />
                          </div>
                        )}

                        <div className="space-y-1.5">
                          <div className="flex justify-between text-xs" style={{ color: "var(--c-38)" }}>
                            <span>Progress</span>
                            <span>{progress}%</span>
                          </div>
                          <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                            <div className="h-full rounded-full transition-all"
                              style={{ width: `${progress}%`, background: assembled ? "oklch(0.55 0.15 145)" : "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))" }} />
                          </div>
                        </div>

                        {isNavigating && (
                          <div className="absolute inset-0 flex items-center justify-center gap-2 rounded-2xl"
                            style={{ background: "oklch(0.06 0 0 / 0.55)", backdropFilter: "blur(2px)" }}>
                            <Spinner size={16} />
                            <span className="text-xs font-medium" style={{ color: "var(--c-90)" }}>Opening…</span>
                          </div>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {/* Loading skeleton */}
        {projects === undefined && (
          <div className="space-y-12">
            {[0, 1].map((g) => (
              <div key={g}>
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-11 h-11 rounded-xl animate-pulse" style={{ background: "var(--skeleton)" }} />
                  <div className="space-y-2">
                    <div className="h-4 w-36 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                    <div className="h-3 w-52 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                  </div>
                </div>
                <div className="grid gap-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))" }}>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="p-6 rounded-2xl space-y-4"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" }}>
                      <div className="flex items-start justify-between">
                        <div className="h-5 w-20 rounded-full animate-pulse" style={{ background: "var(--skeleton)" }} />
                        <div className="h-4 w-14 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                      </div>
                      <div className="h-6 w-4/5 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <div className="h-3 w-14 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                          <div className="h-3 w-8 rounded animate-pulse" style={{ background: "var(--skeleton)" }} />
                        </div>
                        <div className="h-1 w-full rounded-full animate-pulse" style={{ background: "var(--skeleton)" }} />
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
              disabled={creating || !authReady}
              className="w-16 h-16 rounded-2xl flex items-center justify-center transition-all hover:scale-105 active:scale-95 disabled:opacity-50 cursor-pointer"
              style={{
                background: "oklch(0.72 0.25 285 / 0.08)",
                border: "1px dashed oklch(0.72 0.25 285 / 0.35)",
                color: "var(--brand-text)",
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
            <div className="flex flex-col items-center gap-3">
              {(!isPaid && !isAdmin && !isLapsed) && (
                <button
                  onClick={() => router.push("/demo/channel")}
                  className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 cursor-pointer"
                  style={{ background: "oklch(1 0 0 / 0.08)", color: "var(--c-70)", border: "1px solid var(--bd-10)" }}
                >
                  Try Demo →
                </button>
              )}
              <button
                onClick={createProject}
                disabled={creating || !authReady || navigatingTo === "new-niche"}
                className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
              >
                {navigatingTo === "new-niche" ? "Loading…" : creating ? "Creating…" : isPaid || isAdmin ? "New Project →" : isLapsed ? "Renew to continue →" : "Subscribe & Start →"}
              </button>
            </div>
          </div>
        )}
        </>)}
        </div>
        </>
        )}

      </main>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {deleteTarget?.type === "niche" ? "Delete Niche" : "Delete Video"}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.type === "niche"
                ? `This will permanently delete the "${deleteTarget.channelName}" niche and all ${deleteTarget.count} video${deleteTarget.count === 1 ? "" : "s"} inside it, including all generated assets. This action cannot be undone.`
                : `This will permanently delete "${deleteTarget?.label}" and all its generated assets. This action cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
            <button
              onClick={confirmDelete}
              disabled={deleting}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.5 0.22 25)", color: "white" }}
            >
              {deleting ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Deleting…
                </span>
              ) : "Delete"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Header "New": niche or video, then which niche the video belongs to.
          Two views in one dialog so Back doesn't close and reopen it. */}
      <Dialog
        open={newChooser}
        onOpenChange={(open) => { if (!open) { setNewChooser(false); setPickNicheForVideo(false); } }}
      >
        <DialogContent className="sm:max-w-md p-6 gap-5 bg-[var(--bg-panel)] text-[var(--c-90)] ring-[var(--bd-card)]">
          {!pickNicheForVideo ? (
            <>
              <DialogHeader>
                <DialogTitle>What are you making?</DialogTitle>
                <DialogDescription className="text-[var(--c-55)]">
                  A niche holds a channel&apos;s style; videos are made inside one.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 mt-2">
                <button
                  onClick={() => { setNewChooser(false); createProject(); }}
                  className="group flex items-center gap-3.5 p-4 rounded-xl border border-[var(--bd-card)] text-left transition-all hover:bg-[var(--bg-progress)]"
                >
                  <span className="w-10 h-10 shrink-0 rounded-xl bg-[var(--bg-progress)] flex items-center justify-center">
                    <Wand2 size={18} className="text-[var(--c-70)]" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-[var(--c-90)]">Add new niche</span>
                    <span className="block text-xs text-[var(--c-55)]">Analyse a channel and build its style.</span>
                  </span>
                  <ChevronRight size={16} className="text-[var(--c-45)] group-hover:text-[var(--c-70)]" />
                </button>
                {/* Disabled with a reason rather than hidden: a first-time user
                    should see that videos exist and what unlocks them. */}
                <button
                  onClick={() => {
                    if (channelGroups.length === 0) return;
                    // Only one niche: nothing to choose, go straight in.
                    if (channelGroups.length === 1) {
                      setNewChooser(false);
                      createVideoForChannel(channelGroups[0]);
                      return;
                    }
                    setPickNicheForVideo(true);
                  }}
                  disabled={channelGroups.length === 0}
                  className="group flex items-center gap-3.5 p-4 rounded-xl border border-[var(--bd-card)] text-left transition-all hover:bg-[var(--bg-progress)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                  <span className="w-10 h-10 shrink-0 rounded-xl bg-[var(--bg-progress)] flex items-center justify-center">
                    <Clapperboard size={18} className="text-[var(--c-70)]" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-[var(--c-90)]">Create new video</span>
                    <span className="block text-xs text-[var(--c-55)]">
                      {channelGroups.length === 0
                        ? "Add a niche first — a video reuses its channel analysis."
                        : "Add a new video to an existing niche."}
                    </span>
                  </span>
                  {channelGroups.length > 0 && <ChevronRight size={16} className="text-[var(--c-45)] group-hover:text-[var(--c-70)]" />}
                </button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Which niche?</DialogTitle>
                <DialogDescription className="text-[var(--c-55)]">
                  The new video inherits this niche&apos;s channel analysis and visual style.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2.5 mt-2 max-h-[46vh] overflow-y-auto pr-0.5">
                {channelGroups.map((g) => (
                  <button
                    key={g.channelName}
                    onClick={() => { setNewChooser(false); setPickNicheForVideo(false); createVideoForChannel(g); }}
                    className="group flex items-center gap-3.5 p-3.5 rounded-xl border border-[var(--bd-card)] text-left transition-all hover:bg-[var(--bg-progress)]"
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-[var(--c-90)] truncate">{g.channelName}</span>
                      <span className="block text-xs text-[var(--c-55)]">
                        {g.projects.length} video{g.projects.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    <ChevronRight size={16} className="text-[var(--c-45)] group-hover:text-[var(--c-70)]" />
                  </button>
                ))}
              </div>
              <button
                onClick={() => setPickNicheForVideo(false)}
                className="w-full py-2 rounded-xl text-sm font-medium text-[var(--c-55)] hover:text-[var(--c-90)] transition-colors"
              >
                Back
              </button>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* New Video: Studio vs 1Click chooser */}
      <Dialog
        open={!!newVideoGroup || newNicheChooser}
        onOpenChange={(open) => { if (!open && !startingOneClick) { setNewVideoGroup(null); setNewNicheChooser(false); setOneClickNeedsSetup(false); } }}
      >
        {/* Themed rather than the default white sheet: this chooser sits
            directly on the dashboard chrome, so it uses the same app theme
            tokens. dialog.tsx supports exactly this via className. The
            tokens are theme-aware, so it follows light mode too. */}
        <DialogContent
          className="sm:max-w-sm bg-[var(--bg-panel)] text-[var(--c-90)] ring-[var(--bd-card)]"
          showCloseButton={!startingOneClick}
        >
          {oneClickNeedsSetup ? (
            <>
              <DialogHeader>
                <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-1 mx-auto" style={{ background: "oklch(0.72 0.25 285 / 0.12)" }}>
                  <Wand2 size={20} style={{ color: "oklch(0.55 0.22 285)" }} />
                </div>
                <DialogTitle className="text-center">It&apos;s your first time with 1Click, let&apos;s set you up first</DialogTitle>
              </DialogHeader>
              <div className="grid gap-2 mt-1">
                <button
                  onClick={() => {
                    // Continue the flow the user was in, so setup finishes
                    // into the thing they were trying to start.
                    if (newNicheChooser) {
                      setNewNicheChooser(false);
                      router.push("/one-click?new=1");
                      return;
                    }
                    const src = newVideoGroup
                      ? [...newVideoGroup.projects].sort((a, b) => b.current_state - a.current_state)[0]
                      : null;
                    router.push(src ? `/one-click?from=${encodeURIComponent(src.id)}` : "/one-click");
                  }}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                  style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
                >
                  Set up 1Click
                </button>
                <button
                  onClick={() => setOneClickNeedsSetup(false)}
                  className="w-full py-2.5 rounded-xl text-sm font-medium text-[var(--c-55)] hover:text-[var(--c-90)] transition-colors"
                >
                  Back
                </button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{newNicheChooser ? "New niche" : "New video"}</DialogTitle>
                <DialogDescription className="text-[var(--c-55)]">Choose how to create it.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-2.5 mt-1">
                <button
                  onClick={() => {
                    if (newNicheChooser) { doCreateProject("studio"); return; }
                    const g = newVideoGroup; setNewVideoGroup(null); if (g) doCreateVideoForChannel(g);
                  }}
                  disabled={startingOneClick}
                  className="group flex items-center gap-3 p-3.5 rounded-xl border border-[var(--bd-card)] text-left transition-all hover:bg-[var(--bg-progress)] disabled:opacity-50"
                >
                  <span className="w-9 h-9 shrink-0 rounded-lg bg-[var(--bg-progress)] flex items-center justify-center">
                    <SlidersHorizontal size={17} className="text-[var(--c-70)]" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-[var(--c-90)]">Studio</span>
                    <span className="block text-xs text-[var(--c-55)]">Build it yourself, step by step.</span>
                  </span>
                  <ChevronRight size={16} className="text-[var(--c-45)] group-hover:text-[var(--c-70)]" />
                </button>
                <button
                  onClick={() => {
                    // New niche: the channel step owns the 1Click kickoff (it
                    // needs a channel URL first). Existing niche: fork and
                    // engage right away.
                    if (newNicheChooser) { doCreateProject("oneclick"); return; }
                    if (newVideoGroup) doOneClickVideoForChannel(newVideoGroup);
                  }}
                  disabled={startingOneClick}
                  className="group flex items-center gap-3 p-3.5 rounded-xl border text-left transition-all hover:opacity-95 disabled:opacity-60"
                  style={{ borderColor: "oklch(0.72 0.25 285 / 0.4)", background: "oklch(0.72 0.25 285 / 0.06)" }}
                >
                  <span className="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center" style={{ background: "oklch(0.72 0.25 285 / 0.15)" }}>
                    {startingOneClick
                      ? <span className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: "oklch(0.55 0.22 285 / 0.4)", borderTopColor: "oklch(0.55 0.22 285)" }} />
                      : <Wand2 size={17} style={{ color: "oklch(0.55 0.22 285)" }} />}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-[var(--c-90)]">{startingOneClick ? "Starting 1Click…" : "1Click"}</span>
                    <span className="block text-xs text-[var(--c-55)]">Hands-off. We make the whole video.</span>
                  </span>
                  {!startingOneClick && <ChevronRight size={16} style={{ color: "color-mix(in oklch, var(--brand-text) 60%, transparent)" }} />}
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {showSubscriptionModal && (
        <SubscriptionModal
          email={userEmail}
          defaultPlan={selectedPlan}
          hideTryDemo={demoNicheCreated || demoProgress.channelDone || demoProgress.topic !== "" || demoProgress.highestStep > 0}
          onClose={() => { setShowSubscriptionModal(false); setPendingAction(null); }}
          onSuccess={handleSubscriptionSuccess}
        />
      )}

      {showNicheLimitModal && nicheLimit !== null && (
        <NicheLimitModal
          email={userEmail}
          currentPlan={usage?.plan ?? "starter"}
          nichesUsed={nichesUsed}
          nicheLimit={nicheLimit}
          onClose={() => setShowNicheLimitModal(false)}
          onSuccess={handleSubscriptionSuccess}
        />
      )}

      {showApiKeysModal && (
        <ApiKeysRequiredModal onClose={() => setShowApiKeysModal(false)} />
      )}
      {/* Once, for accounts still on their own keys. */}
      {!showDemo && (
        <CreditsAnnouncement />
      )}

    </div>
  );
}
