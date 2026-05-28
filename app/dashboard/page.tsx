"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import { Settings, LogOut, BarChart3 } from "lucide-react";
import useSWR from "swr";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SubscriptionModal } from "@/components/SubscriptionModal";
import { DEMO_DATA } from "@/lib/demo-data";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

// ── Demo dashboard helpers ────────────────────────────────────────────────────

const DEMO_STEP_LABELS = ["Channel", "Topic", "Script", "Visuals", "Prompts", "Generate", "Assemble", "Complete"];
const DEMO_STEP_HREFS  = [
  "/demo/channel", "/demo/topic", "/demo/script", "/demo/visuals",
  "/demo/prompts", "/demo/generate", "/demo/assemble", "/demo/thumbnails",
];
const DEMO_DEFAULT_TOPIC = "5 Money Habits That Are Making You Poorer";

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

  const hasStartedDemo = demoNicheCreated || demoProgress.topic !== "" || demoProgress.highestStep > 0;

  const step       = Math.min(demoProgress.highestStep, 7);
  const isComplete = step === 7;
  const progress   = Math.round(((step + 1) / 8) * 100);
  const stateLabel = DEMO_STEP_LABELS[step];
  const href       = DEMO_STEP_HREFS[step];
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

  const cardStyle = { background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" };

  const W = 600, PAD_X = 16, PAD_T = 16, PAD_B = 32, H = 160;
  const plotH = H - PAD_T - PAD_B;
  const barW = 52, rx = 5;
  const bars = [
    { label: "FinanceFuel", count: 1 },
  ];
  const maxCount = 1;
  const plotW = W - PAD_X * 2;
  const slotW = plotW / bars.length;

  return (
    <div className="space-y-12">
      <div className="space-y-6">
        <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginBottom: "10px" }}>General Stats</h3>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-xl px-5 py-4" style={cardStyle}>
            <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{total}</p>
            <p className="text-xs" style={{ color: "var(--c-42)" }}>Total Videos</p>
          </div>
          <div className="rounded-xl px-5 py-4 flex items-center justify-between" style={cardStyle}>
            <div>
              <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{completed}</p>
              <p className="text-xs" style={{ color: "var(--c-42)" }}>Completed</p>
              <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>{Math.round((completed / total) * 100)}% of total</p>
            </div>
            <DemoPieRing id="dcComp" pct={completed / total} color="#5bc48a" centerText={`${Math.round((completed / total) * 100)}%`} />
          </div>
          <div className="rounded-xl px-5 py-4 flex items-center justify-between" style={cardStyle}>
            <div>
              <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{inProg}</p>
              <p className="text-xs" style={{ color: "var(--c-42)" }}>In Progress</p>
              <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>{Math.round((inProg / total) * 100)}% of total</p>
            </div>
            <DemoPieRing id="dcProg" pct={inProg / total} color="#f0a855" centerText={`${Math.round((inProg / total) * 100)}%`} />
          </div>
          <div className="rounded-xl px-5 py-4 flex items-center justify-between" style={cardStyle}>
            <div>
              <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{niches}</p>
              <p className="text-xs" style={{ color: "var(--c-42)" }}>Niches</p>
              <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>of {nicheLimit}</p>
            </div>
            <DemoPieRing id="dcNiche" pct={niches / nicheLimit} color="#5bc48a" centerText={`${niches}/${nicheLimit}`} />
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
                    style={{ fill: "oklch(1 0 0 / 0.30)" }}>{bar.label}</text>
                </g>
              );
            })}
          </svg>
          </div>
        </div>
        )}

        <div style={{ marginTop: "40px" }}>
          <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "10px", marginBottom: "10px" }}>Your API Keys Status</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {[
              { name: "Anthropic",   color: "#c084fc", desc: "Claude AI — scripts & analysis" },
              { name: "KIE",         color: "#60a5fa", desc: "TTS, images & video generation" },
              { name: "ElevenLabs",  color: "#34d399", desc: "Voiceover & captions" },
            ].map(({ name, color, desc }) => (
              <div key={name} className="rounded-xl px-5 py-4" style={cardStyle}>
                <div className="flex items-center justify-between mb-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: color }} />
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "#94a3b822", color: "#94a3b8" }}>Not set</span>
                </div>
                <p className="text-sm font-bold mb-0.5" style={{ color: "var(--c-88)" }}>{name}</p>
                <p className="text-[10px] font-medium mb-2" style={{ color: "#f0a855" }}>Pending setup</p>
                <p className="text-[10px]" style={{ color: "var(--c-38)" }}>{desc}</p>
              </div>
            ))}
          </div>
        </div>

        <h2 className="text-xl font-bold tracking-tight" style={{ color: "var(--c-85)", marginTop: "60px" }}>Your Niches & Videos</h2>
      </div>

      {!hasStartedDemo ? (
        <div className="rounded-2xl px-6 py-16 flex flex-col items-center justify-center text-center" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}>
          <p className="text-sm font-medium mb-1" style={{ color: "var(--c-45)" }}>No niches yet</p>
          <p className="text-xs mb-6" style={{ color: "var(--c-30)" }}>Try the demo to see how a niche looks, or subscribe to create your first one.</p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/demo/channel")}
              className="px-4 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 cursor-pointer"
              style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-8)", color: "var(--c-60)" }}
            >
              Try demo →
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
      {/* FinanceFuel channel group */}
      <div>
        <div className="rounded-2xl px-4 sm:px-6 py-6 sm:py-8" style={cardStyle}>
          <div className="flex items-center justify-between gap-3 mb-5">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center text-base font-bold shrink-0"
                style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
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
              onClick={() => router.push(href)}
              className="text-left p-4 sm:p-6 rounded-2xl transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
              style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.35)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-7)"; }}
            >
              <div className="flex items-start justify-between mb-3">
                <span className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                  style={isComplete ? {
                    background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                  } : {
                    background: "oklch(0.72 0.25 285 / 0.1)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                  }}>
                  {stateLabel}
                </span>
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
        <div className="rounded-2xl px-4 sm:px-6 py-6 sm:py-8" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}>
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
                style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}
              >
                <div className="flex items-start justify-between mb-3">
                  <span className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                    style={{ background: "oklch(0.3 0 0 / 0.3)", color: "oklch(0.45 0 0)", border: "1px solid oklch(0.3 0 0 / 0.2)" }}>
                    {v.state}
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

