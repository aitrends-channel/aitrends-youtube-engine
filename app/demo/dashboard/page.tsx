"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Settings, LogOut, BarChart3, Film, ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { SubscriptionModal } from "@/components/SubscriptionModal";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { DEMO_DATA } from "@/lib/demo-data";

// ── Mock project data ─────────────────────────────────────────────────────────

const CHANNEL = DEMO_DATA.channel;

const DEMO_STEP_LABELS = ["Channel", "Topic", "Script", "Visuals", "Prompts", "Generate", "Assemble", "Complete"];
const DEMO_STEP_HREFS  = [
  "/demo/channel", "/demo/topic", "/demo/script", "/demo/visuals",
  "/demo/prompts", "/demo/generate", "/demo/assemble", "/demo/thumbnails",
];

const MOCK_VIDEO_BASE = {
  id: "d1",
  title: "5 Money Habits That Are Making You Poorer",
  timeAgo: "2d ago",
};

const TOTAL       = 1;
const NICHES      = 1;
const NICHE_LIMIT = 5;

// Display-only — not counted in any stats
const STATIC_NICHE = {
  name: "MoneyMindset",
  url: "youtube.com/@moneymindset",
  videos: [
    { title: "5 Passive Income Streams That Actually Work in 2025", progress: 100 },
    { title: "How I Built a $10K/Month Portfolio with ETFs", progress: 100 },
    { title: "The Truth About Index Funds Nobody Tells You", progress: 100 },
  ],
};

// ── Sub-components ────────────────────────────────────────────────────────────

const R = 18, CX = 22, CY = 22, STROKE = 5;
const CIRC = 2 * Math.PI * R;

