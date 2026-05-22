"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Settings, LogOut, BarChart3, Film, ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";

// ── Mock project data ─────────────────────────────────────────────────────────

const CHANNEL = DEMO_DATA.channel;

const MOCK_VIDEOS = [
  {
    id: "d1",
    title: "5 Money Habits That Are Making You Poorer",
    stateLabel: "Complete",
    progress: 100,
    timeAgo: "2d ago",
    isComplete: true,
    href: "/demo/assemble",
  },
  {
    id: "d2",
    title: "Why Your Emergency Fund Is the Wrong Size (And the Exact Number You Need)",
    stateLabel: "Complete",
    progress: 100,
    timeAgo: "3d ago",
    isComplete: true,
    href: "/demo/assemble",
  },
  {
    id: "d3",
    title: "The Silent 401(k) Fee That's Stealing Years From Your Retirement",
    stateLabel: "Generate",
    progress: 87,
    timeAgo: "1d ago",
    isComplete: false,
    href: "/demo/generate",
  },
  {
    id: "d4",
    title: "I Tracked Every Dollar for 90 Days — Here's What Actually Changed",
    stateLabel: "Prompts",
    progress: 60,
    timeAgo: "5h ago",
    isComplete: false,
    href: "/demo/prompts",
  },
  {
    id: "d5",
    title: "Stop Budgeting. Do This Instead to Build Wealth Faster",
    stateLabel: "Script",
    progress: 40,
    timeAgo: "2h ago",
    isComplete: false,
    href: "/demo/script",
  },
];