export default function HomePage() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPaid, setIsPaid] = useState<boolean | null>(null);
  const [demoProgress, setDemoProgress] = useState<DemoProgress>({ topic: "", highestStep: 0, channelDone: false });
  const [demoNicheCreated, setDemoNicheCreated] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
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
  const { data: projects } = useSWR<Project[]>("/api/projects", fetcher);

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

  function doCreateProject() {
    router.push("/projects/new/channel");
  }

  function createProject() {
    if (atNicheLimit) { setShowSubscriptionModal(true); return; }
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
  // Show demo data to users who are not yet subscribed (once auth is resolved)
  const showDemo = isPaid === false && !isAdmin;

  return (
    <div className="min-h-screen flex flex-col overflow-x-hidden" style={{ background: "var(--bg-page)" }}>
      {/* Header */}
      <header className="flex items-center justify-between px-4 sm:px-8 py-3 sm:py-4 sticky top-0 z-10"
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
                          style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
                          {isPaid ? userPlan : "Free"} plan →
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
                        <span>Setup</span>
                      </Link>
                    ) : (
                      <button
                        onClick={() => { setShowProfileMenu(false); setShowSubscriptionModal(true); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80 cursor-pointer"
                        style={{ color: "var(--c-60)" }}
                      >
                        <Settings size={15} />
                        <span>Setup</span>
                      </button>
                    )}
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
            onClick={createProject}
            disabled={creating || !authReady}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
          >
            <span className="w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
              style={{ background: "white", color: "oklch(0.55 0.15 145)" }}>
              {creating ? "…" : "+"}
            </span>
            <span className="hidden sm:inline">{creating ? "Creating…" : "Niche"}</span>
          </button>
        </div>
      </header>

      <main className="flex-1 w-full px-4 sm:px-8 lg:px-24 py-6 sm:py-12 space-y-8 sm:space-y-12">

        {/* ── Demo banner for free users ──────────────────────────────── */}
        {showDemo && (
          <div
            className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-5 py-3 rounded-xl text-sm"
            style={{
              background: "oklch(0.72 0.25 285 / 0.08)",
              border: "1px solid oklch(0.72 0.25 285 / 0.2)",
              color: "var(--c-65)",
            }}
          >
            <span>This dashboard is a <strong style={{ color: "oklch(0.85 0.12 285)" }}>demo</strong> — subscribe to populate it with your real data.</span>
            <button
              onClick={() => setShowSubscriptionModal(true)}
              className="shrink-0 w-full sm:w-auto px-4 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
              style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.06 0 0)" }}
            >
              Subscribe Now →
            </button>
          </div>
        )}

        {showDemo ? (
          <DemoDashboardContent onSubscribe={() => setShowSubscriptionModal(true)} demoProgress={demoProgress} demoNicheCreated={demoNicheCreated} />
        ) : (

        /* ── Real dashboard content ─────────────────────────────────── */
        <>{(() => {
          const allProjects = channelGroups.flatMap(g => g.projects);
          const total = allProjects.length;
          const completed = allProjects.filter(p => p.assembly_status === "done").length;
          const inProgress = allProjects.filter(p => p.assembly_status !== "done" && p.current_state > 0).length;
          const niches = channelGroups.length;

          return (
            <div className="space-y-6">
              <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "10px", marginBottom: "10px" }}>General Stats</h3>
              {/* Stat cards */}
              {projects === undefined ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="rounded-xl px-5 py-4 space-y-2" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}>
                      <div className="h-8 w-10 rounded animate-pulse" style={{ background: "oklch(1 0 0 / 0.08)" }} />
                      <div className="h-3 w-20 rounded animate-pulse" style={{ background: "oklch(1 0 0 / 0.06)" }} />
                      <div className="h-2.5 w-14 rounded animate-pulse" style={{ background: "oklch(1 0 0 / 0.05)" }} />
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

                const PLAN_LIMITS: Record<string, number | null> = { founder: 20, starter: 5, pro: null };
                const nicheLimit = isAdmin ? null : (PLAN_LIMITS[userPlan] ?? 5);
                const unlimited = nicheLimit === null;
                const nichePct = unlimited ? 1 : Math.min(niches / nicheLimit!, 1);
                const nicheColor = nichePct >= 1 ? "#e8745a" : "#9b7ff5";

                const completedPct = total > 0 ? completed / total : 0;
                const inProgressPct = total > 0 ? inProgress / total : 0;

                return (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {/* Total Videos — plain */}
                    <div className="rounded-xl px-5 py-4"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}>
                      <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{total}</p>
                      <p className="text-xs" style={{ color: "var(--c-42)" }}>Total Videos</p>
                    </div>

                    {/* Completed */}
                    <div className="rounded-xl px-5 py-4 flex items-center justify-between"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}>
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
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}>
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
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}>
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
              {projects === undefined ? (
                <div className="rounded-2xl px-6 py-5" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}>
                  <div className="flex items-center justify-between mb-5">
                    <div className="space-y-2">
                      <div className="h-4 w-32 rounded animate-pulse" style={{ background: "oklch(1 0 0 / 0.08)" }} />
                      <div className="h-3 w-16 rounded animate-pulse" style={{ background: "oklch(1 0 0 / 0.06)" }} />
                    </div>
                    <div className="h-8 w-10 rounded animate-pulse" style={{ background: "oklch(1 0 0 / 0.08)" }} />
                  </div>
                  <div className="flex items-end gap-4 h-24 px-4">
                    {[60, 40, 80, 30].map((h, i) => (
                      <div key={i} className="flex-1 rounded-t animate-pulse" style={{ height: `${h}%`, background: "oklch(1 0 0 / 0.08)" }} />
                    ))}
                  </div>
                </div>
              ) : channelGroups.length === 0 ? (
                <div className="rounded-2xl px-6 py-10 flex flex-col items-center justify-center text-center" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}>
                  <p className="text-sm font-medium" style={{ color: "var(--c-40)" }}>No niches yet</p>
                  <p className="text-xs mt-1" style={{ color: "var(--c-30)" }}>Create your first niche to see video counts here</p>
                </div>
              ) : (() => {
                const W = 600, PAD_X = 16, PAD_T = 16;
                const points = channelGroups.map(g => ({ label: g.channelName, count: g.projects.length }));
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
                  <div className="rounded-2xl px-4 sm:px-6 py-5" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}>
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
                                  <text x={TX + TW / 2} y={TY + 12} textAnchor="middle" fontSize="9.5" style={{ fill: "oklch(1 0 0 / 0.70)" }} fontWeight="500">
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
                              style={{ fill: isEmpty ? "oklch(1 0 0 / 0.12)" : hov ? "#9b7ff5" : "oklch(1 0 0 / 0.30)" }}
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

              {/* API Keys Status */}
              {(() => {
                const el    = apiStatus?.elevenlabs as { configured: boolean; valid: boolean | null; charUsed?: number; charLimit?: number; tier?: string } | undefined;
                const kie   = apiStatus?.kie        as { configured: boolean; valid: boolean | null; credits?: number } | undefined;
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

                const cardStyle = { background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" };

                return (
                  <div style={{ marginTop: "40px" }}>
                    <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "10px", marginBottom: "10px" }}>Your API Keys Status</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">

                      {/* Anthropic */}
                      <div className="rounded-xl px-5 py-4" style={cardStyle}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="w-2 h-2 rounded-full" style={{ background: "#c084fc" }} />
                          <StatusBadge data={anth} color="#c084fc" />
                        </div>
                        <p className="text-sm font-bold mb-0.5" style={{ color: "var(--c-88)" }}>Anthropic</p>
                        {(!isPaid && !isAdmin) && <p className="text-[10px] font-medium mb-1" style={{ color: "#f0a855" }}>Pending setup</p>}
                        <p className="text-[10px] mb-3" style={{ color: "var(--c-38)" }}>Claude AI — scripts & analysis</p>
                        <StaticInfo label="Billing" value="Pay-per-token" color="#c084fc" />
                        <p className="text-[10px] mt-0.5" style={{ color: "var(--c-30)" }}>No credit pool — billed by usage</p>
                      </div>

                      {/* KIE */}
                      <div className="rounded-xl px-5 py-4" style={cardStyle}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="w-2 h-2 rounded-full" style={{ background: "#60a5fa" }} />
                          <StatusBadge data={kie} color="#60a5fa" />
                        </div>
                        <p className="text-sm font-bold mb-0.5" style={{ color: "var(--c-88)" }}>KIE</p>
                        {(!isPaid && !isAdmin) && <p className="text-[10px] font-medium mb-1" style={{ color: "#f0a855" }}>Pending setup</p>}
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
                        {(!isPaid && !isAdmin) && <p className="text-[10px] font-medium mb-1" style={{ color: "#f0a855" }}>Pending setup</p>}
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
                <div key={group.channelName} className="rounded-2xl px-4 sm:px-6" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)", paddingTop: "34px", paddingBottom: "34px" }}>
                  {/* Channel header */}
                  <div className="flex items-center justify-between gap-3 mb-5">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-xl flex items-center justify-center text-base font-bold shrink-0"
                        style={{
                          background: "oklch(0.72 0.25 285 / 0.15)",
                          color: "oklch(0.72 0.25 285)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.25)",
                        }}>
                        {group.channelName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-base font-bold text-foreground truncate">{group.channelName}</h2>
                        {group.channelUrl && (
                          <p className="text-xs mt-0.5 truncate" style={{ color: "var(--c-38)" }}>
                            {group.channelUrl}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="hidden sm:inline text-xs px-3 py-1 rounded-full"
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
                    style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))" }}>
                    {group.projects.map((p) => {
                      const assembled = p.assembly_status === "done";
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
                      const progress = assembled ? 100 : Math.round(((PHASE_RANK[path] ?? 0) + 1) / 8 * 100);
                      const isComplete = assembled;

                      return (
                        <button
                          key={p.id}
                          onClick={() => router.push(`/projects/${p.id}/${path}`)}
                          className="text-left p-6 rounded-2xl transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
                          style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}
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
                  <div className="w-11 h-11 rounded-xl animate-pulse" style={{ background: "oklch(1 0 0 / 0.08)" }} />
                  <div className="space-y-2">
                    <div className="h-4 w-36 rounded animate-pulse" style={{ background: "oklch(1 0 0 / 0.08)" }} />
                    <div className="h-3 w-52 rounded animate-pulse" style={{ background: "oklch(1 0 0 / 0.08)" }} />
                  </div>
                </div>
                <div className="grid gap-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))" }}>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="p-6 rounded-2xl space-y-4"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-7)" }}>
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
              disabled={creating || !authReady}
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
            <div className="flex flex-col items-center gap-3">
              {(!isPaid && !isAdmin) && (
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
                disabled={creating || !authReady}
                className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
              >
                {creating ? "Creating…" : isPaid || isAdmin ? "New Project →" : "Subscribe & Start →"}
              </button>
            </div>
          </div>
        )}
        </>
        )}

      </main>

      {showSubscriptionModal && (
        <SubscriptionModal
          email={userEmail}
          defaultPlan={selectedPlan}
          hideTryDemo={demoNicheCreated || demoProgress.channelDone || demoProgress.topic !== "" || demoProgress.highestStep > 0}
          onClose={() => { setShowSubscriptionModal(false); setPendingAction(null); }}
          onSuccess={handleSubscriptionSuccess}
        />
      )}

    </div>
  );
}