function PieRing({ id, pct, color, centerText, full }: {
  id: string; pct: number; color: string; centerText: string; full?: boolean;
}) {
  const dash = pct * CIRC;
  return (
    <svg width={44} height={44} viewBox="0 0 44 44">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.7" />
          <stop offset="100%" stopColor={color} />
        </linearGradient>
      </defs>
      <circle cx={CX} cy={CY} r={R} fill="none" stroke={color} strokeOpacity="0.12" strokeWidth={STROKE} />
      {(full || pct >= 1) ? (
        <circle cx={CX} cy={CY} r={R} fill="none" stroke={`url(#${id})`} strokeWidth={STROKE} />
      ) : pct > 0 ? (
        <circle cx={CX} cy={CY} r={R} fill="none"
          stroke={`url(#${id})`} strokeWidth={STROKE}
          strokeDasharray={`${dash} ${CIRC}`}
          strokeDashoffset={CIRC / 4}
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DemoDashboardPage() {
  const router = useRouter();
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [hoveredBar, setHoveredBar] = useState(false);
  const [showSubModal, setShowSubModal] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [hasNiche, setHasNiche] = useState<boolean | null>(null);
  const [highestStep, setHighestStep] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
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

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email) setUserEmail(data.user.email);
    });

    fetch("/api/demo-niche")
      .then(r => r.json())
      .then(d => setHasNiche(d.demo_niche_created === true))
      .catch(() => setHasNiche(false));

    try {
      const raw = sessionStorage.getItem("demo_state_v1");
      if (raw) {
        const s = JSON.parse(raw);
        if (typeof s.highestStep === "number") setHighestStep(s.highestStep);
      }
    } catch {}
  }, []);

  const videoIsComplete = highestStep >= 7;
  const videoProgress   = Math.round(((highestStep + 1) / 8) * 100);
  const videoStateLabel = DEMO_STEP_LABELS[Math.min(highestStep, 7)];
  const videoHref       = DEMO_STEP_HREFS[Math.min(highestStep, 7)];

  const nicheReady   = hasNiche === true;
  const completed    = nicheReady ? (videoIsComplete ? 1 : 0) : 0;
  const inProg       = nicheReady ? (videoIsComplete ? 0 : 1) : 0;
  const totalVideos  = nicheReady ? TOTAL : 0;
  const nicheCount   = nicheReady ? NICHES : 0;
  const completedPct = nicheReady ? completed / TOTAL : 0;
  const inProgPct    = nicheReady ? inProg / TOTAL : 0;
  const nichePct     = nicheReady ? NICHES / NICHE_LIMIT : 0;
  const nicheColor    = "#9b7ff5";

  // Bar chart (single bar — FinanceFuel)
  const W = 600, PAD_X = 16, PAD_T = 16, PAD_B = 32, H = 160;
  const plotH = H - PAD_T - PAD_B;
  const plotW = W - PAD_X * 2;
  const barW = 52;
  const rx = 5;
  const cx = PAD_X + plotW / 2;
  const barH = plotH; // single bar at 100% height (1 video = max for this demo)
  const x = cx - barW / 2;
  const y = PAD_T;

  const cardStyle = { background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" };

  return (
    <div className="min-h-screen flex flex-col overflow-x-hidden" style={{ background: "var(--bg-page)" }}>
      <DemoBanner />

      {/* Header */}
      <header
        className="flex items-center justify-between px-4 sm:px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}
      >
        <div className="flex items-center gap-3">
          <Link href="/demo/dashboard" className="flex items-center gap-3 transition-opacity hover:opacity-80">
            <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
              <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
            </div>
            <span className="font-bold text-sm tracking-tight">Heclus</span>
          </Link>
          <span
            className="text-xs font-semibold px-1.5 py-0.5 rounded"
            style={{
              background: "oklch(0.72 0.25 285 / 0.15)",
              border: "1px solid oklch(0.72 0.25 285 / 0.3)",
              color: "oklch(0.72 0.25 285)",
            }}
          >
            Demo
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/demo/channel")}
            className="hidden sm:flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all hover:opacity-80"
            style={{ background: "var(--bg-control)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
          >
            <ArrowLeft size={13} />
            Back to Demo
          </button>

          <ThemeToggle />

          {/* Profile avatar */}
          <div className="relative" ref={profileMenuRef}>
            <button
              onClick={() => setShowProfileMenu(v => !v)}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold transition-all hover:opacity-80 cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              F
            </button>

            {showProfileMenu && (
              <>
                <div
                  className="absolute right-0 top-12 z-[200] w-64 rounded-2xl py-3 shadow-2xl"
                  style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}
                >
                  <div className="px-4 pb-3" style={{ borderBottom: "1px solid oklch(1 0 0 / 0.07)" }}>
                    <div className="flex items-center gap-3 mb-3">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center text-base font-bold shrink-0"
                        style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
                      >
                        F
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate" style={{ color: "var(--c-88)" }}>demo@heclus.com</p>
                        <p className="text-[10px]" style={{ color: "var(--c-38)" }}>Member since May 2025</p>
                      </div>
                    </div>
                    <span
                      className="text-[10px] font-semibold px-2.5 py-1 rounded-full"
                      style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}
                    >
                      Pro plan
                    </span>
                  </div>
                  <div className="px-2 pt-2">
                    <button
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80"
                      style={{ color: "var(--c-60)" }}
                      onClick={() => { setShowProfileMenu(false); setShowSubModal(true); }}
                    >
                      <Settings size={15} />
                      <span>Setup</span>
                    </button>
                    <button
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ color: "#f87171" }}
                      disabled={signingOut}
                      onClick={async () => {
                        setShowProfileMenu(false);
                        setSigningOut(true);
                        try { sessionStorage.removeItem("demo_state_v1"); } catch {}
                        const supabase = createSupabaseBrowserClient();
                        await supabase.auth.signOut();
                        router.push("/login");
                      }}
                    >
                      <LogOut size={15} />
                      <span>{signingOut ? "Signing out…" : "Sign Out"}</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          <button
            onClick={() => setShowSubModal(true)}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90 cursor-pointer"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
          >
            <span>+</span>
            <span className="hidden sm:inline">New Video</span>
          </button>
        </div>
      </header>

      <main className="flex-1 w-full px-4 sm:px-8 lg:px-24 py-6 sm:py-12 space-y-8 sm:space-y-12">

        {/* ── General Stats ─────────────────────────────────────────────── */}
        <div className="space-y-6">
          <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginBottom: "10px" }}>General Stats</h3>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {/* Total Videos */}
            <div className="rounded-xl px-5 py-4" style={cardStyle}>
              <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{totalVideos}</p>
              <p className="text-xs" style={{ color: "var(--c-42)" }}>Total Videos</p>
            </div>

            {/* Completed */}
            <div className="rounded-xl px-5 py-4 flex items-center justify-between" style={cardStyle}>
              <div>
                <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{completed}</p>
                <p className="text-xs" style={{ color: "var(--c-42)" }}>Completed</p>
                <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>{Math.round(completedPct * 100)}% of total</p>
              </div>
              <PieRing id="dCompGrad" pct={completedPct} color="#5bc48a" centerText={`${Math.round(completedPct * 100)}%`} />
            </div>

            {/* In Progress */}
            <div className="rounded-xl px-5 py-4 flex items-center justify-between" style={cardStyle}>
              <div>
                <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{inProg}</p>
                <p className="text-xs" style={{ color: "var(--c-42)" }}>In Progress</p>
                <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>{Math.round(inProgPct * 100)}% of total</p>
              </div>
              <PieRing id="dProgGrad" pct={inProgPct} color="#f0a855" centerText={`${Math.round(inProgPct * 100)}%`} />
            </div>

            {/* Niches */}
            <div className="rounded-xl px-5 py-4 flex items-center justify-between" style={cardStyle}>
              <div>
                <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{nicheCount}</p>
                <p className="text-xs" style={{ color: "var(--c-42)" }}>Niches</p>
                <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>of {NICHE_LIMIT}</p>
              </div>
              <PieRing id="dNicheGrad" pct={nichePct} color={nicheColor} centerText={`${nicheCount}/${NICHE_LIMIT}`} />
            </div>
          </div>

          {/* ── Bar Chart ─────────────────────────────────────────────────── */}
          <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "40px", marginBottom: "10px" }}>Niches/Video Chart</h3>
          <div className="rounded-2xl px-4 sm:px-6 py-5" style={cardStyle}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <p className="text-sm font-semibold" style={{ color: "var(--c-75)" }}>Videos per niche</p>
                <p className="text-xs mt-0.5" style={{ color: "var(--c-35)" }}>All time</p>
              </div>
              <span className="text-2xl font-bold" style={{ color: "var(--c-90)" }}>{totalVideos}</span>
            </div>
            <div style={{ overflowX: "clip" }}>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
              <defs>
                <linearGradient id="dBarGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#9b7ff5" stopOpacity="0.95" />
                  <stop offset="100%" stopColor="#9b7ff5" stopOpacity="0.45" />
                </linearGradient>
                <linearGradient id="dBarHov" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#b89dff" stopOpacity="1" />
                  <stop offset="100%" stopColor="#9b7ff5" stopOpacity="0.7" />
                </linearGradient>
              </defs>
              <line x1={PAD_X} y1={PAD_T + plotH} x2={W - PAD_X} y2={PAD_T + plotH}
                stroke="white" strokeOpacity="0.08" strokeWidth="1" />
              {[0.25, 0.5, 0.75, 1].map(f => (
                <line key={f}
                  x1={PAD_X} y1={PAD_T + plotH - f * plotH}
                  x2={W - PAD_X} y2={PAD_T + plotH - f * plotH}
                  stroke="white" strokeOpacity="0.05" strokeWidth="1" />
              ))}
              <g
                onMouseEnter={() => setHoveredBar(true)}
                onMouseLeave={() => setHoveredBar(false)}
                style={{ cursor: "pointer" }}
              >
                <rect x={x} y={PAD_T} width={barW} height={plotH} fill="transparent" />
                <path
                  d={`M ${x + rx} ${y} H ${x + barW - rx} Q ${x + barW} ${y} ${x + barW} ${y + rx} V ${y + barH} H ${x} V ${y + rx} Q ${x} ${y} ${x + rx} ${y}`}
                  fill={hoveredBar ? "url(#dBarHov)" : "url(#dBarGrad)"}
                />
                {!hoveredBar && (
                  <text x={cx} y={y - 5} textAnchor="middle" fontSize="10" fill="#9b7ff5" fontWeight="600">
                    {totalVideos}
                  </text>
                )}
                {hoveredBar && (() => {
                  const TW = 100, TH = 32, TX = cx - TW / 2, TY = y - TH - 8;
                  return (
                    <g>
                      <rect x={TX} y={TY} width={TW} height={TH} rx={5} fill="#1e1533" stroke="#9b7ff5" strokeOpacity="0.4" strokeWidth="1" />
                      <text x={TX + TW / 2} y={TY + 12} textAnchor="middle" fontSize="9.5" fill="rgba(255,255,255,0.7)" fontWeight="500">
                        FinanceFuel
                      </text>
                      <text x={TX + TW / 2} y={TY + 24} textAnchor="middle" fontSize="10" fill="#9b7ff5" fontWeight="700">
                        {totalVideos} Videos
                      </text>
                    </g>
                  );
                })()}
                <text x={cx} y={PAD_T + plotH + 18} textAnchor="middle" fontSize="10"
                  fill={hoveredBar ? "#9b7ff5" : "rgba(255,255,255,0.3)"} fontWeight={hoveredBar ? "600" : "400"}>
                  FinanceFuel
                </text>
              </g>
            </svg>
            </div>
          </div>

          {/* ── API Keys Status ────────────────────────────────────────────── */}
          <div style={{ marginTop: "40px" }}>
            <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "10px", marginBottom: "10px" }}>Your API Key Status</h3>
            <div className="grid grid-cols-1 gap-4">

              {/* KIE */}
              <div className="rounded-xl px-5 py-4" style={cardStyle}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold leading-tight" style={{ color: "var(--c-88)" }}>KIE</p>
                    <p className="text-[10px] font-medium mt-0.5" style={{ color: "#f0a855" }}>Pending setup</p>
                    <p className="text-[10px] mt-0.5" style={{ color: "var(--c-38)" }}>Script generation, TTS, images & video</p>
                  </div>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ background: "#94a3b822", color: "#94a3b8" }}>Not set</span>
                </div>
              </div>

            </div>
          </div>

          <h2 className="text-xl font-bold tracking-tight" style={{ color: "var(--c-85)", marginTop: "60px" }}>Your Niches & Videos</h2>
        </div>

        {/* ── Channel group ─────────────────────────────────────────────────── */}
        {hasNiche === null ? null : hasNiche === false ? (
          <div
            className="flex flex-col items-center justify-center py-20 rounded-2xl"
            style={{ background: "oklch(1 0 0 / 0.03)", border: "1px dashed oklch(1 0 0 / 0.1)" }}
          >
            <p className="text-sm font-semibold mb-1" style={{ color: "var(--c-55)" }}>No niches yet</p>
            <p className="text-xs mb-5" style={{ color: "var(--c-35)" }}>Try the end-to-end workflow to create your first niche.</p>
            <button
              onClick={() => router.push("/demo/channel")}
              className="px-4 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
            >
              Start demo →
            </button>
          </div>
        ) : (
        <div>
          <div
            className="rounded-2xl px-6"
            style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)", paddingTop: "34px", paddingBottom: "34px" }}
          >
            {/* Channel header */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
              <div className="flex items-center gap-3">
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center text-base font-bold shrink-0"
                  style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}
                >
                  F
                </div>
                <div>
                  <h2 className="text-base font-bold">{CHANNEL.name}</h2>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-38)" }}>{CHANNEL.url}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className="text-xs px-3 py-1 rounded-full"
                  style={{ background: "var(--bg-elevated)", border: "1px solid var(--bd-6)", color: "var(--c-42)" }}
                >
                  {totalVideos} videos
                </span>
                <button
                  onClick={() => setShowSubModal(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 cursor-pointer"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
                >
                  + New Video
                </button>
              </div>
            </div>

            {/* Video cards */}
            <div className="grid gap-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))" }}>
              <button
                onClick={() => router.push(videoHref)}
                className="text-left p-6 rounded-2xl transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
                style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.35)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-7)"; }}
              >
                <div className="flex items-start justify-between mb-3">
                  <span
                    className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                    style={videoIsComplete ? {
                      background: "oklch(0.55 0.15 145 / 0.15)",
                      color: "oklch(0.65 0.15 145)",
                      border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                    } : {
                      background: "oklch(0.72 0.25 285 / 0.1)",
                      color: "oklch(0.72 0.25 285)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                    }}
                  >
                    {videoStateLabel}
                  </span>
                  <span className="text-xs" style={{ color: "var(--c-38)" }}>{MOCK_VIDEO_BASE.timeAgo}</span>
                </div>

                <p className="text-lg font-semibold leading-snug mb-5" style={{ color: "var(--c-88)" }}>
                  {MOCK_VIDEO_BASE.title}
                </p>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs" style={{ color: "var(--c-38)" }}>
                    <span>Progress</span>
                    <span>{videoProgress}%</span>
                  </div>
                  <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${videoProgress}%`,
                        background: videoIsComplete
                          ? "oklch(0.55 0.15 145)"
                          : "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                      }}
                    />
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
        )}

        {/* Static display-only niche — not counted in any stats */}
        {hasNiche === true && <div style={{ opacity: 0.18, pointerEvents: "none", userSelect: "none" }}>
          <div className="px-8 py-6 rounded-2xl" style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}>
            {/* Channel header */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0"
                  style={{ background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }}
                >
                  M
                </div>
                <div>
                  <h2 className="text-base font-bold">{STATIC_NICHE.name}</h2>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-38)" }}>{STATIC_NICHE.url}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className="text-xs px-3 py-1 rounded-full"
                  style={{ background: "var(--bg-elevated)", border: "1px solid var(--bd-6)", color: "var(--c-42)" }}
                >
                  {STATIC_NICHE.videos.length} videos
                </span>
              </div>
            </div>

            {/* Video cards */}
            <div className="grid gap-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))" }}>
              {STATIC_NICHE.videos.map((v, i) => (
                <div
                  key={i}
                  className="text-left p-6 rounded-2xl"
                  style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}
                >
                  <div className="flex items-start justify-between mb-3">
                    <span
                      className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                      style={{
                        background: "oklch(0.55 0.15 145 / 0.15)",
                        color: "oklch(0.65 0.15 145)",
                        border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                      }}
                    >
                      Complete
                    </span>
                  </div>
                  <p className="text-lg font-semibold leading-snug mb-5" style={{ color: "var(--c-88)" }}>
                    {v.title}
                  </p>
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs" style={{ color: "var(--c-38)" }}>
                      <span>Progress</span>
                      <span>{v.progress}%</span>
                    </div>
                    <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${v.progress}%`, background: "oklch(0.55 0.15 145)" }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>}

      </main>

      {showSubModal && (
        <SubscriptionModal
          email={userEmail}
          hideTryDemo={hasNiche === true}
          onClose={() => setShowSubModal(false)}
          onSuccess={() => { setShowSubModal(false); router.push("/dashboard"); }}
        />
      )}
    </div>
  );
}