const TOTAL      = MOCK_VIDEOS.length;
const COMPLETED  = MOCK_VIDEOS.filter(v => v.isComplete).length;
const IN_PROG    = MOCK_VIDEOS.filter(v => !v.isComplete).length;
const NICHES     = 1;
const NICHE_LIMIT = 5;

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

  const completedPct  = COMPLETED / TOTAL;
  const inProgPct     = IN_PROG / TOTAL;
  const nichePct      = NICHES / NICHE_LIMIT;
  const nicheColor    = "#9b7ff5";

  // Bar chart (single bar — FinanceFuel)
  const W = 600, PAD_X = 16, PAD_T = 16, PAD_B = 32, H = 160;
  const plotH = H - PAD_T - PAD_B;
  const plotW = W - PAD_X * 2;
  const barW = 52;
  const rx = 5;
  const cx = PAD_X + plotW / 2;
  const barH = plotH; // single bar at 100% height (5 videos = max for this demo)
  const x = cx - barW / 2;
  const y = PAD_T;

  const cardStyle = { background: "var(--bg-card)", border: "1px solid var(--bd-7)" };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-page)" }}>
      <DemoBanner />

      {/* Header */}
      <header
        className="flex items-center justify-between px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <span className="font-bold text-sm tracking-tight">Heclus</span>
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
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all hover:opacity-80"
            style={{ background: "var(--bg-control)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
          >
            <ArrowLeft size={13} />
            Back to Demo
          </button>

          <ThemeToggle />

          {/* Profile avatar */}
          <div className="relative">
            <button
              onClick={() => setShowProfileMenu(v => !v)}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold transition-all hover:opacity-80 cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              F
            </button>

            {showProfileMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
                <div
                  className="absolute right-0 top-12 z-50 w-64 rounded-2xl py-3 shadow-2xl"
                  style={{ background: "var(--bg-card)", border: "1px solid var(--bd-10)" }}
                >
                  <div className="px-4 pb-3" style={{ borderBottom: "1px solid var(--bd-7)" }}>
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
                      onClick={() => { setShowProfileMenu(false); router.push("/demo/channel"); }}
                    >
                      <Settings size={15} />
                      <span>Setup</span>
                    </button>
                    <button
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80"
                      style={{ color: "#f87171" }}
                      onClick={() => setShowProfileMenu(false)}
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
            onClick={() => router.push("/demo/channel")}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90 cursor-pointer"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
          >
            + New Video
          </button>
        </div>
      </header>

      <main className="flex-1 w-full px-24 py-12 space-y-12">

        {/* ── General Stats ─────────────────────────────────────────────── */}
        <div className="space-y-6">
          <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginBottom: "10px" }}>General Stats</h3>

          <div className="grid grid-cols-4 gap-4">
            {/* Total Videos */}
            <div className="rounded-xl px-5 py-4" style={cardStyle}>
              <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{TOTAL}</p>
              <p className="text-xs" style={{ color: "var(--c-42)" }}>Total Videos</p>
            </div>

            {/* Completed */}
            <div className="rounded-xl px-5 py-4 flex items-center justify-between" style={cardStyle}>
              <div>
                <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{COMPLETED}</p>
                <p className="text-xs" style={{ color: "var(--c-42)" }}>Completed</p>
                <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>{Math.round(completedPct * 100)}% of total</p>
              </div>
              <PieRing id="dCompGrad" pct={completedPct} color="#5bc48a" centerText={`${Math.round(completedPct * 100)}%`} />
            </div>

            {/* In Progress */}
            <div className="rounded-xl px-5 py-4 flex items-center justify-between" style={cardStyle}>
              <div>
                <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{IN_PROG}</p>
                <p className="text-xs" style={{ color: "var(--c-42)" }}>In Progress</p>
                <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>{Math.round(inProgPct * 100)}% of total</p>
              </div>
              <PieRing id="dProgGrad" pct={inProgPct} color="#f0a855" centerText={`${Math.round(inProgPct * 100)}%`} />
            </div>

            {/* Niches */}
            <div className="rounded-xl px-5 py-4 flex items-center justify-between" style={cardStyle}>
              <div>
                <p className="text-2xl font-bold mb-1" style={{ color: "var(--c-90)" }}>{NICHES}</p>
                <p className="text-xs" style={{ color: "var(--c-42)" }}>Niches</p>
                <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>of {NICHE_LIMIT}</p>
              </div>
              <PieRing id="dNicheGrad" pct={nichePct} color={nicheColor} centerText={`${NICHES}/${NICHE_LIMIT}`} />
            </div>
          </div>

          {/* ── Bar Chart ─────────────────────────────────────────────────── */}
          <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "40px", marginBottom: "10px" }}>Niches/Video Chart</h3>
          <div className="rounded-2xl px-6 py-5" style={cardStyle}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <p className="text-sm font-semibold" style={{ color: "var(--c-75)" }}>Videos per niche</p>
                <p className="text-xs mt-0.5" style={{ color: "var(--c-35)" }}>All time</p>
              </div>
              <span className="text-2xl font-bold" style={{ color: "var(--c-90)" }}>{TOTAL}</span>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ overflow: "visible" }}>
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
                    {TOTAL}
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
                        {TOTAL} Videos
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

          {/* ── API Keys Status ────────────────────────────────────────────── */}
          <div style={{ marginTop: "40px" }}>
            <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginTop: "10px", marginBottom: "10px" }}>Your API Keys Status</h3>
            <div className="grid grid-cols-4 gap-4">

              {/* Anthropic */}
              <div className="rounded-xl px-5 py-4" style={cardStyle}>
                <div className="flex items-center justify-between mb-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: "#c084fc" }} />
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "#34d39922", color: "#34d399" }}>Active</span>
                </div>
                <p className="text-sm font-bold mb-0.5" style={{ color: "var(--c-88)" }}>Anthropic</p>
                <p className="text-[10px] mb-3" style={{ color: "var(--c-38)" }}>Claude AI — scripts & analysis</p>
                <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
                  Billing: <span className="font-semibold" style={{ color: "#c084fc" }}>Pay-per-token</span>
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: "var(--c-30)" }}>No credit pool — billed by usage</p>
              </div>

              {/* YouTube */}
              <div className="rounded-xl px-5 py-4" style={cardStyle}>
                <div className="flex items-center justify-between mb-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: "#f87171" }} />
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "#34d39922", color: "#34d399" }}>Active</span>
                </div>
                <p className="text-sm font-bold mb-0.5" style={{ color: "var(--c-88)" }}>YouTube</p>
                <p className="text-[10px] mb-3" style={{ color: "var(--c-38)" }}>Channel lookup & metadata</p>
                <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
                  Quota: <span className="font-semibold" style={{ color: "#f87171" }}>10,000 units / day</span>
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: "var(--c-30)" }}>Resets daily · View in Google Console</p>
              </div>

              {/* KIE */}
              <div className="rounded-xl px-5 py-4" style={cardStyle}>
                <div className="flex items-center justify-between mb-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: "#60a5fa" }} />
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "#34d39922", color: "#34d399" }}>Active</span>
                </div>
                <p className="text-sm font-bold mb-0.5" style={{ color: "var(--c-88)" }}>KIE</p>
                <p className="text-[10px] mb-3" style={{ color: "var(--c-38)" }}>TTS, images & video generation</p>
                <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
                  Credits remaining: <span className="font-semibold" style={{ color: "#60a5fa" }}>847</span>
                </p>
              </div>

              {/* ElevenLabs */}
              <div className="rounded-xl px-5 py-4" style={cardStyle}>
                <div className="flex items-center justify-between mb-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: "#34d399" }} />
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "#34d39922", color: "#34d399" }}>Active</span>
                </div>
                <p className="text-sm font-bold mb-0.5" style={{ color: "var(--c-88)" }}>ElevenLabs</p>
                <p className="text-[10px] mb-3" style={{ color: "var(--c-38)" }}>Voiceover & captions</p>
                <div>
                  <div className="flex justify-between text-[10px] mb-1" style={{ color: "var(--c-40)" }}>
                    <span>45,230 used</span>
                    <span>100,000 limit</span>
                  </div>
                  <div className="w-full rounded-full h-1.5" style={{ background: "var(--bg-card)" }}>
                    <div className="h-1.5 rounded-full" style={{ width: "45.2%", background: "#34d399" }} />
                  </div>
                  <p className="text-[10px] mt-1.5 capitalize" style={{ color: "var(--c-35)" }}>Creator plan</p>
                </div>
              </div>

            </div>
          </div>

          <h2 className="text-xl font-bold tracking-tight" style={{ color: "var(--c-85)", marginTop: "60px" }}>Your Niches & Videos</h2>
        </div>

        {/* ── Channel group ─────────────────────────────────────────────────── */}
        <div>
          <div
            className="rounded-2xl px-6"
            style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)", paddingTop: "34px", paddingBottom: "34px" }}
          >
            {/* Channel header */}
            <div className="flex items-center justify-between mb-5">
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
                  {TOTAL} videos
                </span>
                <button
                  onClick={() => router.push("/demo/channel")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 cursor-pointer"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--c-98)" }}
                >
                  + New Video
                </button>
              </div>
            </div>

            {/* Video cards */}
            <div className="grid gap-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
              {MOCK_VIDEOS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => router.push(v.href)}
                  className="text-left p-6 rounded-2xl transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
                  style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.72 0.25 285 / 0.35)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--bd-7)"; }}
                >
                  <div className="flex items-start justify-between mb-3">
                    <span
                      className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                      style={v.isComplete ? {
                        background: "oklch(0.55 0.15 145 / 0.15)",
                        color: "oklch(0.65 0.15 145)",
                        border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                      } : {
                        background: "oklch(0.72 0.25 285 / 0.1)",
                        color: "oklch(0.72 0.25 285)",
                        border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                      }}
                    >
                      {v.stateLabel}
                    </span>
                    <span className="text-xs" style={{ color: "var(--c-38)" }}>{v.timeAgo}</span>
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
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${v.progress}%`,
                          background: v.isComplete
                            ? "oklch(0.55 0.15 145)"
                            : "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                        }}
                      />
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

      </main>
    </div>
  );
}
