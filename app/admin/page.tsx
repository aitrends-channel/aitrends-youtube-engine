"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import {
  ArrowLeft, LogOut, BarChart3, Users, UserCheck, FolderOpen,
  CheckCircle2, UserPlus, Settings, TrendingUp, Clapperboard, Film, Clock,
  DollarSign, Sparkles, RotateCcw, Pencil, FileText, AlertCircle, Activity, Server,
  Crown, MoreVertical, Trash2, Copy, Gauge, Eye, EyeOff, Mail, KeyRound, CreditCard, Rocket, X, Check, LifeBuoy, FlaskConical, MemoryStick, Star, UserX, Gem, Menu, Gift, Bot, Lightbulb,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import useSWR from "swr";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { isAdminUser } from "@/lib/admin";
import EmailsPanel from "./EmailsPanel";
import FreeUsagePanel from "./FreeUsagePanel";
import { TtsCostLens } from "@/components/admin/TtsCostLens";
import { SupportPanel } from "@/components/admin/SupportPanel";
import { FeedbackPanel } from "@/components/admin/FeedbackPanel";
import { FeatureRequestsPanel } from "@/components/admin/FeatureRequestsPanel";
import { paidModelsOnly } from "@/lib/model-tier";
import { MemoryPanel } from "@/components/admin/MemoryPanel";
import { QuotasPanel } from "@/components/admin/quotas";
import { HeclusAgentPanel } from "@/components/admin/HeclusAgentPanel";

const PHASE_PATHS: Record<number, string> = {
  1: "channel", 2: "channel", 3: "channel", 4: "channel", 5: "channel",
  6: "topic", 7: "visuals", 8: "visuals", 9: "prompts", 10: "prompts",
  11: "visuals", 12: "visuals", 13: "thumbnails", 14: "generate", 15: "assemble",
};

// "62% of total" line for the stats cards — same wording as the client
// dashboard's completed/in-progress cards. Undefined while stats load
// (or with zero videos) so the card just omits the line.
function pctOfTotal(n: number | undefined, total: number | undefined): string | undefined {
  if (n === undefined || total === undefined || total <= 0) return undefined;
  return `${Math.round((n / total) * 100)}% of total`;
}

// True when the timestamp falls on the local calendar day `dayOffset`
// days from today (0 = today, -1 = yesterday). Local time on purpose —
// "today" should mean the admin's today, not UTC's.
function isOnLocalDay(iso: string | null, dayOffset: number): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const ref = new Date();
  ref.setDate(ref.getDate() + dayOffset);
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
}

// Status filter for the Videos tab. Step ranges mirror PHASE_LABELS /
// PHASE_PATHS so filtering agrees with the Phase column the table shows.
// State 6 is shared by Topic and Script — split by selected_topic, the
// same signal the bulk-mail audience queries use. "In progress" matches
// the "Videos in Progress" stat card (started but not complete).
// "Completed today/yesterday" uses completedAt (assembly finish), so
// completions that pre-date the timing migration won't match — those are
// all old anyway. "Started" = project created.
type StatusFilterRow = { currentState: number; isComplete: boolean; selectedTopic: string | null; createdAt: string; completedAt: string | null };
const PROJECT_STATUS_FILTERS: { id: string; label: string; match: (p: StatusFilterRow) => boolean }[] = [
  { id: "all",           label: "All statuses",        match: () => true },
  { id: "completed",     label: "Completed",           match: (p) => p.isComplete },
  { id: "inprogress",    label: "In progress",         match: (p) => p.currentState > 1 && !p.isComplete },
  { id: "completed-today",     label: "Completed today",     match: (p) => p.isComplete && isOnLocalDay(p.completedAt, 0) },
  { id: "started-today",       label: "Started today",       match: (p) => isOnLocalDay(p.createdAt, 0) },
  { id: "completed-yesterday", label: "Completed yesterday", match: (p) => p.isComplete && isOnLocalDay(p.completedAt, -1) },
  { id: "started-yesterday",   label: "Started yesterday",   match: (p) => isOnLocalDay(p.createdAt, -1) },
  { id: "channel",    label: "At Channel",    match: (p) => p.currentState <= 5 },
  { id: "topic",      label: "At Topic",      match: (p) => p.currentState === 6 && !p.selectedTopic },
  { id: "script",     label: "At Script",     match: (p) => p.currentState === 6 && !!p.selectedTopic },
  { id: "visuals",    label: "At Visuals",    match: (p) => [7, 8, 11, 12].includes(p.currentState) },
  // Chips follow the same state→step mapping the stats route uses. 13 is where
  // the app parks a project that landed on Prompts (deliberately short of
  // Generate/Assemble); the thumbnails step is 16.
  { id: "prompts",    label: "At Prompts",    match: (p) => [9, 10, 13].includes(p.currentState) },
  { id: "generate",   label: "At Generate",   match: (p) => p.currentState === 14 },
  { id: "assemble",   label: "At Assemble",   match: (p) => p.currentState === 15 && !p.isComplete },
  { id: "thumbnail",  label: "At Thumbnail",  match: (p) => p.currentState >= 16 && !p.isComplete },
];

const STATS_KEY = "/api/admin/stats";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/**
 * Tab state that survives page refreshes.
 *
 * Reads/writes localStorage under `admin-tab:<key>`. Lazy initializer
 * runs once per mount; SSR falls through to `fallback`. The valid-set
 * guard prevents a stale or hand-edited storage value (e.g. a tab that
 * was renamed) from breaking the UI — we discard anything not in the
 * current option list and use the fallback instead.
 */
function usePersistentTab<T extends string>(
  key: string,
  fallback: T,
  valid: readonly T[],
): [T, (v: T) => void] {
  const storageKey = `admin-tab:${key}`;
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored && (valid as readonly string[]).includes(stored)) {
        return stored as T;
      }
    } catch { /* localStorage disabled — fall through */ }
    return fallback;
  });
  const set = (v: T) => {
    setValue(v);
    try { window.localStorage.setItem(storageKey, v); } catch { /* ignore */ }
  };
  return [value, set];
}

function maskKey(key: string) {
  if (key.length <= 10) return "•".repeat(key.length);
  return key.slice(0, 8) + "••••••••" + key.slice(-4);
}

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

// Truncated table cell with hover/click affordance to reveal the full
// text. CSS handles the visual truncation (the parent <td> sets the
// max-width + truncate classes); we add an Eye icon next to the text
// as a visual cue that there's more to see. Hovering the cell shows
// a styled tooltip with the full value; clicking the icon pins the
// tooltip open (toggle) so the user can read long values without
// holding the mouse still. maxLen is a soft signal — when the value
// is shorter than that we hide the icon and skip the tooltip wiring
// entirely so short rows stay clean.
function TruncatedCell({ value, maxLen = 24, fallback = "—" }: {
  value: string | null | undefined;
  maxLen?: number;
  fallback?: string;
}) {
  const [pinned, setPinned] = useState(false);
  if (!value) {
    return <span style={{ color: "var(--c-35)" }}>{fallback}</span>;
  }
  const needsTrunc = value.length > maxLen;
  if (!needsTrunc) {
    return <span className="truncate">{value}</span>;
  }
  return (
    <div className="relative inline-flex items-center gap-1.5 max-w-full group">
      <span className="truncate" title={value}>
        {value}
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setPinned((p) => !p); }}
        className="shrink-0 transition-opacity opacity-50 group-hover:opacity-100"
        style={{ color: pinned ? "oklch(0.72 0.25 285)" : "var(--c-55)" }}
        aria-label={pinned ? "Hide full text" : "Show full text"}
        title={pinned ? "Hide full text" : "Show full text"}
      >
        <Eye size={12} />
      </button>
      <div
        className={`absolute z-20 top-full left-0 mt-1 px-3 py-2 rounded-lg text-xs transition-opacity ${pinned ? "opacity-100" : "opacity-0 pointer-events-none group-hover:opacity-100"}`}
        style={{
          background: "var(--bg-card)",
          border: "1px solid oklch(0 0 0 / 0.1)",
          color: "var(--c-85)",
          maxWidth: "360px",
          whiteSpace: "normal",
          wordBreak: "break-word",
          boxShadow: "0 4px 16px oklch(0 0 0 / 0.1)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

// Render an assembly's wall-clock duration in a compact human form.
// null → em-dash (project hasn't completed an assembly yet, or
// pre-dates migration 049). Sub-minute durations stay in seconds so
// short runs stay readable; minute+ durations show `Hh Mm` or `Mm Ss`
// without padding zeros so the column doesn't shout numbers at the
// reader.
function formatAssembleTime(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mRem = m % 60;
  return mRem === 0 ? `${h}h` : `${h}h ${mRem}m`;
}

// Video runtime as a timestamp — 8:04, or 1:02:30 past the hour. Distinct
// from formatAssembleTime's "3m 12s" on purpose: one is a clock reading of
// the video, the other is how long we spent making it.
function formatVideoLength(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

// Compact number formatting for cost cells. Keeps the table dense:
//   42       → "42"
//   1500     → "1.5k"
//   42000    → "42k"
//   1500000  → "1.5M"
// Fractional KIE credits (e.g. 9.6) render with one decimal up to
// 999.x; over a thousand they go to k-units like everything else.
function compactNumber(n: number): string {
  if (n === 0) return "0";
  if (n < 10 && !Number.isInteger(n)) return n.toFixed(1).replace(/\.0$/, "");
  if (n < 1000) return Math.round(n).toString();
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = n / 1_000_000;
  return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
}

// Short suffix for each unit kind logged by the cost ledger. Picked
// to be unambiguous at a glance inside a tight cell — "60 cr" reads
// as KIE credits, "12k tok" as Claude tokens. Falls back to the raw
// kind for unknown units so future additions show up as labeled
// strings rather than silently disappearing.
function unitSuffix(unitKind: string): string {
  switch (unitKind) {
    case "claude_tokens":
    case "claude_tokens_in":
    case "claude_tokens_out":
    case "claude_tokens_cache_read":
    case "claude_tokens_cache_creation":
      return "tok";
    case "kie_credits":
      return "cr";
    case "elevenlabs_chars":
      return "chr";
    case "supadata_transcripts":
      return "tx";
    default:
      return unitKind;
  }
}

// Friendly name for a unit kind in the hover tooltip.
function unitLabel(unitKind: string): string {
  switch (unitKind) {
    case "claude_tokens_in":              return "input tokens";
    case "claude_tokens_out":             return "output tokens";
    case "claude_tokens_cache_read":      return "cache-read tokens";
    case "claude_tokens_cache_creation":  return "cache-create tokens";
    case "kie_credits":                   return "KIE credits";
    case "elevenlabs_chars":              return "ElevenLabs chars";
    case "supadata_transcripts":          return "Supadata transcripts";
    default:                              return unitKind;
  }
}

// Two-letter provider tag prefixed onto each cost cell so the reader
// can tell at a glance which API the units belong to without hovering
// for the tooltip. Derived from unitKind because each unit kind maps
// cleanly to exactly one provider — saves us threading provider
// strings through the aggregation logic.
function providerInitial(unitKind: string): string {
  if (unitKind.startsWith("claude_tokens_")) return "An";
  switch (unitKind) {
    case "kie_credits":          return "Ki";
    case "elevenlabs_chars":     return "El";
    case "supadata_transcripts": return "Su";
    default:                     return "?";
  }
}

// One cell in the admin Cost table. Aggregates the provided
// summary's totals (already merged by the API per unit_kind) into a
// compact display string and surfaces the full provider/model
// breakdown in a hover tooltip. "—" when there's no data so the
// reader can tell at a glance which steps have logged cost rows.
function CostCell({ summary, showProviders = true }: { summary?: { totals: Record<string, number>; breakdown: Array<{ provider: string; model: string | null; unitKind: string; units: number }> }; showProviders?: boolean }) {
  if (!summary || !summary.breakdown.length) {
    return <span style={{ color: "var(--c-35)" }}>—</span>;
  }
  // Sum tokens-in + tokens-out + cache-* into a single "tok" tally
  // so Claude steps don't show four separate sub-cells. Other unit
  // kinds stay separate (kie_credits vs supadata_transcripts on
  // Channel Analysis, etc.).
  const tokensTotal =
    (summary.totals["claude_tokens_in"]              ?? 0) +
    (summary.totals["claude_tokens_out"]             ?? 0) +
    (summary.totals["claude_tokens_cache_read"]      ?? 0) +
    (summary.totals["claude_tokens_cache_creation"]  ?? 0);
  const otherUnits = Object.entries(summary.totals).filter(
    ([k]) => !k.startsWith("claude_tokens_"),
  );
  const providerBgFor = (initial: string): string => {
    switch (initial) {
      case "An": return "oklch(0.72 0.25 285)"; // purple — Anthropic
      case "Ki": return "oklch(0.55 0.15 220)"; // blue — KIE
      case "El": return "oklch(0.7 0.15 145)";  // green — ElevenLabs
      case "Su": return "oklch(0.55 0.18 65)";  // amber — Supadata
      default:   return "oklch(0.50 0 0)";      // neutral grey
    }
  };
  const providerBadge = (initial: string) => (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        borderRadius: "9999px",
        background: providerBgFor(initial),
        color: "white",
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1,
        marginRight: 4,
        verticalAlign: "middle",
      }}
    >
      {initial}
    </span>
  );
  const parts: React.ReactNode[] = [];
  if (tokensTotal > 0) {
    parts.push(
      <>
        {showProviders && providerBadge("An")}
        {compactNumber(tokensTotal)} tok
      </>,
    );
  }
  for (const [kind, units] of otherUnits) {
    if (units > 0) {
      parts.push(
        <>
          {showProviders && providerBadge(providerInitial(kind))}
          {compactNumber(units)} {unitSuffix(kind)}
        </>,
      );
    }
  }
  const tooltip = summary.breakdown
    .map((b) => `${b.provider}${b.model ? ` (${b.model})` : ""}: ${compactNumber(b.units)} ${unitLabel(b.unitKind)}`)
    .join("\n");
  return (
    <span title={tooltip}>
      {parts.length > 0
        ? parts.map((p, i) => (
            <span key={i}>
              {i > 0 && " · "}
              {p}
            </span>
          ))
        : <span style={{ color: "var(--c-35)" }}>—</span>}
    </span>
  );
}

interface AdminStats {
  accessGranted: number;
  activeAccounts: number;
  totalProjects: number;
  completed: number;
  videosInProgress: number;
}

interface AdminUser {
  email: string;
  status: "Registered" | "Pending" | "Paid";
  projectCount: number;
  lastSignIn: string | null;
  plan: string | null;
  paidAt: string | null;
  planExpiresAt: string | null;
  nichesUsed: number;
  // Account setup complete = API key saved on the Setup page.
  hasSetup: boolean;
  // BYO Anthropic key: saved, and whether it's actually switched on. A key
  // that exists but is off still bills Claude calls to KIE.
  hasAnthropicKey: boolean;
  anthropicDirect: boolean;
  planDefaultLimit: number | null;
  nicheLimitOverride: number | null;
  effectiveNicheLimit: number | null;
  // True when the user is an admin via the legacy hardcoded list OR
  // via app_metadata.is_admin set through the dashboard's "Make
  // admin" action. Surfaced by /api/admin/stats so the client doesn't
  // have to re-derive it from a hardcoded email comparison.
  isAdmin: boolean;
}

interface AdminProject {
  id: string;
  userEmail: string | null;
  channelName: string | null;
  selectedTopic: string | null;
  currentState: number;
  // True only when the final MP4 exists (or terminal state 16) — a
  // project resting at the Assemble step is NOT complete.
  isComplete: boolean;
  phaseLabel: string;
  phasePath: string;
  progress: number;
  createdAt: string;
  // When the video finished assembling. Null for incomplete projects
  // and completions that pre-date migration 049_assembly_timing.
  completedAt: string | null;
  // Wall-clock seconds between worker pickup and terminal status
  // (done/stopped/failed). Null when the project hasn't completed
  // an assembly yet, or pre-dates migration 049_assembly_timing.
  assembleSeconds: number | null;
  // Runtime of the finished video in seconds. Null for videos assembled
  // before migration 113 added the column.
  lengthSeconds: number | null;
}

// Per-project usage rollup returned by /api/admin/project-costs.
// One entry per project that has at least one logged cost row.
// Projects with no logged costs (e.g. pre-migration runs) simply
// don't appear and the UI renders "—" for every column.
type CostColumn =
  | "channel_analysis"
  | "topic"
  | "script"
  | "visuals"
  | "prompts"
  | "voiceover"
  | "generate"
  | "assemble"
  | "thumbnail";

interface CostBreakdownEntry {
  provider: string;
  model: string | null;
  unitKind: string;
  units: number;
}

interface CostColumnSummary {
  totals: Record<string, number>;
  breakdown: CostBreakdownEntry[];
}

interface ProjectCostsResponse {
  projects: Array<{
    projectId: string;
    columns: Record<CostColumn, CostColumnSummary>;
  }>;
}

interface QuotaEntry { units_used: number; date: string; }

interface ProductApiKey {
  id: string;
  service: string;
  label: string | null;
  keys: string[];
  current_index: number;
  quota_tracking: QuotaEntry[];
  active: boolean;
  created_at: string;
}

const SERVICES = ["youtube_data_api_key", "supadata_api_key", "heclus_kie_api_key", "anthropic_api_key", "genaipro_api_key"] as const;
type Service = typeof SERVICES[number];

const SERVICE_LABELS: Record<Service, string> = {
  youtube_data_api_key: "YouTube Data API Key",
  supadata_api_key: "Supadata API Key",
  heclus_kie_api_key: "Heclus KIE API Key",
  anthropic_api_key: "Anthropic API Key (direct)",
  genaipro_api_key: "GenAIPro API Key",
};

interface ActivityPoint {
  date: string;
  projects: number;
  videos: number;
  users: number;
}

// Hourly buckets for the Usage tab's "Today" range — see the comment on
// usageToday in /api/admin/stats. `hour` is a UTC "HH:00" label.
interface UsagePoint {
  hour: string;
  videos: number;
}

interface AdminStatsResponse {
  stats: AdminStats;
  activity: ActivityPoint[];
  activityMonthly: ActivityPoint[];
  usageToday: UsagePoint[];
  users: AdminUser[];
  projects: AdminProject[];
}

function StatCard({
  label,
  value,
  icon: Icon,
  accent,
  hint,
}: {
  label: string;
  value: number | undefined;
  icon: React.ElementType;
  accent?: "purple" | "green" | "amber";
  // Small muted line under the value — e.g. "62% of total", matching
  // the client dashboard's completed/in-progress cards.
  hint?: string;
}) {
  const valueColor = accent === "purple"
    ? "oklch(0.72 0.25 285)"
    : accent === "green"
    ? "oklch(0.65 0.15 145)"
    : accent === "amber"
    ? "oklch(0.72 0.18 65)"
    : "var(--c-90)";
  const iconBg = accent === "purple"
    ? "oklch(0.72 0.25 285 / 0.12)"
    : accent === "green"
    ? "oklch(0.55 0.15 145 / 0.12)"
    : accent === "amber"
    ? "oklch(0.72 0.18 65 / 0.12)"
    : "var(--bd-6)";
  const iconBorder = accent === "purple"
    ? "oklch(0.72 0.25 285 / 0.25)"
    : accent === "green"
    ? "oklch(0.55 0.15 145 / 0.25)"
    : accent === "amber"
    ? "oklch(0.72 0.18 65 / 0.25)"
    : "var(--bd-10)";
  const iconColor = accent === "purple"
    ? "oklch(0.72 0.25 285)"
    : accent === "green"
    ? "oklch(0.65 0.15 145)"
    : accent === "amber"
    ? "oklch(0.72 0.18 65)"
    : "var(--c-55)";

  return (
    <div className="p-6 rounded-2xl space-y-4"
      style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.06), 0 1px 3px oklch(0 0 0 / 0.04)" }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
          {label}
        </span>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: iconBg, border: `1px solid ${iconBorder}` }}>
          <Icon size={15} style={{ color: iconColor }} />
        </div>
      </div>
      <div>
        <div className="text-3xl font-black" style={{ color: valueColor }}>
          {value === undefined ? "—" : value.toLocaleString()}
        </div>
        {hint && (
          <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>{hint}</p>
        )}
      </div>
    </div>
  );
}

// ── Reports tab ──────────────────────────────────────────────────────
// One comprehensive read-only report composed from the data the
// dashboard already loads: activation funnel, growth, engagement,
// revenue, and pipeline health. All customer-only (admins and pending
// invites excluded), matching the rest of the dashboard's aggregates.
function ReportsSection({ stats, users, projects, revenue, activity }: {
  stats: AdminStats | undefined;
  users: AdminUser[];
  projects: AdminProject[];
  revenue: { totalCents: number; byPlan: Record<string, { cents: number; count: number }>; mrrCents: number; payingUserCount: number; launchedAt: string | null; daily?: { date: string; amountCents: number; count: number }[] } | undefined;
  activity: ActivityPoint[];
}) {
  const [salesHover, setSalesHover] = useState<number | null>(null);
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const customers = users.filter((u) => !u.isAdmin && u.status !== "Pending");
  const completedEmails = new Set(projects.filter((p) => p.isComplete && p.userEmail).map((p) => p.userEmail));

  // Activation funnel — each stage is a subset of the previous one in
  // product terms, so stage-to-stage conversion reads cleanly.
  const funnel = [
    { label: "Registered",        count: customers.length },
    { label: "Account setup",     count: customers.filter((u) => u.hasSetup).length },
    { label: "Created a niche",   count: customers.filter((u) => u.nichesUsed > 0).length },
    { label: "Completed a video", count: customers.filter((u) => completedEmails.has(u.email)).length },
  ];
  const paidCount = customers.filter((u) => u.status === "Paid").length;
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

  // Largest stage-to-stage drop, surfaced as the report's headline
  // insight — the place fixing which moves activation the most.
  let worstDrop = { from: "", to: "", lost: 0, pctLost: 0 };
  for (let i = 1; i < funnel.length; i++) {
    const lost = funnel[i - 1].count - funnel[i].count;
    const pctLost = pct(lost, funnel[i - 1].count);
    if (lost > worstDrop.lost) worstDrop = { from: funnel[i - 1].label, to: funnel[i].label, lost, pctLost };
  }

  const activeWithin = (days: number) =>
    customers.filter((u) => u.lastSignIn && now - new Date(u.lastSignIn).getTime() <= days * DAY).length;
  const active7 = activeWithin(7);
  const active30 = activeWithin(30);

  const sumActivity = (days: number, key: keyof ActivityPoint) =>
    activity.slice(-days).reduce((s, d) => s + (d[key] as number), 0);

  const inProgress = projects.filter((p) => !p.isComplete && p.currentState > 1);
  const stepFilters = PROJECT_STATUS_FILTERS.filter((f) =>
    ["channel", "topic", "script", "visuals", "prompts", "generate", "assemble", "thumbnail"].includes(f.id));
  const stepCounts = stepFilters
    .map((f) => ({ label: f.label.replace(/^At /, ""), count: projects.filter((p) => !p.isComplete && f.match(p)).length }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count);
  const maxStep = Math.max(...stepCounts.map((s) => s.count), 1);

  const assembleTimes = projects.map((p) => p.assembleSeconds).filter((s): s is number => s !== null).sort((a, b) => a - b);
  const median = assembleTimes.length ? assembleTimes[Math.floor(assembleTimes.length / 2)] : null;
  const fmtDur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

  const totalRevenue = (revenue?.totalCents ?? 0) / 100;
  const arpu = revenue?.payingUserCount ? totalRevenue / revenue.payingUserCount : 0;
  const completionRate = pct(stats?.completed ?? 0, stats?.totalProjects ?? 0);
  const PLAN_LABEL: Record<string, string> = { founder: "Founder", starter: "Starter", pro: "Pro" };

  // ── Sales activity (trailing 30 days) ────────────────────────────
  const daily = revenue?.daily ?? [];
  const sales7 = daily.slice(-7).reduce((s, d) => s + d.amountCents, 0) / 100;
  const salesPrev7 = daily.slice(-14, -7).reduce((s, d) => s + d.amountCents, 0) / 100;
  const sales7Count = daily.slice(-7).reduce((s, d) => s + d.count, 0);

  // ── Recommendations — rule-based, from the same data the report
  // shows, each tied to a concrete lever that exists in the product
  // (bulk-mail templates, pricing, funnel stages). ─────────────────
  const paidUsers = customers.filter((u) => u.status === "Paid");
  const paidNoSetup = paidUsers.filter((u) => !u.hasSetup).length;
  const paidNoNiche = paidUsers.filter((u) => u.hasSetup && u.nichesUsed === 0).length;
  const dormantPaid = paidUsers.filter((u) => !u.lastSignIn || now - new Date(u.lastSignIn).getTime() > 14 * DAY).length;
  const founderShare = pct(revenue?.byPlan?.founder?.cents ?? 0, revenue?.totalCents ?? 0);
  const engagedUnpaid = customers.filter((u) => u.status !== "Paid" && completedEmails.has(u.email)).length;
  const topStuck = stepCounts[0];

  const recommendations: { severity: "high" | "medium" | "info"; title: string; detail: string }[] = [];
  if (paidNoSetup > 0) recommendations.push({
    severity: "high",
    title: `${paidNoSetup} paying customer${paidNoSetup === 1 ? " is" : "s are"} unable to use the product (no account setup)`,
    detail: "They paid but never saved an API key, so nothing works for them — the top refund/churn risk. Send the “Paid: finish account setup” template from the Emails tab; it auto-targets exactly this audience.",
  });
  if (paidNoNiche > 0) recommendations.push({
    severity: "high",
    title: `${paidNoNiche} paying customer${paidNoNiche === 1 ? " has" : "s have"} set up but never created a niche`,
    detail: "Paying, ready to go, zero output — they won't renew without a first win. Send the “Paid: start first niche” template; it pitches the two-minute first run and offers niche suggestions by reply.",
  });
  if (salesPrev7 > 0 && sales7 === 0) recommendations.push({
    severity: "high",
    title: "No sales in the last 7 days",
    detail: `The prior week collected $${salesPrev7.toFixed(2)}. Re-ignite demand: push the Founder offer's scarcity (spots left) on your channels and send the Founder-offer template to engaged unpaid users.`,
  });
  else if (salesPrev7 > 0 && sales7 < salesPrev7 * 0.6) recommendations.push({
    severity: "medium",
    title: `Sales down ${Math.round((1 - sales7 / salesPrev7) * 100)}% week-over-week ($${sales7.toFixed(0)} vs $${salesPrev7.toFixed(0)})`,
    detail: "Momentum is cooling. The Founder offer converts best under scarcity — surface remaining spots in outreach, and target the re-engagement template at users with unfinished videos.",
  });
  if (worstDrop.lost > 0 && worstDrop.pctLost >= 30) recommendations.push({
    severity: "medium",
    title: `Funnel: ${worstDrop.pctLost}% of users stall between ${worstDrop.from} and ${worstDrop.to}`,
    detail: worstDrop.to === "Account setup"
      ? "Most signups never save an API key. Consider walking new users straight into Setup after signup, and mail the setup template to the “With no setup” bucket on the Users tab."
      : worstDrop.to === "Created a niche"
        ? "Users finish setup but never run a channel analysis. A first-run prompt (“paste any channel URL”) right after setup, plus the start-first-niche email, attacks this directly."
        : `Users create niches but don't reach a finished video${topStuck ? ` — most unfinished videos sit at ${topStuck.label} (${topStuck.count})` : ""}. Use the stuck-at-step support check-in emails; each reply is also product feedback on that step.`,
  });
  if (dormantPaid > 0) recommendations.push({
    severity: "medium",
    title: `${dormantPaid} paying customer${dormantPaid === 1 ? "" : "s"} inactive for 14+ days`,
    detail: "Silent churn in progress — they won't renew what they don't use. The re-engagement nudge template reminds them their work is saved exactly where they left off.",
  });
  if (founderShare >= 80 && (revenue?.totalCents ?? 0) > 0) recommendations.push({
    severity: "info",
    title: `${founderShare}% of revenue is the one-time Founder offer`,
    detail: "Recurring base is thin: when Founder sells out (or the year ends), revenue resets unless these users convert to monthly plans. Plan the founder-cohort renewal path early, and keep Starter/Pro visible in-product.",
  });
  if (engagedUnpaid > 0) recommendations.push({
    severity: "info",
    title: `${engagedUnpaid} engaged free user${engagedUnpaid === 1 ? " has" : "s have"} completed a video but never paid`,
    detail: "They've experienced the full value — the warmest upgrade prospects you have. A targeted Founder-offer email to this group should convert better than any cold channel.",
  });
  if (recommendations.length === 0) recommendations.push({
    severity: "info",
    title: "No major sales blockers detected",
    detail: "Funnel, engagement, and sales momentum all look healthy at current volume.",
  });
  const SEV_ORDER = { high: 0, medium: 1, info: 2 } as const;
  recommendations.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const SEV_TONE = {
    high:   { bg: "oklch(0.6 0.19 25 / 0.07)",  border: "oklch(0.6 0.19 25 / 0.3)",  chip: "oklch(0.55 0.19 25)",  label: "High impact" },
    medium: { bg: "oklch(0.72 0.18 65 / 0.08)", border: "oklch(0.72 0.18 65 / 0.3)", chip: "oklch(0.55 0.15 65)",  label: "Worth doing" },
    info:   { bg: "oklch(0.55 0.15 220 / 0.06)", border: "oklch(0.55 0.15 220 / 0.25)", chip: "oklch(0.5 0.13 220)", label: "Strategic" },
  } as const;

  // Sales chart geometry (same idiom as the Revenue tab's chart).
  const SW = 560, SPAD_L = 40, SPAD_R = 10, SPAD_T = 14, SPAD_B = 26, SH = 150;
  const splotW = SW - SPAD_L - SPAD_R, splotH = SH - SPAD_T - SPAD_B;
  const sn = daily.length;
  const smax = Math.max(...daily.map((d) => d.amountCents / 100), 1);
  const scs = daily.map((d, i) => ({
    x: SPAD_L + (sn <= 1 ? splotW / 2 : (i * splotW) / (sn - 1)),
    y: SPAD_T + (1 - d.amountCents / 100 / smax) * splotH,
  }));
  const sPath = scs.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const sArea = sn > 0
    ? `${sPath} L${scs[sn - 1].x.toFixed(1)},${(SPAD_T + splotH).toFixed(1)} L${scs[0].x.toFixed(1)},${(SPAD_T + splotH).toFixed(1)} Z`
    : "";

  const card = "p-4 rounded-2xl space-y-3";
  const cardStyle = { background: "oklch(0 0 0 / 0.015)", border: "1px solid oklch(0 0 0 / 0.07)" } as const;
  const h = "text-xs font-medium uppercase tracking-wider";
  const hStyle = { color: "oklch(0.5 0 0)" } as const;
  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span style={{ color: "var(--c-55)" }}>{label}</span>
      <span className="font-semibold tabular-nums" style={{ color: "var(--c-90)" }}>{value}</span>
    </div>
  );

  return (
    <section id="reports" className="rounded-2xl space-y-5"
      style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
      {/* Icon and title dropped: the page heading above already says Reports.
          The generated-on line stays — it dates the numbers below, which the
          page heading cannot know. */}
      <p className="text-xs" style={{ color: "var(--c-42)" }}>
        Generated {new Date().toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}
        {revenue?.launchedAt ? ` · data since launch (${new Date(revenue.launchedAt).toLocaleDateString("en", { month: "short", day: "numeric" })})` : ""}
        {" · customers only"}
      </p>

      {/* Headline numbers */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-[10px]">
        {[
          { label: "Users",            value: `${customers.length}` },
          { label: "Paying",           value: `${paidCount} (${pct(paidCount, customers.length)}%)` },
          { label: "Total revenue",    value: `$${totalRevenue.toFixed(0)}` },
          { label: "Videos completed", value: `${stats?.completed ?? 0}` },
          { label: "Completion rate",  value: `${completionRate}%` },
          { label: "Active (30d)",     value: `${active30} (${pct(active30, customers.length)}%)` },
        ].map((s) => (
          <div key={s.label} className="p-3 rounded-xl text-center" style={cardStyle}>
            <p className="text-[11px] uppercase tracking-wider mb-1" style={hStyle}>{s.label}</p>
            <p className="text-xl font-black tabular-nums" style={{ color: "var(--c-90)" }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Headline insight */}
      {worstDrop.lost > 0 && (
        <div className="rounded-xl px-4 py-3 text-sm"
          style={{ background: "oklch(0.6 0.19 25 / 0.07)", border: "1px solid oklch(0.6 0.19 25 / 0.25)", color: "oklch(0.45 0.15 25)" }}>
          Biggest funnel leak: <strong>{worstDrop.pctLost}%</strong> of users ({worstDrop.lost}) drop between{" "}
          <strong>{worstDrop.from}</strong> and <strong>{worstDrop.to}</strong>.
        </div>
      )}

      {/* Sales activity — daily revenue line, trailing 30 days */}
      <div className={card} style={cardStyle}>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className={h} style={hStyle}>Sales activity — last 30 days</p>
          <span className="text-xs" style={{ color: "var(--c-50)" }}>
            Last 7 days: <strong style={{ color: "oklch(0.72 0.18 65)" }}>${sales7.toFixed(2)}</strong> · {sales7Count} payment{sales7Count === 1 ? "" : "s"}
            {salesPrev7 > 0 && (
              <> · {sales7 >= salesPrev7 ? "+" : "−"}{Math.abs(Math.round(((sales7 - salesPrev7) / salesPrev7) * 100))}% vs prior week</>
            )}
          </span>
        </div>
        <div style={{ overflowX: "clip" }}>
          <svg viewBox={`0 0 ${SW} ${SH}`} className="w-full" style={{ height: 150 }}
            onMouseLeave={() => setSalesHover(null)}>
            <defs>
              <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--status-warn)" stopOpacity="0.25" />
                <stop offset="100%" stopColor="var(--status-warn)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 0.5, 1].map((t) => {
              const y = SPAD_T + (1 - t) * splotH;
              return (
                <g key={t}>
                  <line x1={SPAD_L} y1={y} x2={SW - SPAD_R} y2={y} strokeWidth="1" stroke="rgba(0,0,0,0.06)" />
                  <text x={SPAD_L - 4} y={y + 3.5} textAnchor="end" fontSize="8.5" fill="#999">${Math.round(smax * t)}</text>
                </g>
              );
            })}
            {sArea && <path d={sArea} fill="url(#salesGrad)" />}
            {sPath && <path d={sPath} fill="none" stroke="var(--status-warn)" strokeWidth="1.8" strokeLinejoin="round" />}
            {scs.map((c, i) => (
              <g key={i}>
                {/* invisible hover strip per day */}
                <rect x={c.x - splotW / Math.max(sn - 1, 1) / 2} y={0} width={splotW / Math.max(sn - 1, 1)} height={SH}
                  fill="transparent" onMouseEnter={() => setSalesHover(i)} />
                {daily[i].count > 0 && <circle cx={c.x} cy={c.y} r="2.4" fill="var(--status-warn)" />}
              </g>
            ))}
            {salesHover !== null && daily[salesHover] && (() => {
              const c = scs[salesHover];
              const d = daily[salesHover];
              const TX = Math.min(Math.max(c.x - 55, SPAD_L), SW - 120);
              return (
                <g pointerEvents="none">
                  <line x1={c.x} y1={SPAD_T} x2={c.x} y2={SPAD_T + splotH} stroke="rgba(0,0,0,0.15)" strokeWidth="1" />
                  <rect x={TX} y={SPAD_T} width="112" height="34" rx="6" fill="var(--bg-card)" stroke="rgba(0,0,0,0.12)" />
                  <text x={TX + 8} y={SPAD_T + 14} fontSize="9" fill="#666">
                    {new Date(d.date + "T00:00:00Z").toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" })}
                  </text>
                  <text x={TX + 8} y={SPAD_T + 27} fontSize="9.5" fill="#666">
                    <tspan fill="var(--status-warn)" fontWeight="700">${(d.amountCents / 100).toFixed(2)}</tspan>
                    {" · "}{d.count} payment{d.count === 1 ? "" : "s"}
                  </text>
                </g>
              );
            })()}
            {daily.map((d, i) => i % 5 === 0 && (
              <text key={d.date} x={scs[i].x} y={SH - 4} textAnchor="middle" fontSize="8.5" fill="#999">
                {new Date(d.date + "T00:00:00Z").toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" })}
              </text>
            ))}
          </svg>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Activation funnel */}
        <div className={card} style={cardStyle}>
          <p className={h} style={hStyle}>Activation funnel</p>
          <div className="space-y-2">
            {funnel.map((f, i) => (
              <div key={f.label}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span style={{ color: "var(--c-70)" }}>{f.label}</span>
                  <span className="tabular-nums font-semibold" style={{ color: "var(--c-90)" }}>
                    {f.count}
                    <span className="font-normal text-xs" style={{ color: "var(--c-45)" }}>
                      {" "}· {pct(f.count, customers.length)}% of users{i > 0 ? ` · ${pct(f.count, funnel[i - 1].count)}% of prev` : ""}
                    </span>
                  </span>
                </div>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: "oklch(0 0 0 / 0.05)" }}>
                  <div className="h-full rounded-full" style={{ width: `${pct(f.count, customers.length)}%`, background: "oklch(0.72 0.25 285)" }} />
                </div>
              </div>
            ))}
          </div>
          <Row label="Paid conversion (of all users)" value={`${paidCount} · ${pct(paidCount, customers.length)}%`} />
        </div>

        {/* Revenue */}
        <div className={card} style={cardStyle}>
          <p className={h} style={hStyle}>Revenue</p>
          <Row label="Total collected" value={`$${totalRevenue.toFixed(2)}`} />
          {(["founder", "starter", "pro"] as const).map((p) => (
            <Row key={p} label={`— ${PLAN_LABEL[p]}`}
              value={`$${((revenue?.byPlan?.[p]?.cents ?? 0) / 100).toFixed(2)} · ${revenue?.byPlan?.[p]?.count ?? 0} payment${(revenue?.byPlan?.[p]?.count ?? 0) === 1 ? "" : "s"}`} />
          ))}
          <Row label="Collected last 30 days" value={`$${((revenue?.mrrCents ?? 0) / 100).toFixed(2)}`} />
          <Row label="Paying users (ledger)" value={`${revenue?.payingUserCount ?? 0}`} />
          <Row label="Avg revenue / paying user" value={`$${arpu.toFixed(2)}`} />
        </div>

        {/* Growth & engagement */}
        <div className={card} style={cardStyle}>
          <p className={h} style={hStyle}>Growth &amp; engagement</p>
          <Row label="New users (7d / 30d)" value={`${sumActivity(7, "users")} / ${sumActivity(30, "users")}`} />
          <Row label="Niches created (7d / 30d)" value={`${sumActivity(7, "projects")} / ${sumActivity(30, "projects")}`} />
          <Row label="Videos completed (7d / 30d)" value={`${sumActivity(7, "videos")} / ${sumActivity(30, "videos")}`} />
          <Row label="Active users (7d)" value={`${active7} · ${pct(active7, customers.length)}%`} />
          <Row label="Active users (30d)" value={`${active30} · ${pct(active30, customers.length)}%`} />
          <Row label="Dormant (30d+)" value={`${customers.length - active30} · ${pct(customers.length - active30, customers.length)}%`} />
        </div>

        {/* Pipeline health */}
        <div className={card} style={cardStyle}>
          <p className={h} style={hStyle}>Pipeline health</p>
          <Row label="Videos total / completed / in progress"
            value={`${stats?.totalProjects ?? 0} / ${stats?.completed ?? 0} / ${stats?.videosInProgress ?? 0}`} />
          {median !== null && <Row label="Median assembly time" value={fmtDur(median)} />}
          {stepCounts.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <p className="text-[11px] uppercase tracking-wider" style={hStyle}>Unfinished videos by step ({inProgress.length})</p>
              {stepCounts.map((s) => (
                <div key={s.label} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0" style={{ color: "var(--c-55)" }}>{s.label}</span>
                  <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "oklch(0 0 0 / 0.05)" }}>
                    <div className="h-full rounded-full" style={{ width: `${Math.round((s.count / maxStep) * 100)}%`, background: "oklch(0.72 0.18 65)" }} />
                  </div>
                  <span className="tabular-nums font-semibold w-6 text-right" style={{ color: "var(--c-90)" }}>{s.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recommendations — kept last so the report reads data first,
          conclusions after. */}
      <div className={card} style={cardStyle}>
        <p className={h} style={hStyle}>Recommendations — issues affecting sales</p>
        <div className="space-y-2">
          {recommendations.map((r) => {
            const tone = SEV_TONE[r.severity];
            return (
              <div key={r.title} className="rounded-xl px-4 py-3"
                style={{ background: tone.bg, border: `1px solid ${tone.border}` }}>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                    style={{ background: "var(--bg-card)", color: tone.chip, border: `1px solid ${tone.border}` }}>
                    {tone.label}
                  </span>
                  <p className="text-sm font-semibold" style={{ color: "var(--c-90)" }}>{r.title}</p>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: "var(--c-55)" }}>{r.detail}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function AddUserForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await fetch("/api/auth/add-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add user");
      toast.success(`Access granted to ${email}`);
      setEmail("");
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add user");
    } finally {
      setAdding(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="p-5 rounded-2xl space-y-3 w-full"
      style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
      <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Email address</label>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="user@example.com"
          className="w-full sm:flex-1 min-w-0 px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
          style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
        />
        <button
          type="submit"
          disabled={adding}
          className="shrink-0 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2 whitespace-nowrap"
          style={{ background: "oklch(0.52 0.20 145)", color: "white" }}
        >
          <UserPlus size={14} />
          {adding ? "Adding…" : "Grant Access"}
        </button>
      </div>
    </form>
  );
}

type LogSubTab = "activity" | "errors" | "worker";

interface ActivityEvent {
  id: string;
  timestamp: string;
  type: "signup" | "niche_created" | "video_completed" | "video_failed" | "founder_claim" | "subscription";
  actor_email: string | null;
  actor_user_id: string | null;
  details?: Record<string, unknown>;
}
interface ErrorEvent {
  id: string;
  timestamp: string;
  source: string;
  level: string;
  message: string;
  user_id: string | null;
  user_email: string | null;
  project_id: string | null;
}
interface WorkerEvent {
  id: string;
  timestamp: string;
  level: "error" | "warn" | "info";
  source: string;
  message: string;
}

const ACTIVITY_LABEL: Record<ActivityEvent["type"], string> = {
  signup: "Signed up",
  niche_created: "Created niche",
  video_completed: "Video completed",
  video_failed: "Video failed",
  founder_claim: "Founder claim",
  subscription: "Subscribed",
};

const ACTIVITY_FG: Record<ActivityEvent["type"], string> = {
  signup:          "oklch(0.55 0.15 220)",
  niche_created:   "oklch(0.72 0.25 285)",
  video_completed: "oklch(0.55 0.15 145)",
  video_failed:    "oklch(0.65 0.22 25)",
  founder_claim:   "oklch(0.72 0.18 65)",
  subscription:    "oklch(0.55 0.15 145)",
};
const ACTIVITY_BG: Record<ActivityEvent["type"], string> = {
  signup:          "oklch(0.55 0.15 220 / 0.12)",
  niche_created:   "oklch(0.72 0.25 285 / 0.12)",
  video_completed: "oklch(0.55 0.15 145 / 0.12)",
  video_failed:    "oklch(0.65 0.22 25 / 0.12)",
  founder_claim:   "oklch(0.72 0.18 65 / 0.12)",
  subscription:    "oklch(0.55 0.15 145 / 0.12)",
};

function LogsSection() {
  const [logTab, setLogTab] = usePersistentTab<LogSubTab>(
    "logs", "activity", ["activity", "errors", "worker"],
  );
  const { data, isLoading } = useSWR<{ events: (ActivityEvent | ErrorEvent | WorkerEvent)[]; notice?: string }>(
    `/api/admin/logs?type=${logTab}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  const events = data?.events ?? [];

  const subTabs: { id: LogSubTab; label: string; icon: typeof Activity }[] = [
    { id: "activity", label: "Activity", icon: Activity },
    { id: "errors",   label: "Errors",   icon: AlertCircle },
    { id: "worker",   label: "Worker",   icon: Server },
  ];

  return (
    <section id="logs" className="rounded-2xl space-y-4"
      style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
      <div className="flex items-center gap-1 p-1 rounded-xl w-full sm:w-auto sm:inline-flex"
        style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)" }}>
        {subTabs.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setLogTab(id)}
            className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer"
            style={logTab === id
              ? { background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.35)" }
              : { color: "oklch(0.50 0 0)" }}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {data?.notice && (
        <p className="text-xs italic px-3 py-2 rounded-lg" style={{ color: "var(--c-42)", background: "oklch(0 0 0 / 0.03)", border: "1px solid oklch(0 0 0 / 0.06)" }}>
          {data.notice}
        </p>
      )}

      {isLoading ? (
        <SkeletonRows cols={4} rows={6} />
      ) : events.length === 0 ? (
        <p className="text-xs italic px-3 py-6 text-center" style={{ color: "var(--c-35)" }}>
          No {logTab === "activity" ? "activity" : logTab === "errors" ? "errors" : "worker events"} yet.
        </p>
      ) : logTab === "errors" ? (
        <div className="space-y-2">
          {(events as ErrorEvent[]).map((e) => <ErrorRow key={e.id} event={e} />)}
        </div>
      ) : logTab === "worker" ? (
        <div className="space-y-2">
          {(events as WorkerEvent[]).map((e) => <WorkerRow key={e.id} event={e} />)}
        </div>
      ) : (
        <div className="space-y-2">
          {(events as ActivityEvent[]).map((e) => <ActivityRow key={e.id} event={e} />)}
        </div>
      )}
    </section>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const fg = ACTIVITY_FG[event.type] ?? "oklch(0.55 0 0)";
  const bg = ACTIVITY_BG[event.type] ?? "oklch(0 0 0 / 0.06)";
  const label = ACTIVITY_LABEL[event.type] ?? event.type;
  const summary = (() => {
    if (event.type === "niche_created") {
      const d = event.details as { channel_name?: string; topic?: string } | undefined;
      return [d?.channel_name, d?.topic && `"${d.topic}"`].filter(Boolean).join(" · ");
    }
    if (event.type === "video_completed" || event.type === "video_failed") {
      const d = event.details as { topic?: string; channel_name?: string } | undefined;
      return d?.topic ?? d?.channel_name ?? "";
    }
    if (event.type === "subscription") {
      const d = event.details as { plan?: string } | undefined;
      return d?.plan ? `${d.plan} plan` : "";
    }
    if (event.type === "founder_claim") return "Founder plan";
    return "";
  })();

  return (
    <div className="flex items-start gap-3 px-3 py-2 rounded-xl"
      style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid oklch(0 0 0 / 0.05)" }}>
      <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 mt-0.5"
        style={{ background: bg, color: fg }}>
        {label}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate" style={{ color: "var(--c-65)" }}>
          {event.actor_email ?? "Unknown user"}
          {summary && <span style={{ color: "var(--c-42)" }}> — {summary}</span>}
        </p>
      </div>
      <span className="text-xs shrink-0 tabular-nums" style={{ color: "var(--c-42)" }}>
        {timeAgo(event.timestamp)}
      </span>
    </div>
  );
}

function WorkerRow({ event }: { event: WorkerEvent }) {
  const tone = event.level === "error"
    ? { fg: "oklch(0.65 0.22 25)",  bg: "oklch(0.6 0.22 25 / 0.12)",  border: "oklch(0.6 0.22 25 / 0.15)" }
    : event.level === "warn"
    ? { fg: "oklch(0.65 0.18 65)",  bg: "oklch(0.72 0.18 65 / 0.12)", border: "oklch(0.72 0.18 65 / 0.15)" }
    : { fg: "oklch(0.50 0 0)",      bg: "oklch(0 0 0 / 0.05)",        border: "oklch(0 0 0 / 0.06)" };
  return (
    <div className="flex items-start gap-3 px-3 py-2 rounded-xl"
      style={{ background: "oklch(0 0 0 / 0.02)", border: `1px solid ${tone.border}` }}>
      <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 mt-0.5"
        style={{ background: tone.bg, color: tone.fg }}>
        {event.source}
      </span>
      <p className="flex-1 text-sm font-mono break-words" style={{ color: "var(--c-65)" }}>{event.message}</p>
      <span className="text-xs shrink-0 tabular-nums" style={{ color: "var(--c-42)" }}>
        {timeAgo(event.timestamp)}
      </span>
    </div>
  );
}

function ErrorRow({ event }: { event: ErrorEvent }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2 rounded-xl"
      style={{ background: "oklch(0.6 0.22 25 / 0.04)", border: "1px solid oklch(0.6 0.22 25 / 0.15)" }}>
      <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 mt-0.5"
        style={{ background: "oklch(0.6 0.22 25 / 0.12)", color: "oklch(0.65 0.22 25)" }}>
        {event.source}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm" style={{ color: "var(--c-65)" }}>{event.message}</p>
        {event.user_email && (
          <p className="text-xs mt-0.5" style={{ color: "var(--c-42)" }}>{event.user_email}</p>
        )}
      </div>
      <span className="text-xs shrink-0 tabular-nums" style={{ color: "var(--c-42)" }}>
        {timeAgo(event.timestamp)}
      </span>
    </div>
  );
}

function SetupSection({
  productKeys,
  keysLoading,
  mutateKeys,
}: {
  productKeys: ProductApiKey[];
  keysLoading: boolean;
  mutateKeys: () => void;
}) {
  const [setupTab, setSetupTab] = usePersistentTab<"keys" | "models" | "anthropic" | "concurrency" | "plans" | "quotas">(
    "config", "keys", ["keys", "models", "anthropic", "concurrency", "plans", "quotas"],
  );
  const [serviceInput, setServiceInput] = useState<Service>("youtube_data_api_key");
  const [keyInput, setKeyInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null); // "rowId:index"
  // Pending delete-key confirmation. When set, the Dialog at the bottom
  // of SetupSection renders; the actual handleRemoveKey only fires
  // after the admin confirms in the dialog.
  const [removeKeyTarget, setRemoveKeyTarget] = useState<{ rowId: string; index: number; serviceLabel: string; maskedKey: string } | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null); // "rowId:index"
  const [editValue, setEditValue] = useState("");
  const [savingEdit, setSavingEdit] = useState<string | null>(null); // "rowId:index"
  const [openMenuTag, setOpenMenuTag] = useState<string | null>(null); // "rowId:index"

  // Close the per-row menu on outside click / Escape so it behaves like a
  // normal popover without dragging in a heavier dropdown primitive.
  useEffect(() => {
    if (!openMenuTag) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-key-menu]")) return;
      setOpenMenuTag(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenMenuTag(null);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenuTag]);

  // Live Supadata account usage — there's only one key + the billing
  // model is account-wide credits (not per-key daily quota), so we just
  // query Supadata's /v1/me endpoint once for the whole row.
  const { data: supadataStatus } = useSWR<{ plan: string; usedCredits: number; maxCredits: number; error?: string }>(
    "/api/admin/supadata-status",
    fetcher,
    { revalidateOnFocus: false }
  );

  const serviceMap = new Map(productKeys.map(k => [k.service, k]));
  const totalKeys = productKeys.reduce((s, k) => s + k.keys.length, 0);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await fetch("/api/admin/product-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: serviceInput, key: keyInput }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Failed to add key");
      toast.success("API key added");
      setKeyInput("");
      mutateKeys();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add key");
    } finally {
      setAdding(false);
    }
  }

  async function handleSaveEdit(rowId: string, keyIndex: number) {
    const tag = `${rowId}:${keyIndex}`;
    const trimmed = editValue.trim();
    if (!trimmed) {
      toast.error("Key can't be empty");
      return;
    }
    setSavingEdit(tag);
    try {
      const res = await fetch(`/api/admin/product-keys/${rowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editKeyIndex: keyIndex, newKey: trimmed }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed to save key");
      toast.success("Key updated");
      setEditingKey(null);
      setEditValue("");
      mutateKeys();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setSavingEdit(null);
    }
  }

  async function handleRemoveKey(rowId: string, keyIndex: number) {
    const tag = `${rowId}:${keyIndex}`;
    setRemovingKey(tag);
    try {
      const res = await fetch(`/api/admin/product-keys/${rowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeKeyIndex: keyIndex }),
      });
      if (!res.ok) throw new Error("Failed to remove key");
      toast.success("Key removed");
      mutateKeys();
    } catch {
      toast.error("Failed to remove key");
    } finally {
      setRemovingKey(null);
    }
  }

  async function handleToggle(k: ProductApiKey) {
    setTogglingId(k.id);
    try {
      const res = await fetch(`/api/admin/product-keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !k.active }),
      });
      if (!res.ok) throw new Error("Failed to update");
      mutateKeys();
    } catch {
      toast.error("Failed to update");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleResetIndex(k: ProductApiKey) {
    setResettingId(k.id);
    try {
      const res = await fetch(`/api/admin/product-keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetIndex: true }),
      });
      if (!res.ok) throw new Error("Failed to reset");
      toast.success("Reset to first key");
      mutateKeys();
    } catch {
      toast.error("Failed to reset");
    } finally {
      setResettingId(null);
    }
  }

  const inputStyle = { background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" };
  const inputFocus = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = "oklch(0.62 0.15 220 / 0.5)";
  };
  const inputBlur = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = "var(--bd-10)";
  };

  return (
    <section id="setup" className="rounded-2xl space-y-5" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
      <div className="flex items-center gap-3">
        <div>
          <p className="text-xs" style={{ color: "var(--c-42)" }}>Product-wide API keys — first key is default, auto-rotates on quota exceeded</p>
        </div>
        {setupTab === "keys" && (
          <span className="ml-auto text-xs px-2.5 py-0.5 rounded-full"
            style={{ background: "var(--bg-elevated)", border: "1px solid oklch(1 0 0 / 0.06)", color: "var(--c-42)" }}>
            {totalKeys} key{totalKeys !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl" style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.06)" }}>
        {([
          { id: "keys", label: "API Keys" },
          { id: "models", label: "Models" },
          { id: "anthropic", label: "Anthropic" },
          { id: "concurrency", label: "Batched process" },
          { id: "plans", label: "Payment" },
          { id: "quotas", label: "Quotas" },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setSetupTab(t.id)}
            className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer"
            style={setupTab === t.id ? {
              background: "var(--bg-card)",
              color: "oklch(0.62 0.15 220)",
              boxShadow: "0 1px 3px oklch(0 0 0 / 0.06)",
            } : {
              background: "transparent",
              color: "var(--c-50)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {setupTab === "models" && <ModelDefaultsPanel />}
      {setupTab === "anthropic" && <AnthropicRoutingPanel />}
      {setupTab === "concurrency" && <ConcurrencyPanel />}
      {setupTab === "plans" && <PlansPanel />}
      {setupTab === "quotas" && <QuotasPanel />}

      {setupTab === "keys" && <>

      {/* Add key form */}
      <form onSubmit={handleAdd} className="p-4 rounded-2xl space-y-3"
        style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid oklch(0 0 0 / 0.07)" }}>
        <p className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Add API Key</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <select
            value={serviceInput}
            onChange={(e) => setServiceInput(e.target.value as Service)}
            className="sm:w-48 px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
            style={inputStyle}
            onFocus={inputFocus}
            onBlur={inputBlur}
          >
            {SERVICES.map(s => <option key={s} value={s}>{SERVICE_LABELS[s]}</option>)}
          </select>
          <input
            type="text"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            required
            placeholder="Paste API key…"
            className="flex-1 px-3 py-2.5 rounded-lg text-sm outline-none transition-all font-mono"
            style={inputStyle}
            onFocus={inputFocus}
            onBlur={inputBlur}
          />
          <button
            type="submit"
            disabled={adding}
            className="px-4 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer flex items-center justify-center gap-2 shrink-0"
            style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
          >
            <UserPlus size={14} />
            {adding ? "Adding…" : "Add Key"}
          </button>
        </div>
      </form>

      {/* Per-service key cards */}
      {keysLoading ? (
        <SkeletonRows cols={4} rows={2} />
      ) : (
        // space-y-6: each service is its own card with an internal header and
        // key rows, so 16px read as part of the card above it.
        <div className="space-y-6">
          {SERVICES.map(service => {
            const row = serviceMap.get(service);
            return (
              <div key={service} className="rounded-2xl overflow-hidden"
                style={{ border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 8px oklch(0 0 0 / 0.04)" }}>
                {/* Service header */}
                <div className="flex items-center gap-3 px-4 py-3"
                  style={{ background: "oklch(0 0 0 / 0.025)", borderBottom: row && row.keys.length > 0 ? "1px solid oklch(0 0 0 / 0.06)" : "none" }}>
                  <span className="text-xs font-semibold tracking-wide" style={{ color: "oklch(0.62 0.15 220)" }}>
                    {SERVICE_LABELS[service]}
                  </span>
                  {row && service !== "supadata_api_key" && (
                    <span className="text-xs px-2 py-0.5 rounded-full ml-1"
                      style={{ background: "oklch(0 0 0 / 0.05)", color: "var(--c-42)" }}>
                      {row.keys.length} key{row.keys.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {row && row.current_index > 0 && (
                      <button
                        onClick={() => handleResetIndex(row)}
                        disabled={resettingId === row.id}
                        className="text-xs px-2.5 py-1 rounded-lg transition-all hover:opacity-80 disabled:opacity-40 cursor-pointer"
                        style={{ background: "oklch(0.72 0.25 285 / 0.1)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}>
                        {resettingId === row.id ? "…" : "↺ Reset to #1"}
                      </button>
                    )}
                    {row && (
                      <button
                        onClick={() => handleToggle(row)}
                        disabled={togglingId === row.id}
                        className="text-xs px-2.5 py-1 rounded-full font-medium transition-all hover:opacity-80 cursor-pointer disabled:opacity-50"
                        style={row.active ? {
                          background: "oklch(0.55 0.15 145 / 0.15)",
                          color: "oklch(0.65 0.15 145)",
                          border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                        } : {
                          background: "oklch(0.6 0.22 25 / 0.1)",
                          color: "oklch(0.65 0.22 25)",
                          border: "1px solid oklch(0.6 0.22 25 / 0.2)",
                        }}>
                        {togglingId === row.id ? "…" : row.active ? "Active" : "Disabled"}
                      </button>
                    )}
                  </div>
                </div>

                {/* Supadata account usage — fetched live from /v1/me */}
                {service === "supadata_api_key" && supadataStatus && !supadataStatus.error && (() => {
                  const used = supadataStatus.usedCredits;
                  const max = supadataStatus.maxCredits || 1;
                  const pct = Math.min(100, (used / max) * 100);
                  const barColor = "oklch(0.55 0.15 145)";
                  const remaining = Math.max(0, max - used);
                  return (
                    <div className="px-4 py-3 space-y-2"
                      style={{ background: "oklch(0 0 0 / 0.015)", borderBottom: row && row.keys.length > 0 ? "1px solid oklch(0 0 0 / 0.05)" : "none" }}>
                      <div className="flex items-center justify-between text-xs">
                        <span style={{ color: "var(--c-42)" }}>Account usage</span>
                        <span style={{ color: "var(--c-42)" }}>
                          Plan:{" "}
                          <span className="font-semibold" style={{ color: "oklch(0.62 0.15 220)" }}>{supadataStatus.plan}</span>
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "oklch(0 0 0 / 0.08)" }}>
                          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: barColor }} />
                        </div>
                        <span className="text-xs shrink-0 tabular-nums" style={{ color: "var(--c-42)", minWidth: 140, textAlign: "right" }}>
                          {used.toLocaleString()} / {max.toLocaleString()} credits
                        </span>
                        <span className="text-xs shrink-0 font-medium tabular-nums" style={{ color: barColor, minWidth: 80, textAlign: "right" }}>
                          {remaining.toLocaleString()} left
                        </span>
                      </div>
                    </div>
                  );
                })()}

                {/* Keys list */}
                {!row || row.keys.length === 0 ? (
                  service === "supadata_api_key" ? null : (
                    <p className="text-xs italic px-4 py-3" style={{ color: "var(--c-35)" }}>No keys yet — add one above.</p>
                  )
                ) : (
                  <div>
                    {row.keys.map((k, i) => {
                      const isCurrent = i === (row.current_index ?? 0);
                      const isExhausted = i < (row.current_index ?? 0);
                      const tag = `${row.id}:${i}`;

                      // Quota for this key (reset if date isn't today)
                      const today = new Date().toISOString().slice(0, 10);
                      const tracking = (row.quota_tracking ?? [])[i];
                      const unitsUsed = (tracking?.date === today ? tracking.units_used : 0);
                      const pct = Math.min(100, (unitsUsed / 10_000) * 100);
                      const barColor = "oklch(0.55 0.15 145)";
                      const remaining = Math.max(0, 10_000 - unitsUsed);

                      return (
                        <div key={i}
                          className="px-4 py-3 space-y-2"
                          style={{
                            borderBottom: i < row.keys.length - 1 ? "1px solid oklch(0 0 0 / 0.05)" : "none",
                            background: isCurrent ? "oklch(0.55 0.15 145 / 0.03)" : "transparent",
                          }}>
                          {/* Key row */}
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-mono w-5 text-right shrink-0" style={{ color: "var(--c-35)" }}>
                              #{i + 1}
                            </span>
                            {isCurrent && (
                              <span className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0"
                                style={{ background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.3)" }}>
                                Current
                              </span>
                            )}
                            {isExhausted && (
                              <span className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0"
                                style={{ background: "oklch(0.6 0.22 25 / 0.08)", color: "oklch(0.65 0.22 25)", border: "1px solid oklch(0.6 0.22 25 / 0.15)" }}>
                                Exhausted
                              </span>
                            )}
                            {!isCurrent && !isExhausted && (
                              <span className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0"
                                style={{ background: "oklch(0 0 0 / 0.05)", color: "var(--c-40)", border: "1px solid oklch(0 0 0 / 0.08)" }}>
                                Standby
                              </span>
                            )}
                            {editingKey === tag ? (
                              <>
                                <input
                                  type="text"
                                  autoFocus
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleSaveEdit(row.id, i);
                                    else if (e.key === "Escape") { setEditingKey(null); setEditValue(""); }
                                  }}
                                  disabled={savingEdit === tag}
                                  className="flex-1 text-sm font-mono px-2 py-1 rounded-md outline-none"
                                  style={{ background: "var(--bg-card)", border: "1px solid oklch(0.62 0.15 220 / 0.4)", color: "oklch(0.2 0 0)" }}
                                />
                                <button
                                  onClick={() => handleSaveEdit(row.id, i)}
                                  disabled={savingEdit === tag || !editValue.trim()}
                                  className="text-xs px-2 py-1 rounded-lg transition-all hover:opacity-80 disabled:opacity-40 cursor-pointer shrink-0 flex items-center gap-1"
                                  style={{ background: "oklch(0.55 0.15 145 / 0.12)", color: "oklch(0.5 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }}>
                                  {savingEdit === tag ? <Spinner size={11} /> : "Save"}
                                </button>
                                <button
                                  onClick={() => { setEditingKey(null); setEditValue(""); }}
                                  disabled={savingEdit === tag}
                                  className="text-xs px-2 py-1 rounded-lg transition-all hover:opacity-80 disabled:opacity-40 cursor-pointer shrink-0"
                                  style={{ background: "oklch(0 0 0 / 0.05)", color: "var(--c-50)", border: "1px solid oklch(0 0 0 / 0.08)" }}>
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <span className="flex-1 text-sm font-mono truncate" style={{ color: "var(--c-55)", letterSpacing: "0.02em" }}>
                                  {maskKey(k)}
                                </span>
                                <div className="relative shrink-0" data-key-menu>
                                  <button
                                    onClick={() => setOpenMenuTag(openMenuTag === tag ? null : tag)}
                                    disabled={removingKey === tag}
                                    aria-label="Key actions"
                                    aria-haspopup="menu"
                                    aria-expanded={openMenuTag === tag}
                                    className="p-1.5 rounded-lg transition-all hover:bg-black/5 disabled:opacity-40 cursor-pointer flex items-center justify-center"
                                    style={{ color: "var(--c-50)" }}>
                                    {removingKey === tag ? <Spinner size={14} /> : <MoreVertical size={16} />}
                                  </button>
                                  {openMenuTag === tag && (
                                    <div
                                      role="menu"
                                      className="absolute right-0 top-full mt-1 z-20 min-w-[140px] rounded-lg overflow-hidden py-1"
                                      style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.08)", boxShadow: "0 8px 24px oklch(0 0 0 / 0.12)" }}>
                                      <button
                                        role="menuitem"
                                        onClick={() => { setOpenMenuTag(null); setEditingKey(tag); setEditValue(k); }}
                                        className="w-full flex items-center gap-2 px-3 py-2 text-sm transition-all hover:bg-black/5 cursor-pointer"
                                        style={{ color: "oklch(0.3 0 0)" }}>
                                        <Pencil size={13} /> Edit
                                      </button>
                                      <button
                                        role="menuitem"
                                        onClick={() => {
                                          setOpenMenuTag(null);
                                          setRemoveKeyTarget({
                                            rowId: row.id,
                                            index: i,
                                            serviceLabel: SERVICE_LABELS[service],
                                            maskedKey: maskKey(k),
                                          });
                                        }}
                                        className="w-full flex items-center gap-2 px-3 py-2 text-sm transition-all hover:bg-black/5 cursor-pointer"
                                        style={{ color: "oklch(0.6 0.22 25)" }}>
                                        <Trash2 size={13} /> Delete
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </>
                            )}
                          </div>

                          {/* Quota bar */}
                          <div className="flex items-center gap-2 pl-8">
                            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "oklch(0 0 0 / 0.08)" }}>
                              <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: barColor }} />
                            </div>
                            <span className="text-xs shrink-0 tabular-nums" style={{ color: "var(--c-42)", minWidth: 120, textAlign: "right" }}>
                              {unitsUsed.toLocaleString()} / 10,000 units
                            </span>
                            <span className="text-xs shrink-0 font-medium" style={{ color: barColor, minWidth: 80, textAlign: "right" }}>
                              ~{remaining.toLocaleString()} left
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      </>}

      {removeKeyTarget && (
        <Dialog open onOpenChange={(open) => {
          if (!open && removingKey === null) setRemoveKeyTarget(null);
        }}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Delete API key?</DialogTitle>
              <DialogDescription>
                Permanently remove this <span className="font-semibold">{removeKeyTarget.serviceLabel}</span> key. The change applies immediately and can&apos;t be undone from this UI.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg p-3 bg-zinc-50 ring-1 ring-zinc-200">
              <p className="text-xs font-mono text-zinc-700 truncate">{removeKeyTarget.maskedKey}</p>
            </div>
            <DialogFooter>
              <button
                onClick={async () => {
                  const target = removeKeyTarget;
                  await handleRemoveKey(target.rowId, target.index);
                  setRemoveKeyTarget(null);
                }}
                disabled={removingKey !== null}
                className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 bg-red-600 text-white"
              >
                {removingKey !== null ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <Spinner size={14} className="text-white" />
                    Deleting…
                  </span>
                ) : "Delete key"}
              </button>
              <button
                onClick={() => setRemoveKeyTarget(null)}
                disabled={removingKey !== null}
                className="flex-1 py-2 rounded-xl text-sm font-medium transition-all bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-40"
              >
                Cancel
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function ModelDefaultsPanel() {
  const { data: defaults, mutate: mutateDefaults, isLoading: defaultsLoading } = useSWR<{
    default_image_model: string | null;
    default_video_model: string | null;
  }>("/api/admin/default-models", fetcher, { revalidateOnFocus: false });
  const { data: imageModels } = useSWR<{ id: string; name: string }[]>("/api/kie/models?type=image", fetcher);
  // Tags come through so the free-tier model can be excluded: making a
  // Heclus-funded model the platform default would have every eligible user
  // spending free credits by default, which is a cost decision rather than a
  // default. It stays selectable per project from the picker's Free tab.
  const { data: rawVideoModels } = useSWR<{ id: string; name: string; tags?: string[] }[]>("/api/kie/models?type=video", fetcher);
  const videoModels = rawVideoModels ? paidModelsOnly(rawVideoModels) : rawVideoModels;

  const [imageSel, setImageSel] = useState<string>("");
  const [videoSel, setVideoSel] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // Hydrate selections from server. We only run this when defaults arrive
  // so a quick "save → revalidate" round-trip doesn't clobber the user's
  // unsaved pick (mid-edit revalidation race).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!defaults || hydratedRef.current) return;
    hydratedRef.current = true;
    setImageSel(defaults.default_image_model ?? "");
    setVideoSel(defaults.default_video_model ?? "");
  }, [defaults]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/default-models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          default_image_model: imageSel || null,
          default_video_model: videoSel || null,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed to save");
      }
      toast.success("Default models saved");
      mutateDefaults();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const selectStyle = {
    background: "var(--bg-input)",
    border: "1px solid var(--bd-10)",
    color: "var(--c-90)",
  } as const;

  const dirty =
    (defaults?.default_image_model ?? "") !== imageSel ||
    (defaults?.default_video_model ?? "") !== videoSel;

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--c-50)" }}>
        Set the models that show up first in the generate page&apos;s model picker. Users can still change them per-project.
      </p>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold" style={{ color: "var(--c-50)" }}>Default Image Model</label>
          <select
            value={imageSel}
            onChange={(e) => setImageSel(e.target.value)}
            disabled={defaultsLoading || !imageModels}
            className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
            style={selectStyle}
          >
            <option value="">— No default (use catalog order) —</option>
            {(imageModels ?? []).map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold" style={{ color: "var(--c-50)" }}>Default Video Model</label>
          <select
            value={videoSel}
            onChange={(e) => setVideoSel(e.target.value)}
            disabled={defaultsLoading || !videoModels}
            className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
            style={selectStyle}
          >
            <option value="">— No default (use catalog order) —</option>
            {(videoModels ?? []).map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      </div>

      <button
        onClick={save}
        disabled={saving || !dirty}
        className="px-4 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
        style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
      >
        {saving ? "Saving…" : "Save defaults"}
      </button>
    </div>
  );
}

const ASSEMBLY_RESOLUTIONS = ["720p", "1080p", "1440p", "2160p"] as const;
type AssemblyResolution = (typeof ASSEMBLY_RESOLUTIONS)[number];
type AssemblyBeatRule = {
  name: string;
  when: {
    resolution?: AssemblyResolution;
    maxBeats?: number;
    minBeats?: number;
    allImages?: boolean;
    captionsEnabled?: boolean;
  };
  value: number;
};

type ConcurrencyConfig = {
  video_worker: number;
  image_prompts_chunks: number;
  video_prompts_chunks: number;
  finish_images_poll: number;
  image_generation_batch: number;
  thumbnail_batch: number;
  tts_beat_batch: number;
  assembly_projects: number;
  assembly_beats: number;
  assembly_beats_rules: AssemblyBeatRule[];
};

type ConcurrencyNumericKey = Exclude<keyof ConcurrencyConfig, "assembly_beats_rules">;

// Mirrors lib/concurrency-config.ts CONCURRENCY_FIELDS + CONCURRENCY_DEFAULTS —
// kept in sync by hand. Defaults live here too so the UI can seed the
// inputs and the "Reset to defaults" button without an extra round-trip.
const CONCURRENCY_FIELDS: {
  key: ConcurrencyNumericKey;
  label: string;
  description: string;
  default: number;
  min: number;
  max: number;
  disabled?: boolean;
  group?: string;
}[] = [
  { key: "image_prompts_chunks",   label: "Image prompts generation", description: "How many script chunks generated in parallel. Higher = faster but more load on KIE (watch for 500s).", default: 3, min: 1, max: 20, group: "Prompts" },
  { key: "video_prompts_chunks",   label: "Video prompts generation", description: "How many script chunks generated in parallel. Higher = faster but more load on KIE.", default: 3, min: 1, max: 20, group: "Prompts" },
  { key: "tts_beat_batch",         label: "Voiceovers",          description: "Voiceover beats generated per batch.", default: 5, min: 1, max: 20, group: "Media" },
  { key: "video_worker",           label: "AI videos generation", description: "How many videos generated at once.",   default: 3, min: 1, max: 50, group: "Media" },
  { key: "image_generation_batch", label: "AI image generation",  description: "How many images generated at once.",   default: 3, min: 1, max: 20, group: "Media" },
  { key: "assembly_projects",      label: "Projects",            description: "How many videos assembled at once.",   default: 1, min: 1, max: 5,  group: "Assemble" },
  { key: "assembly_beats",         label: "Beats",               description: "Beats processed at once per video.",   default: 1, min: 1, max: 10, group: "Assemble" },
  { key: "finish_images_poll",     label: "Image finishers",     description: "Workers finalizing completed images.", default: 5, min: 1, max: 50, group: "Others" },
  { key: "thumbnail_batch",        label: "Thumbnail batch",     description: "Thumbnails generated per batch.",      default: 2, min: 1, max: 20, group: "Others" },
];

function ConcurrencyPanel() {
  const { data, mutate, isLoading } = useSWR<ConcurrencyConfig>(
    "/api/admin/concurrency",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [draft, setDraft] = useState<Record<ConcurrencyNumericKey, string>>(() => {
    const seed = {} as Record<ConcurrencyNumericKey, string>;
    for (const f of CONCURRENCY_FIELDS) seed[f.key] = String(f.default);
    return seed;
  });
  const [savingKey, setSavingKey] = useState<ConcurrencyNumericKey | null>(null);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!data || hydratedRef.current) return;
    // The fetcher doesn't throw on non-OK responses, so `data` can be
    // an error envelope (e.g. { error: "column missing" }) when the
    // migration hasn't been applied yet. Only hydrate when every knob
    // is present as a number — otherwise leave the default-seeded
    // draft alone so the inputs keep showing 3/1/1/5/3/2/5 instead of
    // the literal text "undefined".
    const allPresent = CONCURRENCY_FIELDS.every((f) => typeof (data as Record<string, unknown>)[f.key] === "number");
    if (!allPresent) return;
    hydratedRef.current = true;
    const next = { ...draft };
    for (const f of CONCURRENCY_FIELDS) next[f.key] = String(data[f.key]);
    setDraft(next);
    // intentionally only run on first hydration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  function parsedField(key: ConcurrencyNumericKey) {
    const raw = draft[key].trim();
    if (raw === "") return { value: null as number | null, valid: false };
    const n = Number(raw);
    const field = CONCURRENCY_FIELDS.find(f => f.key === key)!;
    const valid = Number.isInteger(n) && n >= field.min && n <= field.max;
    return { value: n, valid };
  }

  function isDirty(key: ConcurrencyNumericKey): boolean {
    if (!data) return false;
    const { value } = parsedField(key);
    return value !== data[key];
  }

  async function saveField(key: ConcurrencyNumericKey) {
    const { value, valid } = parsedField(key);
    if (!valid || value == null) {
      toast.error("Fix the value before saving");
      return;
    }
    setSavingKey(key);
    try {
      // PUT accepts a partial — we send just this one knob so other
      // in-progress edits stay un-clobbered on the server.
      const res = await fetch("/api/admin/concurrency", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      toast.success("Saved");
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingKey(null);
    }
  }

  function resetToDefaults() {
    const next = { ...draft };
    for (const f of CONCURRENCY_FIELDS) next[f.key] = String(f.default);
    setDraft(next);
  }


  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5">
        <Gauge size={18} className="shrink-0 mt-0.5" style={{ color: "oklch(0.62 0.15 220)" }} />
        <div>
          <h3 className="text-base font-bold leading-tight" style={{ color: "var(--c-90)" }}>
            Parallel processing per step
          </h3>
          <p className="text-xs mt-1" style={{ color: "var(--c-50)" }}>
            How many tasks run at once at each step. Higher = faster, more API load.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {(() => {
          // Walk the field list and collapse consecutive entries with
          // the same `group` value into a single group bucket. Items
          // without a group render as their own bucket (no header).
          type Bucket = { group: string | null; fields: typeof CONCURRENCY_FIELDS };
          const buckets: Bucket[] = [];
          for (const f of CONCURRENCY_FIELDS) {
            const g = f.group ?? null;
            const last = buckets[buckets.length - 1];
            if (last && last.group === g && g !== null) last.fields.push(f);
            else buckets.push({ group: g, fields: [f] });
          }

          const renderRow = (f: typeof CONCURRENCY_FIELDS[number], inGroup: boolean) => {
            const { valid } = parsedField(f.key);
            const serverVal = data?.[f.key];
            const dirty = isDirty(f.key);
            const saving = savingKey === f.key;
            const fieldDisabled = f.disabled === true;
            const canSave = !fieldDisabled && dirty && valid && !saving && savingKey === null;
            const inputStyle = {
              background: "var(--bg-input)",
              border: `1px solid ${valid ? "var(--bd-10)" : "oklch(0.62 0.18 25 / 0.5)"}`,
              color: "var(--c-90)",
            } as const;
            return (
              <div key={f.key} className="p-3 rounded-xl"
                style={{
                  background: inGroup ? "var(--bg-card)" : "oklch(0 0 0 / 0.02)",
                  border: "1px solid oklch(0 0 0 / 0.06)",
                  opacity: fieldDisabled ? 0.5 : 1,
                }}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <label className="text-xs font-semibold" style={{ color: "var(--c-90)" }}>
                      {f.label}
                    </label>
                    <p className="text-xs mt-0.5" style={{ color: "var(--c-50)" }}>
                      {f.description}
                    </p>
                    <p className="text-xs mt-1" style={{ color: "var(--c-42)" }}>
                      {f.min}–{f.max} · saved{" "}
                      <span className="font-semibold tabular-nums" style={{ color: "var(--c-90)" }}>
                        {serverVal ?? "—"}
                      </span>
                    </p>
                  </div>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={f.min}
                    max={f.max}
                    step={1}
                    value={draft[f.key]}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    disabled={isLoading || saving || fieldDisabled}
                    className="w-24 px-3 py-2 rounded-lg text-sm outline-none transition-all tabular-nums text-center"
                    style={inputStyle}
                  />
                  <button
                    onClick={() => saveField(f.key)}
                    disabled={!canSave}
                    className="px-3 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
                    style={{
                      background: canSave ? "oklch(0.62 0.15 220)" : "oklch(0 0 0 / 0.06)",
                      color: canSave ? "white" : "var(--c-50)",
                      minWidth: 72,
                    }}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            );
          };

          return buckets.map((b, bi) => {
            if (b.group === null) {
              return <div key={`ungrouped-${bi}`} className="space-y-3">{b.fields.map((f) => renderRow(f, false))}</div>;
            }
            return (
              <div key={`group-${b.group}`} className="p-3 rounded-xl space-y-2"
                style={{
                  background: "oklch(0.62 0.15 220 / 0.08)",
                  border: "1px solid oklch(0.62 0.15 220 / 0.22)",
                  marginTop: 20,
                  marginBottom: 50,
                }}>
                <h3 className="text-xs font-bold uppercase tracking-wide px-1" style={{ color: "oklch(0.55 0.15 220)" }}>
                  {b.group}
                </h3>
                {b.fields.map((f) => renderRow(f, true))}
                {b.group === "Assemble" && <AssemblyBeatRulesPanel />}
              </div>
            );
          });
        })()}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={resetToDefaults}
          disabled={savingKey !== null}
          className="px-3 py-2.5 rounded-lg text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
          style={{ background: "transparent", color: "var(--c-50)", border: "1px solid var(--bd-10)" }}
        >
          <RotateCcw size={14} />
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

function AssemblyBeatRulesPanel() {
  // Same endpoint as ConcurrencyPanel — SWR dedupes the request.
  const { data, mutate, isLoading } = useSWR<ConcurrencyConfig>(
    "/api/admin/concurrency",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [draft, setDraft] = useState<AssemblyBeatRule[]>([]);
  const [saving, setSaving] = useState(false);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!data || hydratedRef.current) return;
    if (!Array.isArray((data as Record<string, unknown>).assembly_beats_rules)) return;
    hydratedRef.current = true;
    setDraft(JSON.parse(JSON.stringify(data.assembly_beats_rules)) as AssemblyBeatRule[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const serverSerialized = JSON.stringify(data?.assembly_beats_rules ?? []);
  const draftSerialized = JSON.stringify(draft);
  const dirty = serverSerialized !== draftSerialized;

  function updateRule(idx: number, patch: Partial<AssemblyBeatRule>) {
    setDraft((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function updateRuleWhen(idx: number, patch: Partial<AssemblyBeatRule["when"]>) {
    setDraft((prev) => prev.map((r, i) => (i === idx ? { ...r, when: { ...r.when, ...patch } } : r)));
  }
  function removeRule(idx: number) {
    setDraft((prev) => prev.filter((_, i) => i !== idx));
  }
  function addRule() {
    setDraft((prev) => [...prev, { name: `Rule ${prev.length + 1}`, when: {}, value: 1 }]);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/concurrency", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assembly_beats_rules: draft }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      toast.success("Rules saved");
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const inputStyle = {
    background: "var(--bg-input)",
    border: "1px solid var(--bd-10)",
    color: "var(--c-90)",
  } as const;

  return (
    <div className="space-y-3 mt-3 pt-3" style={{ borderTop: "1px dashed oklch(0.55 0.15 220 / 0.3)" }}>
      <div className="px-1">
        <h4 className="text-xs font-semibold" style={{ color: "var(--c-90)" }}>
          Beats rules (per scenario)
        </h4>
        <p className="text-xs mt-0.5" style={{ color: "var(--c-50)" }}>
          Override the Beats value above when the project matches the conditions. First matching rule wins. The Beats slider is still the absolute ceiling.
        </p>
      </div>

      {isLoading && !data && <p className="text-xs px-1" style={{ color: "var(--c-42)" }}>Loading…</p>}

      <div className="space-y-2">
        {draft.map((rule, idx) => (
          <div key={idx} className="p-3 rounded-lg space-y-2"
            style={{ background: "var(--bg-card)", marginTop: 15, marginBottom: 4 }}>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={rule.name}
                onChange={(e) => updateRule(idx, { name: e.target.value })}
                placeholder="Rule name"
                className="flex-1 px-2 py-1.5 rounded text-sm font-medium"
                style={inputStyle}
              />
              <button
                onClick={() => removeRule(idx)}
                className="px-2 py-1.5 rounded text-xs hover:opacity-90 cursor-pointer"
                style={{ background: "transparent", color: "oklch(0.55 0.18 25)", border: "1px solid oklch(0.55 0.18 25 / 0.4)" }}
                title="Remove rule"
              >
                Remove
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <label className="text-xs" style={{ color: "var(--c-50)" }}>
                Resolution
                <select
                  value={rule.when.resolution ?? ""}
                  onChange={(e) => updateRuleWhen(idx, { resolution: (e.target.value || undefined) as AssemblyResolution | undefined })}
                  className="mt-1 w-full px-2 py-1.5 rounded text-sm"
                  style={inputStyle}
                >
                  <option value="">Any</option>
                  {ASSEMBLY_RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="text-xs" style={{ color: "var(--c-50)" }}>
                All images?
                <select
                  value={rule.when.allImages === undefined ? "" : rule.when.allImages ? "yes" : "no"}
                  onChange={(e) => updateRuleWhen(idx, { allImages: e.target.value === "" ? undefined : e.target.value === "yes" })}
                  className="mt-1 w-full px-2 py-1.5 rounded text-sm"
                  style={inputStyle}
                >
                  <option value="">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
              <label className="text-xs" style={{ color: "var(--c-50)" }}>
                Captions on?
                <select
                  value={rule.when.captionsEnabled === undefined ? "" : rule.when.captionsEnabled ? "yes" : "no"}
                  onChange={(e) => updateRuleWhen(idx, { captionsEnabled: e.target.value === "" ? undefined : e.target.value === "yes" })}
                  className="mt-1 w-full px-2 py-1.5 rounded text-sm"
                  style={inputStyle}
                >
                  <option value="">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
              <label className="text-xs" style={{ color: "var(--c-50)" }}>
                Beats ≥
                <input
                  type="number"
                  inputMode="numeric"
                  value={rule.when.minBeats ?? ""}
                  onChange={(e) => updateRuleWhen(idx, { minBeats: e.target.value === "" ? undefined : Number(e.target.value) })}
                  className="mt-1 w-full px-2 py-1.5 rounded text-sm"
                  style={inputStyle}
                  placeholder="Any"
                />
              </label>
              <label className="text-xs" style={{ color: "var(--c-50)" }}>
                Beats ≤
                <input
                  type="number"
                  inputMode="numeric"
                  value={rule.when.maxBeats ?? ""}
                  onChange={(e) => updateRuleWhen(idx, { maxBeats: e.target.value === "" ? undefined : Number(e.target.value) })}
                  className="mt-1 w-full px-2 py-1.5 rounded text-sm"
                  style={inputStyle}
                  placeholder="Any"
                />
              </label>
              <label className="text-xs font-semibold" style={{ color: "var(--c-90)" }}>
                Concurrency
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={10}
                  value={rule.value}
                  onChange={(e) => updateRule(idx, { value: Number(e.target.value) || 1 })}
                  className="mt-1 w-full px-2 py-1.5 rounded text-sm font-semibold"
                  style={inputStyle}
                />
              </label>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={addRule}
          disabled={saving || draft.length >= 32}
          className="px-3 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
          style={{ background: "transparent", color: "var(--c-50)", border: "1px solid var(--bd-10)" }}
        >
          + Add rule
        </button>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="px-3 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
          style={{ background: "oklch(0.62 0.15 220)", color: "white", border: "1px solid oklch(0.55 0.15 220)" }}
        >
          {saving ? (
            <>
              <Spinner size={14} />
              Saving…
            </>
          ) : (
            "Save rules"
          )}
        </button>
      </div>
    </div>
  );
}

type Routing = "client_kie" | "heclus_kie" | "heclus_direct";
type WorkflowStep =
  | "analyze"
  | "ideas"
  | "script"
  | "visual_analysis"
  | "beats"
  | "image_prompts"
  | "video_prompts"
  | "thumbnails";

interface RoutingOption {
  id: Routing;
  title: string;
  description: string;
  requires?: string;
}

const ROUTING_OPTIONS: RoutingOption[] = [
  {
    id: "client_kie",
    title: "Via Client's KIE account",
    description: "Each user's own KIE API key (from their Settings) is used. Calls are billed to the end user. A user who has added their own Anthropic key and switched it on runs direct on that instead — still their own money, so this setting is unaffected.",
  },
  {
    id: "heclus_kie",
    title: "Via Heclus KIE account",
    description: "All Anthropic calls go through Heclus's KIE key, regardless of who triggered them. Calls are billed to Heclus's KIE account.",
    requires: "Add a key under API Keys → Heclus KIE API Key.",
  },
  {
    id: "heclus_direct",
    title: "Via Heclus Anthropic key (direct)",
    description: "Bypasses KIE entirely — calls hit api.anthropic.com directly with Heclus's Anthropic API key. Avoids KIE's envelope quirks and rate limits.",
    requires: "Add a key under API Keys → Anthropic API Key (direct).",
  },
];

// Display labels for each workflow step. Slugs must match the WorkflowStep
// union exported from lib/claude/routing.ts. The three prompt slugs are listed
// for completeness but aren't rendered on their own — STEP_CARDS below boxes
// them into a single "Prompts" card.
const WORKFLOW_STEP_LABELS: Record<WorkflowStep, { title: string; subtitle: string }> = {
  analyze:         { title: "Channel Analysis",  subtitle: "Reverse-engineers the channel's style from transcripts" },
  ideas:           { title: "Video Ideas",       subtitle: "Generates trending topic suggestions" },
  script:          { title: "Script Generation", subtitle: "Writes the long-form narration script" },
  visual_analysis: { title: "Visual Analysis",   subtitle: "Extracts the channel's visual style from frames" },
  beats:           { title: "Beat Segmentation", subtitle: "Splits the script into visual beats" },
  image_prompts:   { title: "Image Prompts",     subtitle: "One AI image prompt per script beat" },
  video_prompts:   { title: "Video Prompts",     subtitle: "Motion + camera instructions per beat" },
  thumbnails:      { title: "Thumbnail Concepts", subtitle: "Generates 5 thumbnail design concepts" },
};
/**
 * One card in the Per step tab. Usually one step, but the three sub-steps the
 * wizard shows as a single "Prompts" step — beat segmentation, image prompts,
 * video prompts — are boxed into one card so an admin configures the step they
 * can actually see rather than three internal slugs that always move together.
 *
 * Writes fan out to every slug in `steps` in one request, so the group can't
 * half-save.
 */
interface StepCard {
  id: string;
  steps: WorkflowStep[];
  title: string;
  subtitle: string;
}

const STEP_CARDS: StepCard[] = [
  { id: "analyze",         steps: ["analyze"],         ...WORKFLOW_STEP_LABELS.analyze },
  { id: "ideas",           steps: ["ideas"],           ...WORKFLOW_STEP_LABELS.ideas },
  { id: "script",          steps: ["script"],          ...WORKFLOW_STEP_LABELS.script },
  { id: "visual_analysis", steps: ["visual_analysis"], ...WORKFLOW_STEP_LABELS.visual_analysis },
  {
    id: "prompts",
    steps: ["beats", "image_prompts", "video_prompts"],
    title: "Prompts",
    subtitle: "Beat segmentation, image prompts and video prompts",
  },
  { id: "thumbnails",      steps: ["thumbnails"],      ...WORKFLOW_STEP_LABELS.thumbnails },
];

/** The shared value across a card's steps, or "mixed" when they disagree —
 *  possible for the grouped card if the two slugs were set separately before
 *  they were boxed together. Saving from the card writes every step, so a
 *  mixed state resolves on the next change. */
function sharedValue<T>(values: T[]): T | "mixed" {
  const [first, ...rest] = values;
  return rest.every((v) => v === first) ? first : "mixed";
}

interface ClaudeModelOption {
  id: string;
  label: string;
  note: string;
  tier: "quality" | "balanced" | "fast";
  thinking: "off" | "pin-off" | "always";
}

interface GptModelOption {
  id: string;
  label: string;
  note: string;
}

// Which model family a step's output comes from. Orthogonal to routing (whose
// key pays) — see lib/claude/providers.ts.
type PromptProvider = "claude" | "gpt" | "gemini";

const PROVIDER_LABELS: Record<PromptProvider, string> = {
  claude: "Claude",
  gpt: "GPT",
  gemini: "Gemini",
};

interface RoutingResponse {
  routing: Routing;
  per_step: Partial<Record<WorkflowStep, Routing>>;
  steps: WorkflowStep[];
  model: string;
  models: ClaudeModelOption[];
  model_fallback: string;
  user_selectable_models: string[];
  user_choice_steps: WorkflowStep[];
  provider_per_step: Partial<Record<WorkflowStep, PromptProvider>>;
  provider_steps: WorkflowStep[];
  gpt_model: string;
  gpt_models: GptModelOption[];
  gemini_model: string;
  gemini_models: GptModelOption[];
}

function AnthropicRoutingPanel() {
  const swr = useSWR<RoutingResponse>("/api/admin/anthropic-routing", fetcher, { revalidateOnFocus: false });
  const [subTab, setSubTab] = usePersistentTab<"general" | "per_step" | "model">(
    "config.anthropic", "general", ["general", "per_step", "model"],
  );

  const subTabs: { id: "general" | "per_step" | "model"; label: string }[] = [
    { id: "general",  label: "General"  },
    { id: "per_step", label: "Per step" },
    { id: "model",    label: "Model"    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 p-1 rounded-xl w-full"
        style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)" }}>
        {subTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer"
            style={subTab === t.id ? {
              background: "oklch(0.72 0.25 285)",
              color: "white",
              boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.35)",
            } : {
              color: "var(--c-50)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "general" && <GeneralRoutingPanel swr={swr} />}
      {subTab === "per_step" && <PerStepRoutingPanel swr={swr} />}
      {subTab === "model" && <DefaultModelPanel swr={swr} />}
    </div>
  );
}

// Sentinel for "inherit from General" inside the per-step radio list.
// Internal-only; the API uses `null` on the wire. Keeping it as a string
// lets the same RoutingRadios component drive both panels with one type.
type RoutingValue = Routing | "inherit";

interface RoutingChoice {
  id: RoutingValue;
  title: string;
  description: string;
  requires?: string;
}

/**
 * Shared radio-card list used by both General and Per step. Each option
 * is rendered as a full-width card with title, description, and an
 * optional "requires" hint, matching the original General UX. Clicking
 * a non-active card calls onPick — the parent decides whether to confirm
 * via the dialog or apply immediately.
 */
function RoutingRadios({
  options,
  selected,
  serverActive,
  disabled,
  onPick,
}: {
  options: RoutingChoice[];
  /** "mixed" matches no option, so a grouped card whose steps disagree renders
   *  with nothing selected rather than claiming a value it doesn't have. */
  selected: RoutingValue | "mixed";
  serverActive?: RoutingValue | "mixed";
  disabled?: boolean;
  onPick: (id: RoutingValue) => void;
}) {
  return (
    <div className="space-y-2">
      {options.map((opt) => {
        const active = selected === opt.id;
        const isServerActive = serverActive === opt.id;
        return (
          <button
            key={opt.id}
            onClick={() => { if (!active) onPick(opt.id); }}
            disabled={disabled}
            className="w-full text-left p-3 rounded-xl transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              background: active ? "oklch(0.62 0.15 220 / 0.08)" : "var(--bg-card)",
              border: `1px solid ${active ? "oklch(0.62 0.15 220 / 0.45)" : "oklch(0 0 0 / 0.07)"}`,
              boxShadow: active ? "0 1px 4px oklch(0.62 0.15 220 / 0.12)" : "0 1px 2px oklch(0 0 0 / 0.04)",
            }}
          >
            <div className="flex items-start gap-3">
              <span className="w-4 h-4 mt-0.5 rounded-full shrink-0 flex items-center justify-center"
                style={{
                  background: active ? "oklch(0.62 0.15 220)" : "transparent",
                  border: `1.5px solid ${active ? "oklch(0.62 0.15 220)" : "oklch(0 0 0 / 0.2)"}`,
                }}>
                {active && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--bg-card)" }} />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold" style={{ color: active ? "oklch(0.62 0.15 220)" : "var(--c-90)" }}>
                    {opt.title}
                  </p>
                  {isServerActive && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full"
                      style={{
                        background: "oklch(0.55 0.15 145 / 0.15)",
                        color: "oklch(0.45 0.15 145)",
                        border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                      }}>
                      Active
                    </span>
                  )}
                </div>
                <p className="text-xs mt-1 leading-relaxed" style={{ color: "var(--c-50)" }}>
                  {opt.description}
                </p>
                {opt.requires && (
                  <p className="text-[11px] mt-1.5" style={{ color: "oklch(0.6 0.15 60)" }}>
                    ⓘ {opt.requires}
                  </p>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Shared confirm dialog. Used by both panels — the parent supplies the
 * preview choice (title + description) and a confirm handler. Returning
 * null when nothing's pending keeps the dialog mounted but closed.
 */
function RoutingConfirmDialog({
  open,
  saving,
  title,
  description,
  preview,
  confirmLabel = "Switch routing",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  saving: boolean;
  title: string;
  description: string;
  preview: RoutingChoice | null;
  /** Overridden by the provider switch, which changes the model family
   *  rather than the routing. */
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o && !saving) onCancel(); }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {preview && (
          <div className="rounded-xl p-3" style={{ background: "oklch(0.62 0.15 220 / 0.06)", border: "1px solid oklch(0.62 0.15 220 / 0.25)" }}>
            <p className="text-sm font-semibold" style={{ color: "oklch(0.62 0.15 220)" }}>
              {preview.title}
            </p>
            <p className="text-xs mt-1 leading-relaxed" style={{ color: "var(--c-55)" }}>
              {preview.description}
            </p>
            {preview.requires && (
              <p className="text-[11px] mt-1.5" style={{ color: "oklch(0.6 0.15 60)" }}>
                ⓘ {preview.requires}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <button
            onClick={onConfirm}
            disabled={saving}
            className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: "oklch(0.55 0.15 145)", color: "white" }}
          >
            {saving ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner size={14} className="text-white" />
                Switching…
              </span>
            ) : confirmLabel}
          </button>
          <button
            onClick={onCancel}
            disabled={saving}
            className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
            style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
          >
            Cancel
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ROUTING_CHOICES_GENERAL: RoutingChoice[] = ROUTING_OPTIONS;

function buildPerStepChoices(generalLabel: string): RoutingChoice[] {
  return [
    {
      id: "inherit",
      title: "Inherit from General",
      description: `Use whichever routing is currently set in the General tab (right now: ${generalLabel}). Picking another option below overrides it for this step only.`,
    },
    ...ROUTING_OPTIONS,
  ];
}

function GeneralRoutingPanel({ swr }: { swr: ReturnType<typeof useSWR<RoutingResponse>> }) {
  const { data, mutate, isLoading } = swr;

  const [sel, setSel] = useState<Routing>("client_kie");
  const [pending, setPending] = useState<Routing | null>(null);
  const [saving, setSaving] = useState(false);

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    hydratedRef.current = true;
    setSel(data.routing ?? "client_kie");
  }, [data]);

  const pendingOption = pending ? ROUTING_OPTIONS.find((o) => o.id === pending) ?? null : null;

  async function applyRouting(target: Routing) {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/anthropic-routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routing: target }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed to save");
      }
      setSel(target);
      toast.success("Anthropic routing saved");
      mutate();
      setPending(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--c-50)" }}>
        Pick how Claude (Anthropic) calls are routed. Applies to all users globally. Individual steps can override this in the Per step tab.
      </p>

      {isLoading && <p className="text-xs" style={{ color: "var(--c-42)" }}>Loading…</p>}

      <RoutingRadios
        options={ROUTING_CHOICES_GENERAL}
        selected={sel}
        serverActive={data?.routing}
        disabled={saving}
        onPick={(id) => { if (id !== "inherit") setPending(id); }}
      />

      <RoutingConfirmDialog
        open={pending !== null}
        saving={saving}
        title="Switch Anthropic routing?"
        description="This change applies to all users globally and takes effect immediately."
        preview={pendingOption}
        onConfirm={() => { if (pending) applyRouting(pending); }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

/**
 * Config → Anthropic → Model. Sets the default Claude model for the
 * workflow steps (channel analysis, ideas, script, image/video/thumbnail
 * prompts). Visual analysis stays pinned in code — it's a separate knob.
 */
function DefaultModelPanel({ swr }: { swr: ReturnType<typeof useSWR<RoutingResponse>> }) {
  const { data, mutate, isLoading } = swr;

  const [sel, setSel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!data?.model || hydratedRef.current) return;
    hydratedRef.current = true;
    setSel(data.model);
  }, [data]);

  const models = data?.models ?? [];
  const active = data?.model;
  const dirty = sel !== null && sel !== active;
  const selected = models.find((m) => m.id === sel);

  async function save() {
    if (!sel) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/anthropic-routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: sel }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      toast.success(`Default model set to ${selected?.label ?? sel}`);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed" style={{ color: "var(--c-50)" }}>
        The Claude model behind channel analysis, video ideas, script, and the
        image / video / thumbnail prompt steps. Applies to all users globally
        and takes effect within 15 seconds.
      </p>

      {isLoading && <p className="text-xs" style={{ color: "var(--c-42)" }}>Loading…</p>}

      <div className="space-y-2">
        {models.map((m) => {
          const isSel = sel === m.id;
          return (
            <button
              key={m.id}
              onClick={() => setSel(m.id)}
              disabled={saving}
              className="w-full text-left p-3 rounded-xl transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              style={{
                background: isSel ? "oklch(0.72 0.25 285 / 0.08)" : "oklch(0 0 0 / 0.02)",
                border: `1px solid ${isSel ? "oklch(0.72 0.25 285 / 0.45)" : "oklch(0 0 0 / 0.07)"}`,
              }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold" style={{ color: "var(--c-90)" }}>{m.label}</span>
                <code className="text-[10px] tabular-nums" style={{ color: "var(--c-42)" }}>{m.id}</code>
                {m.id === active && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                    style={{ background: "oklch(0.6 0.15 150 / 0.12)", color: "oklch(0.45 0.15 150)" }}>
                    live
                  </span>
                )}
                {m.id === data?.model_fallback && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                    style={{ background: "oklch(0 0 0 / 0.05)", color: "var(--c-50)" }}>
                    shipped default
                  </span>
                )}
              </div>
              <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--c-50)" }}>{m.note}</p>
              {m.thinking === "pin-off" && (
                // These models think by default and that shares the request's
                // max_tokens with the answer. We send thinking: disabled so
                // the tighter steps (1.5-2k budgets) behave as tuned.
                <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: "oklch(0.55 0.13 250)" }}>
                  Thinking is off — it would otherwise eat into the token budget the
                  shorter steps are tuned for.
                </p>
              )}
              {m.thinking === "always" && (
                <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: "oklch(0.6 0.16 60)" }}>
                  Thinking can&apos;t be turned off and shares the token budget with the
                  answer — the 1.5–2k steps (ideas, visual analysis) may run short.
                </p>
              )}
            </button>
          );
        })}
      </div>

      <button
        onClick={save}
        disabled={!dirty || saving || isLoading}
        className="px-3.5 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center gap-1.5"
        style={{
          background: dirty && !saving ? "oklch(0.72 0.25 285)" : "oklch(0 0 0 / 0.06)",
          color: dirty && !saving ? "white" : "var(--c-50)",
        }}
      >
        {saving && <Spinner size={12} />}
        {saving ? "Saving…" : "Save model"}
      </button>

      <UserSelectableModelsPanel swr={swr} />
    </div>
  );
}

/**
 * The allowlist half of the Model tab: which models a Pro user may choose
 * for themselves on /setup. Empty = the feature is off.
 */
function UserSelectableModelsPanel({ swr }: { swr: ReturnType<typeof useSWR<RoutingResponse>> }) {
  const { data, mutate } = swr;

  const [sel, setSel] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!data?.models || hydratedRef.current) return;
    hydratedRef.current = true;
    setSel(data.user_selectable_models ?? []);
  }, [data]);

  const models = data?.models ?? [];
  const server = data?.user_selectable_models ?? [];
  const current = sel ?? [];
  const dirty = sel !== null &&
    (current.length !== server.length || current.some((id) => !server.includes(id)));

  function toggle(id: string) {
    setSel((prev) => {
      const base = prev ?? [];
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  }

  async function save() {
    if (sel === null) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/anthropic-routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_selectable_models: sel }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      toast.success(sel.length ? "User model choices saved" : "User model choice turned off");
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const stepList = (data?.user_choice_steps ?? []).map((s) => s.replace(/_/g, " ")).join(", ");

  return (
    <div className="pt-5 mt-1 space-y-3" style={{ borderTop: "1px solid oklch(0 0 0 / 0.08)" }}>
      <div>
        <h4 className="text-sm font-bold" style={{ color: "var(--c-90)" }}>
          Let Pro users choose their own model
        </h4>
        <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--c-50)" }}>
          Tick the models a Pro user may pick on their Setup page. Their choice
          only applies to the{" "}
          <span className="font-semibold">{stepList || "prompt"}</span> steps, and
          only while those steps run on the user&apos;s own KIE key — so a user can
          never pick a model that Heclus pays for. Tick nothing to turn this off.
        </p>
      </div>

      {/* Bulk toggle. Indeterminate whenever the selection is partial, so
          the box reflects "some" rather than lying about all-or-nothing. */}
      <label
        className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer"
        style={{ background: "oklch(0 0 0 / 0.03)", border: "1px solid oklch(0 0 0 / 0.06)" }}
      >
        <input
          type="checkbox"
          checked={models.length > 0 && current.length === models.length}
          ref={(el) => {
            if (el) el.indeterminate = current.length > 0 && current.length < models.length;
          }}
          disabled={saving || models.length === 0}
          onChange={() =>
            setSel(current.length === models.length ? [] : models.map((m) => m.id))
          }
          className="cursor-pointer"
        />
        <span className="text-xs font-semibold" style={{ color: "var(--c-90)" }}>
          All
        </span>
        <span className="text-[11px]" style={{ color: "var(--c-42)" }}>
          {current.length} of {models.length} selected
        </span>
      </label>

      <div className="space-y-2">
        {models.map((m) => {
          const on = current.includes(m.id);
          return (
            <label
              key={m.id}
              className="flex items-start gap-2.5 p-2.5 rounded-lg cursor-pointer transition-all"
              style={{
                background: on ? "oklch(0.72 0.25 285 / 0.06)" : "oklch(0 0 0 / 0.02)",
                border: `1px solid ${on ? "oklch(0.72 0.25 285 / 0.35)" : "oklch(0 0 0 / 0.07)"}`,
              }}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={saving}
                onChange={() => toggle(m.id)}
                className="mt-0.5 cursor-pointer"
              />
              <span className="min-w-0">
                <span className="text-xs font-semibold" style={{ color: "var(--c-90)" }}>{m.label}</span>
                <code className="text-[10px] ml-2" style={{ color: "var(--c-42)" }}>{m.id}</code>
                <span className="block text-[11px] mt-0.5 leading-relaxed" style={{ color: "var(--c-50)" }}>
                  {m.note}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <button
        onClick={save}
        disabled={!dirty || saving}
        className="px-3.5 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center gap-1.5"
        style={{
          background: dirty && !saving ? "oklch(0.72 0.25 285)" : "oklch(0 0 0 / 0.06)",
          color: dirty && !saving ? "white" : "var(--c-50)",
        }}
      >
        {saving && <Spinner size={12} />}
        {saving ? "Saving…" : "Save choices"}
      </button>
    </div>
  );
}

/**
 * Claude ⇄ GPT switch for the steps that support it (image_prompts,
 * video_prompts). Provider is a separate axis from routing: routing decides
 * whose key pays, this decides which model family writes the prompts.
 *
 * GPT is only reachable through KIE, so selecting it makes the step run on the
 * KIE key of whoever the routing already bills — the confirm copy says so,
 * because the routing card above will still read "direct" while GPT is active.
 */
function StepProviderControl({
  card,
  data,
  mutate,
  disabled,
}: {
  card: StepCard;
  data: RoutingResponse | undefined;
  mutate: () => void;
  disabled: boolean;
}) {
  const [pending, setPending] = useState<PromptProvider | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingModel, setSavingModel] = useState<string | null>(null);

  const provider = sharedValue(card.steps.map((s) => data?.provider_per_step?.[s] ?? "claude"));
  // Each KIE provider has its own catalog and its own stored default.
  const isGemini = provider === "gemini";
  const models = isGemini ? data?.gemini_models ?? [] : data?.gpt_models ?? [];
  const activeModel = isGemini ? data?.gemini_model : data?.gpt_model;
  const modelField = isGemini ? "gemini_model" : "gpt_model";
  const routesDirect = card.steps.some((s) => (data?.per_step?.[s] ?? data?.routing) === "heclus_direct");

  async function applyProvider(next: PromptProvider) {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/anthropic-routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps: card.steps, provider: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      toast.success(`${card.title} now runs on ${PROVIDER_LABELS[next]}`);
      mutate();
      setPending(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function applyModel(id: string) {
    setSavingModel(id);
    try {
      const res = await fetch("/api/admin/anthropic-routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [modelField]: id }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      toast.success(`${isGemini ? "Gemini" : "GPT"} model set to ${models.find((m) => m.id === id)?.label ?? id}`);
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingModel(null);
    }
  }

  const PROVIDER_BLURB: Record<PromptProvider, string> = {
    claude: "Back to the Anthropic Messages API and the model set in the Model tab.",
    gpt: "Prompts are generated by GPT through KIE's Responses API, using strict JSON schema output. Cheapest per chunk, but a share of calls come back empty and are retried.",
    gemini: "Prompts are generated by Gemini through KIE's chat/completions API, using strict JSON schema output. Fastest and most consistent of the three, at a higher credit cost than GPT.",
  };
  const kieNote = "Only available via KIE, so this step will use the KIE key instead of the direct Anthropic key. Who pays is unchanged.";
  const confirmPreview: RoutingChoice | null = pending
    ? {
        id: "inherit",
        title: `Run this step on ${PROVIDER_LABELS[pending]}`,
        description:
          PROVIDER_BLURB[pending] +
          (pending === "claude" ? "" : " Prompt wording was tuned on Claude, so review the first run's output."),
        requires: pending !== "claude" && routesDirect ? kieNote : undefined,
      }
    : null;

  return (
    <div
      className="rounded-lg p-3 space-y-3"
      style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid oklch(0 0 0 / 0.06)" }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--c-50)" }}>
          Model family
        </span>
        <div
          className="flex items-center gap-1 p-0.5 rounded-lg"
          style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)" }}
        >
          {(["claude", "gpt", "gemini"] as PromptProvider[]).map((p) => (
            <button
              key={p}
              onClick={() => { if (p !== provider) setPending(p); }}
              disabled={disabled || saving}
              className="px-3 py-1 rounded-md text-[11px] font-semibold transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              style={provider === p ? {
                background: "oklch(0.72 0.25 285)",
                color: "white",
                boxShadow: "0 1px 4px oklch(0.72 0.25 285 / 0.30)",
              } : {
                color: "var(--c-50)",
              }}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
        {provider !== "claude" && provider !== "mixed" && (
          <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full"
            style={{
              background: "oklch(0.6 0.15 150 / 0.10)",
              color: "oklch(0.45 0.15 150)",
              border: "1px solid oklch(0.6 0.15 150 / 0.35)",
            }}>
            via KIE
          </span>
        )}
        {provider === "mixed" && (
          <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full"
            style={{
              background: "oklch(0.7 0.18 60 / 0.12)",
              color: "oklch(0.5 0.16 60)",
              border: "1px solid oklch(0.7 0.18 60 / 0.40)",
            }}>
            Mixed — pick one to align
          </span>
        )}
      </div>

      {provider !== "claude" && provider !== "mixed" && (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed" style={{ color: "var(--c-50)" }}>
            {isGemini ? "Gemini" : "GPT"} model — shared by every step set to {PROVIDER_LABELS[provider]}, not just this one.
          </p>
          {models.map((m) => {
            const isActive = m.id === activeModel;
            return (
              <button
                key={m.id}
                onClick={() => { if (!isActive) applyModel(m.id); }}
                disabled={disabled || savingModel !== null}
                className="w-full text-left p-2.5 rounded-lg transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                style={{
                  background: isActive ? "oklch(0.72 0.25 285 / 0.08)" : "var(--bg-card)",
                  border: `1px solid ${isActive ? "oklch(0.72 0.25 285 / 0.45)" : "oklch(0 0 0 / 0.07)"}`,
                }}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-semibold" style={{ color: "var(--c-90)" }}>{m.label}</span>
                  <code className="text-[10px] tabular-nums" style={{ color: "var(--c-42)" }}>{m.id}</code>
                  {isActive && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                      style={{ background: "oklch(0.6 0.15 150 / 0.12)", color: "oklch(0.45 0.15 150)" }}>
                      live
                    </span>
                  )}
                  {savingModel === m.id && <Spinner size={11} />}
                </div>
                <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: "var(--c-50)" }}>{m.note}</p>
              </button>
            );
          })}
        </div>
      )}

      <RoutingConfirmDialog
        open={pending !== null}
        saving={saving}
        title={`Switch ${card.title} to ${pending ? PROVIDER_LABELS[pending] : ""}?`}
        description={`Applies to ${card.subtitle.toLowerCase()}. Change takes effect for all users within 15 seconds.`}
        preview={confirmPreview}
        confirmLabel="Switch model family"
        onConfirm={() => { if (pending) applyProvider(pending); }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function PerStepRoutingPanel({ swr }: { swr: ReturnType<typeof useSWR<RoutingResponse>> }) {
  const { data, mutate, isLoading } = swr;
  const [pending, setPending] = useState<{ card: StepCard; value: RoutingValue } | null>(null);
  const [saving, setSaving] = useState(false);

  const generalLabel = data
    ? (ROUTING_OPTIONS.find((o) => o.id === data.routing)?.title ?? data.routing)
    : "—";
  const perStepChoices = buildPerStepChoices(generalLabel);
  const pendingChoice = pending ? perStepChoices.find((c) => c.id === pending.value) ?? null : null;

  async function applyStepRouting(card: StepCard, value: RoutingValue) {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/anthropic-routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps: card.steps, routing: value === "inherit" ? null : value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed to save");
      }
      toast.success(value === "inherit"
        ? `${card.title}: inheriting from General`
        : `${card.title} routing saved`);
      mutate();
      setPending(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--c-50)" }}>
        Override how Claude is routed for specific workflow steps. Each step
        shows the same routing options as the General tab — picking
        <span className="font-semibold"> Inherit from General </span>
        falls back to whatever's set globally (currently <span className="font-semibold">{generalLabel}</span>).
        The prompt steps additionally offer a <span className="font-semibold">model family</span> switch:
        run them on GPT or Gemini via KIE instead of Claude, useful when KIE&apos;s Claude relay is degraded.
      </p>

      {isLoading && <p className="text-xs" style={{ color: "var(--c-42)" }}>Loading…</p>}

      <div className="space-y-4">
        {STEP_CARDS.map((card) => {
          // A card's value is whatever its steps agree on. They only disagree
          // if the slugs were set individually before being grouped; any save
          // from the card realigns them.
          const override = sharedValue(card.steps.map((s) => data?.per_step?.[s] ?? null));
          const selectedValue: RoutingValue | "mixed" = override === "mixed" ? "mixed" : override ?? "inherit";
          const supportsProvider = card.steps.every((s) => (data?.provider_steps ?? []).includes(s));
          // Badge shows the non-Claude provider the card is on, if any.
          const cardProvider = card.steps
            .map((s) => data?.provider_per_step?.[s])
            .find((p): p is PromptProvider => p === "gpt" || p === "gemini");
          // Which key a KIE provider ends up on, mirroring kieRoutingFor. A
          // mixed card falls back to the global, same as an unset step would.
          const effectiveRouting = override === "mixed" || override === null ? data?.routing : override;
          const paysHeclus = effectiveRouting === "heclus_kie" || effectiveRouting === "heclus_direct";
          // Disable interaction while ANY card is saving so a confirm
          // mid-dialog can't be racing another save's optimistic state.
          const disabled = saving;
          return (
            <div
              key={card.id}
              className="rounded-xl p-4 space-y-3"
              style={{
                background: "var(--bg-card)",
                border: "1px solid oklch(0 0 0 / 0.07)",
                boxShadow: "0 1px 2px oklch(0 0 0 / 0.04)",
              }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold uppercase tracking-wide px-2.5 py-1 rounded-md"
                  style={{
                    background: "oklch(0.72 0.25 285)",
                    color: "white",
                    boxShadow: "0 1px 3px oklch(0.72 0.25 285 / 0.30)",
                  }}>
                  {card.title}
                </span>
                {override === "mixed" ? (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full"
                    style={{
                      background: "oklch(0.7 0.18 60 / 0.12)",
                      color: "oklch(0.5 0.16 60)",
                      border: "1px solid oklch(0.7 0.18 60 / 0.40)",
                    }}>
                    Mixed
                  </span>
                ) : override === null ? (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full"
                    style={{
                      background: "oklch(0 0 0 / 0.05)",
                      color: "var(--c-50)",
                      border: "1px solid oklch(0 0 0 / 0.1)",
                    }}>
                    Inheriting
                  </span>
                ) : (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full"
                    style={{
                      background: "oklch(0.62 0.15 220 / 0.10)",
                      color: "oklch(0.55 0.15 220)",
                      border: "1px solid oklch(0.62 0.15 220 / 0.35)",
                    }}>
                    Override
                  </span>
                )}
                {cardProvider && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full"
                    style={{
                      background: "oklch(0.7 0.18 60 / 0.12)",
                      color: "oklch(0.5 0.16 60)",
                      border: "1px solid oklch(0.7 0.18 60 / 0.40)",
                    }}>
                    {PROVIDER_LABELS[cardProvider]}
                  </span>
                )}
                <span className="text-[11px]" style={{ color: "var(--c-50)" }}>
                  · {card.subtitle}
                </span>
              </div>

              {supportsProvider && (
                <StepProviderControl card={card} data={data} mutate={mutate} disabled={disabled} />
              )}

              {/* The routing cards are all Anthropic-specific, and GPT/Gemini
                  reach the model only through KIE — so they'd be describing a
                  path this step isn't taking. Hide them, but say which KIE key
                  ends up paying, because the stored routing still decides that
                  (kieRoutingFor in lib/claude/providers.ts). */}
              {cardProvider ? (
                <p className="text-[11px] leading-relaxed rounded-lg px-3 py-2"
                  style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid oklch(0 0 0 / 0.06)", color: "var(--c-50)" }}>
                  Routing doesn&apos;t apply on {PROVIDER_LABELS[cardProvider]}, which is only reachable through KIE.
                  This step bills{" "}
                  <span className="font-semibold">
                    {paysHeclus ? "Heclus's KIE key" : "each user's own KIE key"}
                  </span>
                  . Switch back to Claude to change routing.
                </p>
              ) : (
                <RoutingRadios
                  options={perStepChoices}
                  selected={selectedValue}
                  serverActive={selectedValue}
                  disabled={disabled}
                  onPick={(id) => setPending({ card, value: id })}
                />
              )}
            </div>
          );
        })}
      </div>

      <RoutingConfirmDialog
        open={pending !== null}
        saving={saving}
        title={pending ? `Switch routing for ${pending.card.title}?` : "Switch routing?"}
        description={pending && pending.card.steps.length > 1
          ? `Applies to ${pending.card.subtitle.toLowerCase()}. Change takes effect immediately for all users.`
          : "Only this step is affected. Change takes effect immediately for all users."}
        preview={pendingChoice}
        onConfirm={() => { if (pending) applyStepRouting(pending.card, pending.value); }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

type PaymentMode = "test" | "production";

interface AdminPlanDTO {
  slug: string;
  name: string;
  priceDisplay: string;
  priceCents: number | null;
  periodDisplay: string;
  limitDisplay: string;
  features: string[];
  nichesPerMonth: number | null;
  paymentLink: string | null;
  paymentLinkTest: string | null;
  paymentLinkProduction: string | null;
  highlighted: boolean;
  disabled: boolean;
  isFounder: boolean;
  sortOrder: number;
}

function PlansPanel() {
  const { data, mutate, isLoading } = useSWR<{ plans: AdminPlanDTO[]; paymentMode: PaymentMode }>(
    "/api/admin/plans",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [editing, setEditing] = useState<AdminPlanDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  // Which env's URLs the plans list displays. Independent of the
  // runtime env (which comes from HECLUS_ENV via paymentMode below)
  // — admins use this to peek at the test or production checkout
  // URLs side-by-side without redeploying.
  const [viewEnv, setViewEnv] = useState<PaymentMode>("test");

  const { data: paymentSettings, mutate: mutatePaymentSettings } = useSWR<{
    mode: PaymentMode;
    productionTestLink: string | null;
    secretKeyTest: string | null;
    secretKeyProduction: string | null;
    baseUrlTest: string | null;
    baseUrlProduction: string | null;
    webhookSecretTest: string | null;
    webhookSecretProduction: string | null;
    customerPortalUrlTest: string | null;
    customerPortalUrlProduction: string | null;
  }>("/api/admin/payment-mode", fetcher, { revalidateOnFocus: false });
  const [editingProdTest, setEditingProdTest] = useState(false);
  const [deletingProdTest, setDeletingProdTest] = useState(false);

  const plans = data?.plans ?? [];
  const paymentMode: PaymentMode = data?.paymentMode ?? "test";
  const prodTestLink = paymentSettings?.productionTestLink ?? null;

  // Default the view tab to whichever env the deployment runs in, so
  // the panel opens to the URLs that are actually live. Admins flip
  // tabs to inspect the other env. Only seeds on first paymentMode
  // load; subsequent admin interactions are sticky.
  const viewEnvSeededRef = useRef(false);
  useEffect(() => {
    if (viewEnvSeededRef.current || !data) return;
    viewEnvSeededRef.current = true;
    setViewEnv(paymentMode);
  }, [data, paymentMode]);

  // Hard-force production view on production deployments. The Test
  // tab is hidden there, but viewEnv could still be "test" if the
  // payment-mode response loads after the user (somehow) clicked
  // the Test tab. Belt-and-braces — keeps the URL preview, test-
  // purchase button, and PlanEditModal label aligned with the
  // tab list.
  useEffect(() => {
    if (paymentMode === "production" && viewEnv !== "production") {
      setViewEnv("production");
    }
  }, [paymentMode, viewEnv]);

  async function handleDelete(slug: string) {
    setDeleteSubmitting(true);
    try {
      const res = await fetch(`/api/admin/plans/${encodeURIComponent(slug)}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Delete failed (${res.status})`);
      toast.success(`Deleted ${slug}`);
      mutate();
      setDeletingSlug(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeleteSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-5 space-y-4 mt-[15px]" style={{ background: "var(--bg-card)", border: "2px solid silver" }}>
      <div className="rounded-xl p-3 flex items-center justify-between gap-3"
        style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid var(--bd-7)" }}>
        <div className="min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--c-78)" }}>Dodo environment, plans and product links</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--c-50)" }}>
            {paymentMode === "production"
              ? <>Runtime env is auto-detected from HECLUS_ENV — locked to <span className="font-semibold">Production</span> on this deployment. Test data is hidden here to avoid accidental edits on live config.</>
              : <>Runtime env is auto-detected from HECLUS_ENV (<span className="font-semibold capitalize">{paymentMode}</span> on this deployment). The tabs below let you preview either env&apos;s product URLs without redeploying.</>}
          </p>
        </div>
        <div className="shrink-0 flex p-0.5 rounded-lg"
          style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid var(--bd-7)" }}>
          {/* On a production deployment, hide the Test tab entirely so
              the admin never accidentally edits/previews test config
              against live billing. Local + staging keep both tabs so
              admins can compare the two envs side-by-side. */}
          {(paymentMode === "production" ? (["production"] as const) : (["test", "production"] as const)).map((m) => {
            const active = viewEnv === m;
            return (
              <button
                key={m}
                onClick={() => setViewEnv(m)}
                className="px-3 py-1 rounded-md text-xs font-semibold transition-all capitalize cursor-pointer"
                style={active ? {
                  background: m === "production" ? "oklch(0.55 0.15 145)" : "oklch(0.62 0.15 220)",
                  color: "white",
                } : { background: "transparent", color: "var(--c-55)" }}
                title={m === paymentMode ? `${m} is the runtime env on this deployment` : `Previewing ${m} URLs (deployment runs in ${paymentMode})`}
              >
                {m === "production" ? "Production" : "Test"}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm" style={{ color: "var(--c-50)" }}>
          Subscription plans shown in the upgrade modal. Slug is read-only after creation — it&apos;s the value written to user.app_metadata.plan by the payment webhook.
        </p>
        <button
          onClick={() => setCreating(true)}
          className="shrink-0 px-3 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90 cursor-pointer"
          style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
        >
          + Add plan
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10 text-xs" style={{ color: "var(--c-50)" }}>
          <Spinner size={14} className="mr-2" />
          Loading plans…
        </div>
      ) : plans.length === 0 ? (
        <p className="text-xs text-center py-10" style={{ color: "var(--c-50)" }}>No plans yet. Add one to get started.</p>
      ) : (
        <ul className="space-y-2">
          {plans.map((p) => (
            <li key={p.slug}
              className="rounded-xl p-3"
              style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid var(--bd-7)" }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold" style={{ color: "var(--c-90)" }}>{p.name}</p>
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                      style={{ background: "oklch(0 0 0 / 0.04)", color: "var(--c-50)" }}>{p.slug}</span>
                    {p.isFounder && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)" }}>founder</span>
                    )}
                    {p.highlighted && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: "oklch(0.62 0.15 220 / 0.15)", color: "oklch(0.62 0.15 220)" }}>highlighted</span>
                    )}
                    {p.disabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                        style={{ background: "oklch(0 0 0 / 0.06)", color: "var(--c-50)" }}>disabled</span>
                    )}
                  </div>
                  <p className="text-xs mt-1" style={{ color: "var(--c-60)" }}>
                    {p.priceDisplay}{p.periodDisplay} · {p.nichesPerMonth === null ? "Unlimited niches" : `${p.nichesPerMonth} niches/mo`} · {p.features.length} feature{p.features.length === 1 ? "" : "s"}
                  </p>
                  {(() => {
                    const previewUrl = viewEnv === "production" ? p.paymentLinkProduction : p.paymentLinkTest;
                    return (
                      <>
                        <p className="text-[11px] mt-1 flex flex-wrap items-center gap-x-2 gap-y-1" style={{ color: "var(--c-50)" }}>
                          <span className={p.paymentLinkTest ? "text-zinc-600" : "text-zinc-400"}>
                            test: {p.paymentLinkTest ? "✓" : "—"}
                          </span>
                          <span className={p.paymentLinkProduction ? "text-zinc-600" : "text-zinc-400"}>
                            prod: {p.paymentLinkProduction ? "✓" : "—"}
                          </span>
                          {previewUrl ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                              style={viewEnv === "production"
                                ? { background: "oklch(0.55 0.15 145 / 0.12)", color: "oklch(0.45 0.15 145)" }
                                : { background: "oklch(0.62 0.15 220 / 0.12)", color: "oklch(0.45 0.15 220)" }}>
                              viewing: {viewEnv}
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700">
                              {viewEnv} link missing
                            </span>
                          )}
                        </p>
                        {previewUrl && (
                          <p
                            className="text-xs font-mono break-all mt-1.5 leading-snug"
                            style={{ color: "oklch(0.62 0.15 220)" }}
                            title={`${viewEnv} checkout URL`}
                          >
                            {previewUrl}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {(() => {
                    const previewUrl = viewEnv === "production" ? p.paymentLinkProduction : p.paymentLinkTest;
                    return (
                      <button
                        onClick={() => {
                          if (!previewUrl) {
                            toast.error(`No ${viewEnv} payment link set for this plan.`);
                            return;
                          }
                          const url = new URL(previewUrl);
                          url.searchParams.set("redirect_url", `${window.location.origin}/payment/callback`);
                          window.open(url.toString(), "_blank", "noopener,noreferrer");
                        }}
                        disabled={!previewUrl}
                        className="p-2 rounded-lg transition-all hover:bg-emerald-500/10 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                        title={previewUrl ? `Initiate ${viewEnv} purchase (opens checkout in new tab)` : `No ${viewEnv} payment link configured`}
                      >
                        <CreditCard size={14} style={{ color: "oklch(0.55 0.15 145)" }} />
                      </button>
                    );
                  })()}
                  <button
                    onClick={() => setEditing(p)}
                    className="p-2 rounded-lg transition-all hover:bg-black/5 cursor-pointer"
                    title="Edit plan"
                  >
                    <Pencil size={14} style={{ color: "var(--c-60)" }} />
                  </button>
                  <button
                    onClick={() => setDeletingSlug(p.slug)}
                    className="p-2 rounded-lg transition-all hover:bg-red-500/10 cursor-pointer"
                    title="Delete plan"
                  >
                    <Trash2 size={14} style={{ color: "oklch(0.6 0.22 25)" }} />
                  </button>
                </div>
              </div>
            </li>
          ))}

          {viewEnv === "production" && !plans.some((p) => p.slug === "production-test") && (
            <li className="rounded-xl p-3"
              style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid var(--bd-7)" }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold" style={{ color: "var(--c-90)" }}>Production test</p>
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                      style={{ background: "oklch(0 0 0 / 0.04)", color: "var(--c-50)" }}>production_test</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                      style={{ background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.45 0.15 145)" }}>admin only</span>
                  </div>
                  <p className="text-xs mt-1" style={{ color: "var(--c-60)" }}>
                    — live SKU · Admin checkout sanity check
                  </p>
                  <p className="text-[11px] mt-1 flex flex-wrap items-center gap-x-2 gap-y-1" style={{ color: "var(--c-50)" }}>
                    <span className="text-zinc-400">test: —</span>
                    <span className={prodTestLink ? "text-zinc-600" : "text-zinc-400"}>
                      prod: {prodTestLink ? "✓" : "—"}
                    </span>
                    {prodTestLink ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                        style={{ background: "oklch(0.55 0.15 145 / 0.12)", color: "oklch(0.45 0.15 145)" }}>
                        active: production
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700">
                        production link missing
                      </span>
                    )}
                  </p>
                  {prodTestLink && (
                    <p
                      className="text-xs font-mono break-all mt-1.5 leading-snug"
                      style={{ color: "oklch(0.62 0.15 220)" }}
                      title="Production test checkout URL"
                    >
                      {prodTestLink}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => {
                      if (!prodTestLink) {
                        toast.error("Set the production test link first via the pencil icon.");
                        return;
                      }
                      const url = new URL(prodTestLink);
                      url.searchParams.set("redirect_url", `${window.location.origin}/payment/callback`);
                      window.open(url.toString(), "_blank", "noopener,noreferrer");
                    }}
                    disabled={!prodTestLink}
                    className="p-2 rounded-lg transition-all hover:bg-emerald-500/10 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    title={prodTestLink ? "Initiate test purchase (opens checkout in new tab)" : "Set the production test link first"}
                  >
                    <CreditCard size={14} style={{ color: "oklch(0.55 0.15 145)" }} />
                  </button>
                  <button
                    onClick={() => setEditingProdTest(true)}
                    className="p-2 rounded-lg transition-all hover:bg-black/5 cursor-pointer"
                    title="Edit production test link"
                  >
                    <Pencil size={14} style={{ color: "var(--c-60)" }} />
                  </button>
                  <button
                    onClick={() => setDeletingProdTest(true)}
                    disabled={!prodTestLink}
                    className="p-2 rounded-lg transition-all hover:bg-red-500/10 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    title={prodTestLink ? "Clear production test link" : "Nothing to clear"}
                  >
                    <Trash2 size={14} style={{ color: "oklch(0.6 0.22 25)" }} />
                  </button>
                </div>
              </div>
            </li>
          )}
        </ul>
      )}
      </div>

      <DodoApiKeysCard
        settings={paymentSettings ?? null}
        runtimeEnv={paymentMode}
        onSaved={() => mutatePaymentSettings()}
      />

      {editing && (
        <PlanEditModal
          plan={editing}
          mode="edit"
          viewEnv={viewEnv}
          onClose={() => setEditing(null)}
          onSaved={() => { mutate(); setEditing(null); }}
        />
      )}
      {creating && (
        <PlanEditModal
          plan={null}
          mode="create"
          viewEnv={viewEnv}
          onClose={() => setCreating(false)}
          onSaved={() => { mutate(); setCreating(false); }}
        />
      )}
      {editingProdTest && (
        <ProductionTestEditModal
          initialLink={prodTestLink}
          onClose={() => setEditingProdTest(false)}
          onSaved={() => { mutatePaymentSettings(); setEditingProdTest(false); }}
        />
      )}
      {deletingProdTest && (
        <ProductionTestDeleteDialog
          onClose={() => setDeletingProdTest(false)}
          onDeleted={() => { mutatePaymentSettings(); setDeletingProdTest(false); }}
        />
      )}
      {deletingSlug && (
        <Dialog open onOpenChange={(open) => { if (!open && !deleteSubmitting) setDeletingSlug(null); }}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Delete plan?</DialogTitle>
              <DialogDescription>
                This deletes the &quot;{deletingSlug}&quot; plan row. Users currently on this plan keep their app_metadata.plan value, but new signups won&apos;t see it in the modal. The action can&apos;t be undone from the UI.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button
                onClick={() => handleDelete(deletingSlug)}
                disabled={deleteSubmitting}
                className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
                style={{ background: "oklch(0.6 0.22 25)", color: "white" }}
              >
                {deleteSubmitting ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <Spinner size={14} className="text-white" />
                    Deleting…
                  </span>
                ) : "Delete plan"}
              </button>
              <button
                onClick={() => setDeletingSlug(null)}
                disabled={deleteSubmitting}
                className="flex-1 py-2 rounded-xl text-sm font-medium transition-all bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-40"
              >
                Cancel
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function PlanEditModal({
  plan,
  mode,
  viewEnv,
  onClose,
  onSaved,
}: {
  plan: AdminPlanDTO | null;
  mode: "edit" | "create";
  // Which env's payment link the modal exposes for editing. The other
  // env's URL stays untouched on save — its state buffer starts at
  // the plan's existing value and the patch sends both columns
  // regardless, so the hidden one round-trips unchanged.
  viewEnv: PaymentMode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [slug, setSlug] = useState(plan?.slug ?? "");
  const [name, setName] = useState(plan?.name ?? "");
  const [priceDisplay, setPriceDisplay] = useState(plan?.priceDisplay ?? "");
  const [priceCents, setPriceCents] = useState<string>(
    plan?.priceCents == null ? "" : String(plan.priceCents),
  );
  const [periodDisplay, setPeriodDisplay] = useState(plan?.periodDisplay ?? "/mo");
  // Display strings shown next to the price ("$49" + period). The
  // select offers the four standard cadences; the stored column stays
  // free-text so any legacy or custom value already in the DB still
  // round-trips on edit (it'll appear as an extra option labelled
  // "Custom: <value>").
  const PERIOD_OPTIONS: { label: string; value: string }[] = [
    { label: "Annually",      value: " / year" },
    { label: "Semi-Annually", value: " / 6 months" },
    { label: "Quarterly",     value: " / quarter" },
    { label: "Monthly",       value: "/mo" },
  ];
  const periodIsStandard = PERIOD_OPTIONS.some((o) => o.value === periodDisplay);
  const [limitDisplay, setLimitDisplay] = useState(plan?.limitDisplay ?? "");
  const [featuresText, setFeaturesText] = useState((plan?.features ?? []).join("\n"));
  const [nichesUnlimited, setNichesUnlimited] = useState(plan?.nichesPerMonth === null);
  const [nichesPerMonth, setNichesPerMonth] = useState<string>(
    plan?.nichesPerMonth === null || plan === null ? "" : String(plan.nichesPerMonth)
  );
  const [paymentLinkTest, setPaymentLinkTest] = useState(plan?.paymentLinkTest ?? "");
  const [paymentLinkProduction, setPaymentLinkProduction] = useState(plan?.paymentLinkProduction ?? "");
  const [highlighted, setHighlighted] = useState(plan?.highlighted ?? false);
  const [disabled, setDisabledFlag] = useState(plan?.disabled ?? false);
  const [isFounder, setIsFounder] = useState(plan?.isFounder ?? false);
  const [sortOrder, setSortOrder] = useState(String(plan?.sortOrder ?? 0));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (mode === "create" && !/^[a-z][a-z0-9_-]{0,31}$/.test(slug)) {
      toast.error("Slug must start with a lowercase letter and contain only a–z, 0–9, _ or -");
      return;
    }
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (!priceDisplay.trim()) { toast.error("Price is required"); return; }

    const nichesValue = nichesUnlimited ? null : (() => {
      const n = Number(nichesPerMonth);
      return Number.isInteger(n) && n >= 0 ? n : NaN;
    })();
    if (typeof nichesValue === "number" && Number.isNaN(nichesValue)) {
      toast.error("Niches per month must be a non-negative integer or unlimited");
      return;
    }

    const sortVal = Number(sortOrder);
    if (!Number.isInteger(sortVal)) { toast.error("Sort order must be an integer"); return; }

    const features = featuresText.split("\n").map((s) => s.trim()).filter(Boolean);

    // price_cents is the guarded chargeable amount (integer or null).
    // Empty input maps to null → price guard skips this plan (helpful
    // for custom-priced tiers). Any other non-integer input is a bug
    // in the form, surface it up-front.
    const priceCentsTrimmed = priceCents.trim();
    let priceCentsValue: number | null;
    if (priceCentsTrimmed === "") {
      priceCentsValue = null;
    } else {
      const parsed = Number(priceCentsTrimmed);
      if (!Number.isInteger(parsed) || parsed < 0) {
        toast.error("Price (cents) must be a non-negative integer or blank");
        return;
      }
      priceCentsValue = parsed;
    }

    const payload = {
      ...(mode === "create" ? { slug } : {}),
      name: name.trim(),
      price_display: priceDisplay.trim(),
      price_cents: priceCentsValue,
      period_display: periodDisplay,
      limit_display: limitDisplay,
      features,
      niches_per_month: nichesValue,
      payment_link_test: paymentLinkTest.trim() || null,
      payment_link_production: paymentLinkProduction.trim() || null,
      highlighted,
      disabled,
      is_founder: isFounder,
      sort_order: sortVal,
    };

    setSaving(true);
    try {
      const url = mode === "create"
        ? "/api/admin/plans"
        : `/api/admin/plans/${encodeURIComponent(plan!.slug)}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Save failed (${res.status})`);
      toast.success(mode === "create" ? "Plan created" : "Plan saved");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full px-3 py-2 rounded-lg text-sm outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400";

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New plan" : `Edit ${plan?.name}`}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "The slug becomes the value written to user.app_metadata.plan when someone subscribes. Pick it carefully — it's read-only after creation."
              : "Edits go live immediately. The slug can't be changed without orphaning paid users."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-zinc-600">Slug</label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              disabled={mode === "edit" || saving}
              placeholder="e.g. pro-annual"
              className={inputCls + " font-mono"}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-zinc-600">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={saving} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-zinc-600">Sort order</label>
              <input value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} disabled={saving} className={inputCls + " tabular-nums"} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-zinc-600">Price display</label>
              <input value={priceDisplay} onChange={(e) => setPriceDisplay(e.target.value)} disabled={saving} placeholder="$49" className={inputCls} />
              <p className="text-[10px] text-zinc-500">Shown to users on the checkout modal.</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-zinc-600">Price (cents)</label>
              <input
                value={priceCents}
                onChange={(e) => setPriceCents(e.target.value)}
                disabled={saving}
                placeholder="4900"
                inputMode="numeric"
                className={inputCls + " tabular-nums"}
              />
              <p className="text-[10px] text-zinc-500">Charged amount in cents (e.g. 4900 for $49). Guards against underpayment. Blank disables the guard for this plan.</p>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-zinc-600">Billing period</label>
            <select
              value={periodDisplay}
              onChange={(e) => setPeriodDisplay(e.target.value)}
              disabled={saving}
              className={inputCls}
            >
              {PERIOD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
              {!periodIsStandard && (
                <option value={periodDisplay}>Custom: {periodDisplay || "(empty)"}</option>
              )}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-zinc-600">Limit display</label>
            <input value={limitDisplay} onChange={(e) => setLimitDisplay(e.target.value)} disabled={saving} placeholder="Unlimited niches" className={inputCls} />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-zinc-600">Niches per month</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={1}
                value={nichesPerMonth}
                onChange={(e) => setNichesPerMonth(e.target.value)}
                disabled={saving || nichesUnlimited}
                placeholder="20"
                className={inputCls + " tabular-nums flex-1"}
              />
              <label className="flex items-center gap-1.5 text-xs text-zinc-600 whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={nichesUnlimited}
                  onChange={(e) => setNichesUnlimited(e.target.checked)}
                  disabled={saving}
                />
                Unlimited
              </label>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-zinc-600">
              {(() => {
                // Special-case the label when editing the production-
                // test plan on the Test tab: surface its name so it's
                // obvious this isn't a generic "test URL" but the URL
                // used by the Production test plan specifically.
                if (viewEnv === "test" && (plan?.slug === "production-test" || slug === "production-test")) {
                  return "Payment link — Production test";
                }
                return viewEnv === "production" ? "Payment link — Production" : "Payment link — Test";
              })()}
            </label>
            <input
              value={viewEnv === "production" ? paymentLinkProduction : paymentLinkTest}
              onChange={(e) => (viewEnv === "production"
                ? setPaymentLinkProduction(e.target.value)
                : setPaymentLinkTest(e.target.value)
              )}
              disabled={saving}
              placeholder={viewEnv === "production"
                ? "https://checkout.dodopayments.com/…"
                : "https://test.checkout.dodopayments.com/…"}
              className={inputCls + " font-mono text-xs"}
            />
            <p className="text-[11px] text-zinc-500">
              Editing the {viewEnv} URL only — switch tabs on the Plans card to edit the other env. The hidden URL is preserved as-is.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-semibold text-zinc-600">Features (one per line)</label>
            <textarea
              value={featuresText}
              onChange={(e) => setFeaturesText(e.target.value)}
              disabled={saving}
              rows={5}
              className={inputCls + " resize-y"}
            />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs text-zinc-600">
              <input type="checkbox" checked={highlighted} onChange={(e) => setHighlighted(e.target.checked)} disabled={saving} />
              Highlighted
            </label>
            <label className="flex items-center gap-1.5 text-xs text-zinc-600">
              <input type="checkbox" checked={disabled} onChange={(e) => setDisabledFlag(e.target.checked)} disabled={saving} />
              Disabled
            </label>
            <label className="flex items-center gap-1.5 text-xs text-zinc-600">
              <input type="checkbox" checked={isFounder} onChange={(e) => setIsFounder(e.target.checked)} disabled={saving} />
              Founder plan
            </label>
          </div>

          {isFounder && <FounderSlotsControls disabled={saving} />}
        </div>

        <DialogFooter>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
          >
            {saving ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner size={14} className="text-white" />
                {mode === "create" ? "Creating…" : "Saving…"}
              </span>
            ) : (mode === "create" ? "Create plan" : "Save changes")}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 py-2 rounded-xl text-sm font-medium transition-all bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-40"
          >
            Cancel
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface LaunchStepResult {
  step: string;
  ok: boolean;
  detail?: string;
}

function ProductionTestEditModal({
  initialLink,
  onClose,
  onSaved,
}: {
  initialLink: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [link, setLink] = useState(initialLink ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/payment-mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productionTestLink: link.trim() || null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Save failed (${res.status})`);
      toast.success("Production test link saved");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Edit production test link</DialogTitle>
          <DialogDescription>
            URL the Production test row&apos;s Subscribe button opens. Live SKU — fires a real production checkout.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <label className="text-xs font-semibold text-zinc-600">Dodo checkout URL</label>
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            disabled={saving}
            placeholder="https://checkout.dodopayments.com/buy/…"
            className="w-full px-3 py-2 rounded-lg text-xs outline-none font-mono bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400"
          />
        </div>
        <DialogFooter>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
          >
            {saving ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner size={14} className="text-white" />
                Saving…
              </span>
            ) : "Save link"}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 py-2 rounded-xl text-sm font-medium transition-all bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-40"
          >
            Cancel
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProductionTestDeleteDialog({
  onClose,
  onDeleted,
}: {
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch("/api/admin/payment-mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productionTestLink: null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Delete failed (${res.status})`);
      toast.success("Production test link cleared");
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !deleting) onClose(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Clear production test link?</DialogTitle>
          <DialogDescription>
            The Production test row stays visible while mode is production, but the test-purchase button will be disabled until you set a new URL.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: "oklch(0.6 0.22 25)", color: "white" }}
          >
            {deleting ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner size={14} className="text-white" />
                Clearing…
              </span>
            ) : "Clear link"}
          </button>
          <button
            onClick={onClose}
            disabled={deleting}
            className="flex-1 py-2 rounded-xl text-sm font-medium transition-all bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-40"
          >
            Cancel
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DodoApiKeysCardProps {
  settings: {
    secretKeyTest: string | null;
    secretKeyProduction: string | null;
    baseUrlTest: string | null;
    baseUrlProduction: string | null;
    webhookSecretTest: string | null;
    webhookSecretProduction: string | null;
    customerPortalUrlTest: string | null;
    customerPortalUrlProduction: string | null;
  } | null;
  // Deployment env (HECLUS_ENV). When "production", the Test tab is
  // hidden so the admin can't edit test credentials on a live
  // deployment — same rationale as the env card above.
  runtimeEnv: PaymentMode;
  onSaved: () => void;
}

// Single field row inside DodoApiKeysCard. The saved value (if any)
// sits above the input in theme purple, truncated to a short preview
// with an eye-toggle for the full string — the input itself stays
// empty so the placeholder text is always visible and there's never
// any confusion about whether the input shows the saved value vs.
// what you're typing.
function DodoVarField({
  label,
  saved,
  value,
  onChange,
  placeholder,
  disabled,
  hint,
}: {
  label: string;
  saved: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled: boolean;
  hint?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  // 12 chars + ellipsis is enough to recognize the prefix (sk_test_,
  // sk_live_, whsec_, https://) without revealing the secret material.
  const preview = saved.length > 12 ? `${saved.slice(0, 12)}…` : saved;

  return (
    <div>
      <label className="text-sm font-semibold block mb-2" style={{ color: "var(--c-55)" }}>
        {label}
      </label>
      {saved && (
        <div className="flex items-center gap-2 mb-1.5 min-w-0">
          <p
            className="text-sm font-mono break-all leading-snug"
            style={{ color: "oklch(0.62 0.15 220)" }}
            title="Currently saved — type into the input below to replace"
          >
            {revealed ? saved : preview}
          </p>
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? "Hide full value" : "Reveal full value"}
            title={revealed ? "Hide full value" : "Reveal full value"}
            className="shrink-0 w-7 h-7 rounded-md inline-flex items-center justify-center transition-colors hover:bg-[oklch(0_0_0_/_0.04)] cursor-pointer"
            style={{ color: "oklch(0.62 0.15 220)" }}
          >
            {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      )}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full px-3 py-2.5 rounded-lg text-sm outline-none font-mono text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400"
        style={{ background: "var(--skeleton)" }}
      />
      {hint && (
        <p className="text-xs mt-1.5" style={{ color: "var(--c-40)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}

// Bottom-of-Payment-tab card for managing per-environment Dodo settings.
// Test/Production tabs share three inputs (secret key, base URL,
// webhook secret) and one save button — the active tab decides which
// env the save patches. Values are shown in plain text since admins
// need to verify what they pasted; the keys never leave the admin
// response anyway.
function DodoApiKeysCard({ settings, runtimeEnv, onSaved }: DodoApiKeysCardProps) {
  // On a production deployment, force the active env to "production"
  // and never let it back to "test" — the Test tab is hidden in the
  // render and the inputs / save are pinned to production fields.
  const [activeEnv, setActiveEnv] = useState<"test" | "production">(runtimeEnv);
  useEffect(() => {
    if (runtimeEnv === "production" && activeEnv !== "production") {
      setActiveEnv("production");
    }
  }, [runtimeEnv, activeEnv]);
  // Local edit buffers — start empty. Each input shows ONLY its
  // placeholder; the saved value is rendered above the input in
  // theme purple so the admin can see what's stored without it
  // mixing visually with what they're typing. Saving clears these
  // buffers and the "saved" line updates from the SWR revalidation.
  const [testKey, setTestKey] = useState("");
  const [prodKey, setProdKey] = useState("");
  const [testUrl, setTestUrl] = useState("");
  const [prodUrl, setProdUrl] = useState("");
  const [testWebhook, setTestWebhook] = useState("");
  const [prodWebhook, setProdWebhook] = useState("");
  const [testPortal, setTestPortal] = useState("");
  const [prodPortal, setProdPortal] = useState("");
  const [saving, setSaving] = useState(false);

  const keyValue = activeEnv === "test" ? testKey : prodKey;
  const urlValue = activeEnv === "test" ? testUrl : prodUrl;
  const webhookValue = activeEnv === "test" ? testWebhook : prodWebhook;
  const portalValue = activeEnv === "test" ? testPortal : prodPortal;
  const savedKey = (activeEnv === "test" ? settings?.secretKeyTest : settings?.secretKeyProduction) ?? "";
  const savedUrl = (activeEnv === "test" ? settings?.baseUrlTest : settings?.baseUrlProduction) ?? "";
  const savedWebhook = (activeEnv === "test" ? settings?.webhookSecretTest : settings?.webhookSecretProduction) ?? "";
  const savedPortal = (activeEnv === "test" ? settings?.customerPortalUrlTest : settings?.customerPortalUrlProduction) ?? "";
  // Dirty when the admin has typed something into any of the inputs
  // for the active env. Empty inputs are a no-op — clearing a saved
  // value isn't supported through this card on purpose.
  const dirty = !!keyValue.trim() || !!urlValue.trim() || !!webhookValue.trim() || !!portalValue.trim();

  function clearActiveEnvBuffers() {
    if (activeEnv === "test") {
      setTestKey(""); setTestUrl(""); setTestWebhook(""); setTestPortal("");
    } else {
      setProdKey(""); setProdUrl(""); setProdWebhook(""); setProdPortal("");
    }
  }

  async function save() {
    setSaving(true);
    try {
      const patch: Record<string, string | null> = {};
      if (keyValue.trim()) {
        patch[activeEnv === "test" ? "secretKeyTest" : "secretKeyProduction"] = keyValue.trim();
      }
      if (urlValue.trim()) {
        patch[activeEnv === "test" ? "baseUrlTest" : "baseUrlProduction"] = urlValue.trim();
      }
      if (webhookValue.trim()) {
        patch[activeEnv === "test" ? "webhookSecretTest" : "webhookSecretProduction"] = webhookValue.trim();
      }
      if (portalValue.trim()) {
        patch[activeEnv === "test" ? "customerPortalUrlTest" : "customerPortalUrlProduction"] = portalValue.trim();
      }
      const res = await fetch("/api/admin/payment-mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Save failed (${res.status})`);
      toast.success(`Dodo ${activeEnv} settings saved`);
      clearActiveEnvBuffers();
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const defaultBaseUrl = activeEnv === "production" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";

  return (
    <div
      className="rounded-2xl p-6 mt-[15px]"
      style={{ background: "var(--bg-card)", border: "2px solid silver" }}
    >
      <div className="mb-6">
        <p className="text-base font-semibold" style={{ color: "var(--c-90)" }}>Dodo Variables</p>
        <p className="text-sm mt-1.5 leading-relaxed" style={{ color: "var(--c-50)" }}>
          Used by /api/dodo/verify and the Dodo webhook handler. Production-test plan always uses the Production env; other plans follow the current payment mode.
        </p>
      </div>

      <div className="inline-flex p-0.5 rounded-lg mb-5" style={{ background: "oklch(0 0 0 / 0.05)" }}>
        {(runtimeEnv === "production" ? (["production"] as const) : (["test", "production"] as const)).map((env) => (
          <button
            key={env}
            type="button"
            onClick={() => setActiveEnv(env)}
            disabled={saving}
            className="px-4 py-1.5 rounded-md text-sm font-semibold transition-all disabled:opacity-40 capitalize cursor-pointer"
            style={activeEnv === env
              ? { background: "var(--bg-card)", color: "var(--c-90)", boxShadow: "0 1px 3px oklch(0 0 0 / 0.1)" }
              : { background: "transparent", color: "var(--c-55)" }}
          >
            {env}
          </button>
        ))}
      </div>

      <div className="space-y-5">
        <DodoVarField
          label={`Secret key (${activeEnv})`}
          saved={savedKey}
          value={keyValue}
          onChange={(v) => (activeEnv === "test" ? setTestKey(v) : setProdKey(v))}
          placeholder={activeEnv === "test" ? "sk_test_…" : "sk_live_…"}
          disabled={saving}
        />

        <DodoVarField
          label={`Base URL (${activeEnv})`}
          saved={savedUrl}
          value={urlValue}
          onChange={(v) => (activeEnv === "test" ? setTestUrl(v) : setProdUrl(v))}
          placeholder={defaultBaseUrl}
          disabled={saving}
          hint={`Leave blank to use the default (${defaultBaseUrl}).`}
        />

        <DodoVarField
          label={`DODO_WEBHOOK_SECRET (${activeEnv})`}
          saved={savedWebhook}
          value={webhookValue}
          onChange={(v) => (activeEnv === "test" ? setTestWebhook(v) : setProdWebhook(v))}
          placeholder="whsec_…"
          disabled={saving}
          hint="Per-environment Dodo webhook signing secret. The handler tries every configured secret on each request, so test + production can both target the same /api/webhooks/dodo URL."
        />

        <DodoVarField
          label={`Customer portal URL (${activeEnv})`}
          saved={savedPortal}
          value={portalValue}
          onChange={(v) => (activeEnv === "test" ? setTestPortal(v) : setProdPortal(v))}
          placeholder="https://…/portal/{customer_id}"
          disabled={saving}
          hint="Where the /plan page's 'Manage' billing button sends users. Optional: use {customer_id} as a placeholder to have it substituted per user. Leave blank to hide the button."
        />
      </div>

      <div className="flex items-center gap-3 mt-6">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="py-2.5 px-5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
        >
          {saving ? (
            <span className="inline-flex items-center gap-2">
              <Spinner size={14} className="text-white" />
              Saving…
            </span>
          ) : "Save changes"}
        </button>
        {!dirty && savedKey && (
          <span className="text-sm" style={{ color: "var(--c-50)" }}>Saved</span>
        )}
        {!savedKey && !dirty && (
          <span className="text-sm" style={{ color: "var(--c-40)" }}>No key set — verify falls back to the env var.</span>
        )}
      </div>
    </div>
  );
}

function FounderSlotsControls({ disabled }: { disabled: boolean }) {
  // Lives inside PlanEditModal but reads the same /api/founder-spots
  // endpoint the stats card uses, so cap edits / resets from either
  // surface stay in sync via SWR's shared cache.
  const { data, mutate, isLoading } = useSWR<{ active: boolean; spots_left: number; limit: number }>(
    "/api/founder-spots",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [capInput, setCapInput] = useState<string>("");
  const [savingCap, setSavingCap] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);

  // When the reset confirmation expands, scroll the modal's body so
  // the Yes/Cancel buttons are in view. Without this, clicking Reset
  // from the top of the section leaves the buttons below the fold and
  // the user has to hunt for them.
  useEffect(() => {
    if (confirmReset) {
      confirmRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [confirmReset]);

  // Hydrate the input from the server once values arrive. Subsequent
  // server refreshes don't clobber an unsaved edit — same pattern as
  // ModelDefaultsPanel.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    hydratedRef.current = true;
    setCapInput(String(data.limit));
  }, [data]);

  async function saveCap() {
    const parsed = Number(capInput);
    if (!Number.isInteger(parsed) || parsed < 0) {
      toast.error("Enter a whole number ≥ 0");
      return;
    }
    setSavingCap(true);
    try {
      const res = await fetch("/api/admin/founder-limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: parsed }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Update failed (${res.status})`);
      await mutate();
      toast.success(`Founder cap set to ${parsed}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSavingCap(false);
    }
  }

  async function doReset() {
    setResetting(true);
    try {
      const res = await fetch("/api/admin/reset-founder-slots", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Reset failed (${res.status})`);
      await mutate();
      toast.success("Founder slots reset");
      setConfirmReset(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setResetting(false);
    }
  }

  const inputCls = "w-full px-3 py-2 rounded-lg text-sm outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400";
  const dirty = data ? String(data.limit) !== capInput.trim() : false;

  return (
    <div className="rounded-xl p-3 space-y-3 bg-zinc-50 ring-1 ring-zinc-200">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-zinc-700">Founder slot counter</p>
        {isLoading || !data ? (
          <p className="text-[11px] text-zinc-500">Loading…</p>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold tabular-nums bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300">
            {data.spots_left} of {data.limit} remaining
          </span>
        )}
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <label className="text-[11px] font-semibold text-zinc-600">Cap</label>
          <input
            type="number"
            min={0}
            step={1}
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            disabled={disabled || savingCap || !data}
            placeholder="e.g. 100"
            className={inputCls + " tabular-nums"}
          />
        </div>
        <button
          type="button"
          onClick={saveCap}
          disabled={disabled || savingCap || !dirty || !data}
          className="h-[36px] px-3 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50"
          style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
        >
          {savingCap ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner size={12} className="text-white" />
              Saving…
            </span>
          ) : "Update cap"}
        </button>
      </div>

      {!confirmReset ? (
        <button
          type="button"
          onClick={() => setConfirmReset(true)}
          disabled={disabled || !data}
          className="inline-flex items-center justify-center gap-1.5 w-full py-2 rounded-lg text-xs font-semibold transition-all bg-white text-red-600 ring-1 ring-red-200 hover:bg-red-50 hover:ring-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RotateCcw size={12} />
          Reset slot counter
        </button>
      ) : (
        <div ref={confirmRef} className="rounded-lg p-3 space-y-2 bg-red-50 ring-1 ring-red-200">
          <p className="text-xs font-semibold text-red-700">Reset founder slots?</p>
          <p className="text-[11px] text-red-700/80">
            Sets the counter back to 0 and clears the claims log. Existing Founder subscriptions are unaffected, but new claims will start counting from 0 again.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={doReset}
              disabled={resetting}
              className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50 bg-red-600 text-white"
            >
              {resetting ? (
                <span className="inline-flex items-center justify-center gap-1.5">
                  <Spinner size={12} className="text-white" />
                  Resetting…
                </span>
              ) : "Yes, reset"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              disabled={resetting}
              className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NicheLimitOverrideModal({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Pre-fill with the current override; blank means "no override".
  const [input, setInput] = useState<string>(
    user.nicheLimitOverride !== null ? String(user.nicheLimitOverride) : ""
  );
  const [saving, setSaving] = useState(false);

  const planLimitLabel = user.planDefaultLimit === null
    ? "Unlimited"
    : `${user.planDefaultLimit}`;
  const effectiveLabel = user.effectiveNicheLimit === null
    ? "Unlimited"
    : `${user.effectiveNicheLimit}`;

  async function submit(override: number | null) {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(user.email)}/niche-limit`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ override }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Save failed (${res.status})`);
      toast.success(override === null ? "Override cleared" : `Niche limit set to ${override}`);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function handleApply() {
    const trimmed = input.trim();
    if (trimmed === "") {
      submit(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0) {
      toast.error("Enter a non-negative integer, or leave blank to clear the override.");
      return;
    }
    submit(n);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !saving) onClose(); }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Override niche limit</DialogTitle>
          <DialogDescription>
            Replace the user&apos;s plan-derived niche cap with a custom value. Leave blank to clear the
            override and fall back to the plan default.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl p-3 space-y-3"
          style={{ background: "oklch(0 0 0 / 0.03)", border: "1px solid var(--bd-7)" }}>
          <p className="text-xs font-mono text-center truncate" style={{ color: "var(--c-78)" }}>{user.email}</p>
          <div className="grid grid-cols-4 gap-2 text-[10px]" style={{ color: "var(--c-50)" }}>
            {[
              { label: "Plan", value: user.plan ?? "—" },
              { label: "Plan default", value: planLimitLabel },
              { label: "Active", value: effectiveLabel },
              { label: "Used", value: String(user.nichesUsed) },
            ].map((cell) => (
              <div key={cell.label} className="flex flex-col items-center text-center gap-1">
                <p className="uppercase tracking-wide leading-none">{cell.label}</p>
                <p className="text-sm font-semibold tabular-nums leading-none" style={{ color: "var(--c-90)" }}>
                  {cell.value}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
            New override (blank = clear)
          </label>
          <input
            type="number"
            min={0}
            step={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={saving}
            placeholder="e.g. 50"
            className="w-full px-3 py-2.5 rounded-lg text-sm outline-none tabular-nums"
            style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
          />
        </div>

        <DialogFooter>
          <button
            onClick={handleApply}
            disabled={saving}
            className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: "oklch(0.55 0.15 145)", color: "white" }}
          >
            {saving ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner size={14} className="text-white" />
                Saving…
              </span>
            ) : "Apply"}
          </button>
          {user.nicheLimitOverride !== null && (
            <button
              onClick={() => submit(null)}
              disabled={saving}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.55 0.22 25)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}
            >
              Clear override
            </button>
          )}
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
            style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
          >
            Cancel
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SK = { background: "var(--skeleton)" };
const PER_PAGE = 10;

function Pagination({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  if (total === 0) return null;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const from = (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, total);
  return (
    <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: "1px solid oklch(0 0 0 / 0.06)" }}>
      <p className="text-xs" style={{ color: "oklch(0.50 0 0)" }}>{from}–{to} of {total}</p>
      <div className="flex items-center gap-1">
        <button onClick={() => onChange(page - 1)} disabled={page === 1}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          style={{ background: "oklch(0 0 0 / 0.05)", color: "oklch(0.45 0 0)" }}>
          Prev
        </button>
        <span className="px-2 text-xs font-medium" style={{ color: "oklch(0.45 0 0)" }}>{page} / {totalPages}</span>
        <button onClick={() => onChange(page + 1)} disabled={page === totalPages}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          style={{ background: "oklch(0 0 0 / 0.05)", color: "oklch(0.45 0 0)" }}>
          Next
        </button>
      </div>
    </div>
  );
}

function AdminSkeleton() {
  return (
    <main className="flex-1 w-full px-[30px] py-8 sm:py-12 space-y-6 sm:space-y-10">
        {/* Page heading */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl animate-pulse" style={SK} />
          <div className="space-y-2">
            <div className="h-6 w-44 rounded animate-pulse" style={SK} />
            <div className="h-3 w-56 rounded animate-pulse" style={SK} />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 p-1 rounded-xl"
          style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)" }}>
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex-1 h-8 rounded-lg animate-pulse" style={SK} />
          ))}
        </div>

        {/* Stats cards */}
        <div className="rounded-2xl space-y-3" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07)" }}>
          <div className="h-3 w-10 rounded animate-pulse" style={SK} />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-[10px]">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="p-6 rounded-2xl space-y-4"
                style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.06)" }}>
                <div className="flex items-center justify-between">
                  <div className="h-3 w-16 rounded animate-pulse" style={SK} />
                  <div className="w-8 h-8 rounded-lg animate-pulse" style={SK} />
                </div>
                <div className="h-8 w-12 rounded animate-pulse" style={SK} />
              </div>
            ))}
          </div>
        </div>

        {/* Activity chart */}
        <div className="p-5 rounded-2xl space-y-4" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07)" }}>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="space-y-2">
              <div className="h-3 w-40 rounded animate-pulse" style={SK} />
              <div className="flex gap-4">
                {[...Array(3)].map((_, i) => <div key={i} className="h-3 w-16 rounded animate-pulse" style={SK} />)}
              </div>
            </div>
            <div className="h-7 w-36 rounded-lg animate-pulse" style={SK} />
          </div>
          <div className="h-[150px] rounded-xl animate-pulse" style={SK} />
        </div>

        {/* Users section */}
        <div className="rounded-2xl space-y-4" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07)" }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl animate-pulse" style={SK} />
            <div className="h-5 w-16 rounded animate-pulse" style={SK} />
          </div>
          <div className="h-[72px] rounded-2xl animate-pulse" style={SK} />
          <SkeletonRows cols={5} />
        </div>
      </main>
  );
}

function SkeletonRows({ cols, rows = 3 }: { cols: number; rows?: number }) {
  const widths = ["w-36", "w-20", "w-16", "w-24", "w-12", "w-16", "w-10"];
  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid oklch(0 0 0 / 0.07)" }}>
      <table className="w-full border-collapse">
        <tbody>
          {[...Array(rows)].map((_, r) => (
            <tr key={r} style={{ borderBottom: "1px solid oklch(0 0 0 / 0.05)" }}>
              {[...Array(cols)].map((_, c) => (
                <td key={c} className="py-3 px-4">
                  <div className={`h-4 ${widths[c % widths.length]} rounded animate-pulse`} style={SK} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Subtitle under the page heading, per tab. Says what the view is for, not
 *  what it contains — the view itself shows that. */
const TAB_BLURB: Record<string, string> = {
  stats:     "Signups, revenue and production at a glance",
  activity:  "What has been created over time, and by whom",
  users:     "Every account, its plan and its keys",
  projects:  "Every video, its progress and what it cost",
  freeusage: "Perks Heclus pays for, and who is using them",
  revenue:   "Payments, plans and reconciliation",
  reports:   "Generated reports and exports",
  logs:      "Errors and events from the running app",
  emails:    "Inbound and outbound support mail",
  support:   "Tickets from customers",
  agent:     "Teach the agent, and switch it on or off",
  reviews:   "What users think of the product",
  features:  "What customers have asked for, and how often",
  memory:    "Notes this dashboard keeps for itself",
  setup:     "Keys, models, quotas and payment configuration",
};

/** Page heading, where it should differ from the sidebar label. */
const TAB_HEADING: Record<string, string> = {
  agent: "Heclus AI Agent",
};

const ADMIN_NAV = [
  { id: "stats",    label: "Stats",    icon: BarChart3 },
  // Activity carries both panels: the niches/videos/users series and the
  // videos-created chart that used to be its own Usage tab. Two tabs of the
  // same question, each holding half the answer.
  { id: "activity", label: "Activity", icon: TrendingUp },
  { id: "users",    label: "Users",    icon: Users },
  { id: "projects", label: "Videos",   icon: Clapperboard },
  { id: "freeusage", label: "Free Resources Usage", icon: Gift },
  { id: "revenue",  label: "Revenue",  icon: DollarSign },
  { id: "reports",  label: "Reports",  icon: FileText },
  { id: "logs",     label: "Logs",     icon: FileText },
  { id: "emails",   label: "Emails",   icon: Mail },
  { id: "support",  label: "Support",  icon: LifeBuoy },
  // Sidebar keeps the short label; the page heading spells it out via
  // TAB_HEADING below, where there is room for it.
  { id: "agent",    label: "Heclus agent", icon: Bot },
  { id: "reviews",  label: "Feedback", icon: Star },
  { id: "features", label: "Feature requests", icon: Lightbulb },
  { id: "memory",   label: "Memory",   icon: MemoryStick },
  { id: "setup",    label: "Config",   icon: Settings },
] as const;

export default function AdminPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  // Below lg the sidebar is a drawer, opened from the menu row under the
  // header. Same shape as the client dashboard.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      if (!data.user || !isAdminUser(data.user)) {
        router.push("/");
      } else {
        setUserEmail(data.user.email ?? "");
        setAuthChecked(true);
      }
    });
    return () => { cancelled = true; };
  }, [router]);

  const { data, isLoading, mutate } = useSWR<AdminStatsResponse>(
    authChecked ? STATS_KEY : null,
    fetcher
  );

  // Per-user video counts for the Users table (Total / Completed / In
  // progress), derived once from the projects list. Same completion +
  // in-progress predicate as the status-filter rows. Declared here — with
  // the other hooks, before any early return — so hook order stays stable.
  const videoCountsByEmail = useMemo(() => {
    const m = new Map<string, { total: number; completed: number; inProgress: number }>();
    for (const p of (data?.projects ?? [])) {
      if (!p.userEmail) continue;
      const c = m.get(p.userEmail) ?? { total: 0, completed: 0, inProgress: 0 };
      c.total++;
      if (p.isComplete) c.completed++;
      else if (p.currentState > 1) c.inProgress++;
      m.set(p.userEmail, c);
    }
    return m;
  }, [data?.projects]);

  // Revenue tab reads everything (Total/MRR/ARR/paying count + chart)
  // from the immutable revenue_events ledger so the numbers survive
  // user deletion. MRR and ARR are rolling-window actual-revenue
  // figures (last 30 / 365 days), not amortized recurring math.
  const { data: revenue } = useSWR<{
    totalCents: number;
    byPlan: Record<string, { cents: number; count: number }>;
    mrrCents: number;
    arrCents: number;
    payingUserCount: number;
    launchedAt: string | null;
    last12Months: { month: string; amountCents: number }[];
    daily: { date: string; amountCents: number; count: number }[];
    recentEvents: { amountCents: number; occurredAt: string | null; userEmail: string | null; plan: string | null; eventType: string | null; dodoPaymentId: string | null }[];
    eventCount: number;
    unconverted: { count: number; currencies: string[] };
  }>(authChecked ? "/api/admin/revenue" : null, fetcher);

  const { data: productKeysRaw, isLoading: keysLoading, mutate: mutateKeys } = useSWR<ProductApiKey[]>(
    authChecked ? "/api/admin/product-keys" : null,
    fetcher
  );
  const productKeys: ProductApiKey[] = Array.isArray(productKeysRaw) ? productKeysRaw : [];

  // Stats card displays the founder-slot count; editing the cap and
  // resetting the counter now live inside the Plans tab → Founder
  // plan modal (FounderSlotsControls). SWR's shared cache means edits
  // there reflect here on the next focus/render.
  const { data: founderSpots } = useSWR<{ active: boolean; spots_left: number; limit: number }>(
    authChecked ? "/api/founder-spots" : null,
    fetcher,
  );

  const [removing, setRemoving] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AdminUser | null>(null);
  // Open kebab menu (per user email). Click-outside closes it; only
  // one menu open at a time so the table can't end up cluttered.
  const [openUserMenu, setOpenUserMenu] = useState<string | null>(null);
  const [promotingUser, setPromotingUser] = useState<string | null>(null);
  // Modal confirm for "Make admin" — promotion is reversible via the
  // Remove admin action below, but we still force a deliberate click
  // on promotion since admin powers are sensitive.
  const [promoteTarget, setPromoteTarget] = useState<AdminUser | null>(null);
  // Demotion (Remove admin) state — mirrors the promote pair so the
  // spinner / confirm flow looks identical from the user's side.
  const [demotingUser, setDemotingUser] = useState<string | null>(null);
  const [demoteTarget, setDemoteTarget] = useState<AdminUser | null>(null);
  // Track which user row is mid-flag so the kebab button shows a
  // spinner and the menu item disables itself during the request.
  const [flaggingProdTest, setFlaggingProdTest] = useState<string | null>(null);
  const [settingSub, setSettingSub] = useState<string | null>(null);
  const [settingPlan, setSettingPlan] = useState<string | null>(null);
  const [usersPage, setUsersPage] = useState(1);
  const [userSearch, setUserSearch] = useState("");
  // "zero-video" / "no-setup" are cross-cutting slices (they overlap the
  // plan buckets), matched by predicate rather than bucketOf below.
  type PlanBucket = "all" | "admin" | "founder" | "pro" | "starter" | "free" | "pending" | "zero-video" | "no-setup" | "anthropic";
  const [planFilter, setPlanFilter] = useState<PlanBucket>("all");
  const [nicheLimitUser, setNicheLimitUser] = useState<AdminUser | null>(null);
  const [projectsPage, setProjectsPage] = useState(1);
  // Single search input shared by both Videos sub-tabs (General +
  // Cost) — both render rows out of the same sortedProjects array
  // so one filter feeds both tables. Matches against title (topic),
  // channel name, user email, and project ID for flexibility.
  const [projectSearch, setProjectSearch] = useState("");
  // Status/step dropdown next to the search box. Applies to both Videos
  // sub-tabs, same as the search, since they render the same rows.
  const [projectStatusFilter, setProjectStatusFilter] = useState("all");
  // Sub-tabs inside the Videos section. General = existing table.
  // Cost = the per-step usage breakdown introduced by the
  // project_costs ledger.
  const [videosSubTab, setVideosSubTab] = usePersistentTab<"general" | "cost">(
    "videos", "general", ["general", "cost"],
  );
  // When a Cost-table row is clicked we replace the table with a
  // details view of that project. null = table view. Cleared by the
  // back button in the details view, by switching sub-tabs, or by
  // typing into the search (so the user can refine and pick again).
  const [selectedCostProject, setSelectedCostProject] = useState<AdminProject | null>(null);
  // Same idea for the General videos table. Separate state from
  // selectedCostProject so each sub-tab's selection survives the
  // other sub-tab's interactions until an explicit clear.
  const [selectedGeneralProject, setSelectedGeneralProject] = useState<AdminProject | null>(null);
  const [activityView, setActivityView] = usePersistentTab<"daily" | "weekly" | "monthly">(
    "stats.activity", "daily", ["daily", "weekly", "monthly"],
  );
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [hoveredRevIdx, setHoveredRevIdx] = useState<number | null>(null);
  // Revenue tab: optional date-range + plan filters for the payments
  // table. Dates are yyyy-mm-dd strings straight from
  // <input type="date">; empty = off. Plan "" = all plans.
  const [revDateFrom, setRevDateFrom] = useState("");
  const [revDateTo, setRevDateTo] = useState("");
  const [revPlanFilter, setRevPlanFilter] = useState("");
  const [activeTab, setActiveTab] = usePersistentTab<
    "stats" | "activity" | "usage" | "users" | "projects" | "freeusage" | "revenue" | "agent" | "reports" | "logs" | "emails" | "support" | "reviews" | "features" | "memory" | "setup"
  >(
    "main",
    "stats",
    ["stats", "activity", "usage", "users", "projects", "freeusage", "revenue", "agent", "reports", "logs", "emails", "support", "reviews", "features", "memory", "setup"],
  );
  // "usage" stays accepted as a stored value: it is what localStorage holds
  // for anyone who last left the admin on the old Usage tab, and mapping it
  // here saves a migration for a rename.
  const navTab = activeTab === "usage" ? "activity" : activeTab;
  const showActivity = navTab === "activity";

  // Usage tab range. "today" reads the hourly series; 7d/30d slice the
  // daily one. Persisted like the other tab selections so a refresh
  // doesn't bounce the admin back to a range they didn't pick.
  const [usageRange, setUsageRange] = usePersistentTab<"today" | "7d" | "30d">(
    "usage.range", "7d", ["today", "7d", "30d"],
  );
  const [usageHoveredIdx, setUsageHoveredIdx] = useState<number | null>(null);

  // Per-project cost rollups for the Videos → Cost sub-tab. Only
  // fetched when that sub-tab is selected so the DB isn't hit on
  // every admin page load. Returns aggregated units per
  // (project_id, display_column) — the table just renders.
  const { data: costsData } = useSWR<ProjectCostsResponse>(
    authChecked && activeTab === "projects" && videosSubTab === "cost"
      ? "/api/admin/project-costs"
      : null,
    fetcher
  );

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  async function handleRemoveUser(email: string) {
    setRemoving(email);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to remove");
      toast.success(`Removed ${email}`);
      setUsersPage(1);
      setRemoveTarget(null);
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove user");
    } finally {
      setRemoving(null);
    }
  }

  async function handleMakeAdmin(email: string) {
    setPromotingUser(email);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}/make-admin`, { method: "POST" });
      const json = await res.json().catch(() => ({})) as { ok?: boolean; alreadyAdmin?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to promote");
      toast.success(json.alreadyAdmin ? `${email} is already an admin` : `${email} is now an admin`);
      setPromoteTarget(null);
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to make admin");
    } finally {
      setPromotingUser(null);
    }
  }

  async function handleRemoveAdmin(email: string) {
    setDemotingUser(email);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}/remove-admin`, { method: "POST" });
      const json = await res.json().catch(() => ({})) as { ok?: boolean; alreadyNotAdmin?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to remove admin");
      toast.success(json.alreadyNotAdmin ? `${email} was not an admin` : `${email} is no longer an admin`);
      setDemoteTarget(null);
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove admin");
    } finally {
      setDemotingUser(null);
    }
  }

  async function handleFlagProductionTest(email: string) {
    setFlaggingProdTest(email);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}/flag-production-test`, { method: "POST" });
      const json = await res.json().catch(() => ({})) as { ok?: boolean; alreadyFlagged?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to flag");
      toast.success(json.alreadyFlagged ? `${email} is already a production test account` : `${email} flagged as production test`);
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to flag account");
    } finally {
      setFlaggingProdTest(null);
    }
  }

  // Flag a non-admin user's subscription state (Paid / Expired / Demo·free).
  async function handleSetSubscription(email: string, status: "paid" | "expired" | "demo") {
    setSettingSub(email);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}/subscription`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to update subscription");
      const label = status === "paid" ? "Paid" : status === "expired" ? "Subscription expired" : "Demo/free";
      toast.success(`${email} set to ${label}`);
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update subscription");
    } finally {
      setSettingSub(null);
    }
  }

  // Switch a non-admin user's paid plan tier (Starter / Pro / Founder).
  // Setting a tier marks them an active subscriber on that plan.
  async function handleSetPlan(email: string, plan: "starter" | "pro" | "founder") {
    setSettingPlan(email);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to update plan");
      const label = plan.charAt(0).toUpperCase() + plan.slice(1);
      toast.success(`${email} set to ${label}`);
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update plan");
    } finally {
      setSettingPlan(null);
    }
  }

  if (!authChecked) return (
    <div className="min-h-screen flex flex-col admin-surfaces" data-theme="light" style={{ background: "var(--bg-page)" }}>
      <header className="flex items-center justify-between px-4 sm:px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <Link href="/dashboard" className="flex items-center gap-3 transition-opacity hover:opacity-80">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
            <span className="text-sm tracking-tight ml-1" style={{ color: "var(--c-50)" }}>Admin</span>
          </div>
        </Link>
      </header>
      <AdminSkeleton />
    </div>
  );

  const stats = data?.stats;
  const users: AdminUser[] = data?.users ?? [];
  const projects = data?.projects ?? [];

  // Single source of truth for which bucket a row belongs to. Used by
  // both the count strip and the active filter; keeping them aligned
  // means a click on "Founder · 3" always yields exactly 3 rows.
  //
  // The plan check is lowercased+trimmed so casing/whitespace in
  // app_metadata.plan doesn't push a paid user into the Free/Demo
  // bucket. Paid users whose plan field is missing entirely (the Dodo
  // webhook sets paid:true but not plan; only /api/dodo/verify writes
  // the plan, and that only fires if the user lands on the callback)
  // fall back to "starter" — the cheapest paid tier — instead of
  // Free/Demo, since they did pay something.
  // The plan buckets only. "anthropic", like "zero-video" and "no-setup", is a
  // cross-cutting flag a user can have in any plan, so it is never a bucket.
  function bucketOf(u: AdminUser): Exclude<PlanBucket, "all" | "zero-video" | "no-setup" | "anthropic"> {
    if (u.isAdmin) return "admin";
    if (u.status === "Pending") return "pending";
    const planNorm = (u.plan ?? "").toLowerCase().trim();
    if (planNorm === "founder") return "founder";
    if (planNorm === "pro") return "pro";
    if (planNorm === "starter") return "starter";
    if (u.status === "Paid") return "starter";
    return "free";
  }

  // Customers who never created a video project / never completed a
  // channel setup (no niche consumed). Admins and pending invites are
  // excluded — pending rows always carry zero counts and would inflate
  // both slices.
  const hasZeroVideos = (u: AdminUser) => !u.isAdmin && u.status !== "Pending" && u.projectCount === 0;
  const hasNoSetup = (u: AdminUser) => !u.isAdmin && u.status !== "Pending" && u.nichesUsed === 0;
  // Excludes admins and pending invites, same as the two filters above it:
  // these pills are meant to describe customers, and internal accounts (which
  // have keys for testing) otherwise dominate a small count.
  const hasAnthropicKey = (u: AdminUser) =>
    !u.isAdmin && u.status !== "Pending" && u.hasAnthropicKey;

  const userSearchLower = userSearch.trim().toLowerCase();
  const filteredUsers = users.filter((u) => {
    const matchesBucket =
      planFilter === "all" ? true
      : planFilter === "zero-video" ? hasZeroVideos(u)
      : planFilter === "no-setup" ? hasNoSetup(u)
      : planFilter === "anthropic" ? hasAnthropicKey(u)
      : bucketOf(u) === planFilter;
    if (!matchesBucket) return false;
    if (userSearchLower && !u.email.toLowerCase().includes(userSearchLower)) return false;
    return true;
  });
  // Tables show most-recent items first. Nulls-last (using Infinity)
  // keeps users who've never signed in (no lastSignIn) at the bottom
  // instead of bubbling to the top, where they'd be misread as "most
  // recent." Same idea for paidAt on the revenue table below.
  const sortedFilteredUsers = [...filteredUsers].sort((a, b) => {
    const ta = a.lastSignIn ? new Date(a.lastSignIn).getTime() : -Infinity;
    const tb = b.lastSignIn ? new Date(b.lastSignIn).getTime() : -Infinity;
    return tb - ta;
  });
  const projectSearchLower = projectSearch.trim().toLowerCase();
  const searchedProjects = projectSearchLower
    ? projects.filter((p) => {
        const haystack = [
          p.selectedTopic,
          p.channelName,
          p.userEmail,
          p.id,
        ].filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(projectSearchLower);
      })
    : projects;
  const statusFilter = PROJECT_STATUS_FILTERS.find((f) => f.id === projectStatusFilter) ?? PROJECT_STATUS_FILTERS[0];
  const filteredProjects = statusFilter.id === "all" ? searchedProjects : searchedProjects.filter(statusFilter.match);
  const sortedProjects = [...filteredProjects].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : -Infinity;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : -Infinity;
    return tb - ta;
  });
  const pagedUsers = sortedFilteredUsers.slice((usersPage - 1) * PER_PAGE, usersPage * PER_PAGE);
  const pagedProjects = sortedProjects.slice((projectsPage - 1) * PER_PAGE, projectsPage * PER_PAGE);

  // Top-of-Users-tab breakdown so the admin can see plan distribution
  // and pending invites at a glance without scanning the table. Same
  // source of truth as the table itself.
  const userBreakdown = users.reduce(
    (acc, u) => { acc[bucketOf(u)]++; return acc; },
    { admin: 0, founder: 0, pro: 0, starter: 0, free: 0, pending: 0 }
  );

  // Active vs dormant accounts for the Stats cards, computed UI-side
  // from the users list the stats API already ships. Active = signed in
  // within the last 30 days; dormant = the rest (including never signed
  // in). Pending invites and admins are excluded, matching the server's
  // activeAccounts count ("Total Users" on the cards).
  const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  const accountUsers = users.filter((u) => !u.isAdmin && u.status !== "Pending");
  const activeUserCount = stats === undefined ? undefined
    : accountUsers.filter((u) => u.lastSignIn && Date.now() - new Date(u.lastSignIn).getTime() <= ACTIVE_WINDOW_MS).length;
  const dormantUserCount = stats === undefined || activeUserCount === undefined ? undefined
    : Math.max(0, (stats.activeAccounts ?? accountUsers.length) - activeUserCount);

  return (
    <div className="min-h-screen flex flex-col lg:pl-[300px] admin-surfaces" data-theme="light" style={{ background: "var(--bg-page)" }}>
      {/* Full-height sidebar, fixed so it spans the viewport rather than
          starting under the header. Everything else is inset by its width.
          Below lg it is a drawer opened from the menu row. */}
      <aside className={`fixed left-0 bottom-0 top-[117px] lg:top-0 z-40 w-[85vw] sm:w-[380px] lg:w-[300px] flex flex-col transition-transform duration-200 lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
        style={{ background: "var(--bg-header)", borderRight: "1px solid var(--bd-10)" }}>
        <Link href="/dashboard" className="hidden lg:flex items-center gap-3 px-6 h-[69px] shrink-0 transition-opacity hover:opacity-80"
          style={{ borderBottom: "1px solid var(--bd-6)" }}>
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div>
            <span className="text-base font-bold tracking-tight" style={{ color: "var(--c-90)" }}>Heclus</span>
            <span className="text-base tracking-tight ml-1.5" style={{ color: "var(--c-50)" }}>Admin</span>
          </div>
        </Link>
        {/* Thirteen sections, so the list scrolls rather than compressing. */}
        <nav className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1 pl-5 pr-[30px] py-5" style={{ scrollbarWidth: "thin" }}>
          {ADMIN_NAV.map(({ id, label, icon: Icon }) => {
            const on = navTab === id;
            return (
              <button
                key={id}
                onClick={() => { setActiveTab(id); setSidebarOpen(false); }}
                className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-[13px] font-medium text-left transition-all cursor-pointer"
                style={on
                  ? { background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.35)" }
                  : { background: "transparent", color: "var(--c-55)" }}
              >
                <Icon size={15} className="shrink-0" />
                <span className="min-w-0 truncate">{label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      {sidebarOpen && (
        <div
          className="lg:hidden fixed left-0 right-0 bottom-0 top-[117px] z-30"
          style={{ background: "oklch(0 0 0 / 0.4)" }}
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      {/* Header. Fixed, so a spacer below stands in for its height. */}
      <header className="flex items-center justify-between px-4 sm:px-8 py-4 fixed top-0 left-0 right-0 lg:left-[300px] z-50"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <Link href="/dashboard" className="flex lg:hidden items-center gap-3 transition-opacity hover:opacity-80">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
            <span className="text-sm tracking-tight ml-1" style={{ color: "var(--c-50)" }}>Admin</span>
          </div>
        </Link>
        <div className="hidden lg:block" />
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => router.push("/dashboard")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
            style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
          >
            <ArrowLeft size={13} />
            Back
          </button>
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
                <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
                <div
                  className="absolute right-0 top-11 z-50 w-56 rounded-2xl py-3 shadow-2xl"
                  style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}
                >
                  <div className="px-4 pb-3" style={{ borderBottom: "1px solid oklch(1 0 0 / 0.07)" }}>
                    <p className="text-xs font-semibold truncate" style={{ color: "var(--c-88)" }}>
                      {userEmail || "Loading…"}
                    </p>
                  </div>
                  <div className="px-2 pt-2">
                    <Link
                      href="/account"
                      onClick={() => setShowProfileMenu(false)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80"
                      style={{ color: "var(--c-60)" }}
                    >
                      <KeyRound size={13} />
                      <span>Account</span>
                    </Link>
                    <button
                      onClick={() => { setShowProfileMenu(false); handleSignOut(); }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                      style={{ color: "var(--status-danger)" }}
                    >
                      <LogOut size={13} />
                      <span>Sign Out</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="h-[69px] shrink-0" aria-hidden />

      {/* Menu row. Its own bar under the header rather than a control in it,
          fixed so the toggle stays reachable while the drawer is open. */}
      <div className="lg:hidden fixed left-0 right-0 top-[69px] z-50 flex items-center gap-2 px-4 sm:px-8 h-[48px]"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label={sidebarOpen ? "Close menu" : "Open menu"}
          aria-expanded={sidebarOpen}
          className="inline-flex items-center gap-2 py-1.5 pr-2 -ml-1 pl-1 rounded-lg text-[13px] font-medium transition-opacity hover:opacity-70 cursor-pointer"
          style={{ color: "var(--c-70)" }}
        >
          {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
          <span>{ADMIN_NAV.find((t) => t.id === navTab)?.label ?? "Menu"}</span>
        </button>
      </div>
      <div className="lg:hidden h-[48px] shrink-0" aria-hidden />

      <main className="flex-1 w-full px-[30px] py-8 sm:py-12 space-y-6 sm:space-y-10">
        {/* Page heading + Launch action, sharing one row */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {(() => {
              const current = ADMIN_NAV.find((t) => t.id === navTab);
              const Icon = current?.icon ?? BarChart3;
              return (
                <>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
                    <Icon size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
                  </div>
                  <div className="min-w-0">
                    <h1 className="text-2xl font-bold text-foreground">
                      {TAB_HEADING[navTab] ?? current?.label ?? "Admin"}
                    </h1>
                    <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                      {TAB_BLURB[navTab] ?? "Users, projects, and system overview"}
                    </p>
                  </div>
                </>
              );
            })()}
          </div>

          {/* The launch button is gone — launching is a once-ever action and it
              sat one click from every page of the dashboard. The date stays,
              because it is what every "since launch" figure below is measured
              from. Rendered only once the revenue read lands, so a slow request
              never flashes "not launched" at an app that is. */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            {revenue && (
              revenue.launchedAt ? (
                <p className="text-xs" style={{ color: "var(--c-50)" }}>
                  Launched on:{" "}
                  <span className="font-semibold" style={{ color: "var(--c-78)" }}>
                    {new Date(revenue.launchedAt).toLocaleDateString("en", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                </p>
              ) : (
                <p className="text-xs" style={{ color: "var(--c-40)" }}>Not launched yet</p>
              )
            )}
          </div>
        </div>

        {/* Stats cards */}
        <div id="stats" className="rounded-2xl space-y-3" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)", display: activeTab === "stats" ? undefined : "none" }}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "oklch(0.50 0 0)" }}>Stats</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-[10px]">
            <StatCard label="Total Niches"      value={stats?.totalProjects}    icon={FolderOpen}                    />
            <StatCard label="Access Granted"    value={stats?.accessGranted}    icon={Users}         accent="purple" />
            <StatCard label="Total Users"       value={stats?.activeAccounts}   icon={Users}                         />
            <StatCard label="Active Users"      value={activeUserCount}         icon={UserCheck}     accent="green"
              hint={pctOfTotal(activeUserCount, stats?.activeAccounts)} />
            <StatCard label="Dormant Users"     value={dormantUserCount}        icon={UserX}         accent="amber"
              hint={pctOfTotal(dormantUserCount, stats?.activeAccounts)} />
            <StatCard label="Total Videos"      value={stats?.totalProjects}    icon={Film}                          />
            <StatCard label="Videos in Progress" value={stats?.videosInProgress} icon={Clock}        accent="amber"
              hint={pctOfTotal(stats?.videosInProgress, stats?.totalProjects)} />
            <StatCard label="Videos Completed"  value={stats?.completed}        icon={CheckCircle2}  accent="green"
              hint={pctOfTotal(stats?.completed, stats?.totalProjects)} />
          </div>

          {/* Full-width: Available Founder promo slots */}
          <div
            className="flex items-center justify-between gap-3 rounded-xl px-4 py-3"
            style={{
              background: founderSpots?.active === false
                ? "oklch(0.6 0.22 25 / 0.06)"
                : "oklch(0.55 0.15 145 / 0.06)",
              border: founderSpots?.active === false
                ? "1px solid oklch(0.6 0.22 25 / 0.2)"
                : "1px solid oklch(0.55 0.15 145 / 0.2)",
            }}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                style={{
                  background: founderSpots?.active === false ? "oklch(0.6 0.22 25 / 0.12)" : "oklch(0.55 0.15 145 / 0.12)",
                  color: founderSpots?.active === false ? "oklch(0.55 0.22 25)" : "oklch(0.5 0.15 145)",
                }}
              >
                <Sparkles size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "oklch(0.50 0 0)" }}>
                  Founders Promo Slots
                </p>
                <p className="text-xs mt-0.5" style={{ color: "oklch(0.45 0 0)" }}>
                  {founderSpots
                    ? `${founderSpots.spots_left} of ${founderSpots.limit} Founder slot${founderSpots.limit === 1 ? "" : "s"} remaining`
                    : "Loading…"}
                </p>
              </div>
            </div>
            <div className="flex items-end gap-2 shrink-0">
              <div className="flex flex-col items-center text-center">
                <p
                  className="text-2xl font-bold tabular-nums leading-none"
                  style={{
                    color: founderSpots?.active === false ? "oklch(0.55 0.22 25)" : "oklch(0.20 0 0)",
                  }}
                >
                  {founderSpots ? founderSpots.spots_left : "—"}
                </p>
                <p className="text-[10px] font-medium uppercase tracking-wider mt-1 leading-none"
                  style={{ color: founderSpots?.active === false ? "oklch(0.55 0.22 25)" : "oklch(0.5 0.15 145)" }}>
                  {founderSpots?.active === false ? "Promo Ended" : "Available"}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Activity chart */}
        {(() => {
          const raw = data?.activity ?? [];
          const pts = activityView === "daily"
            ? raw.slice(-14)
            : activityView === "weekly"
            ? (() => {
                const last28 = raw.slice(-28);
                return Array.from({ length: 4 }, (_, i) => {
                  const week = last28.slice(i * 7, (i + 1) * 7);
                  return {
                    date: week[0]?.date ?? "",
                    projects: week.reduce((s, d) => s + d.projects, 0),
                    videos: week.reduce((s, d) => s + d.videos, 0),
                    users: week.reduce((s, d) => s + d.users, 0),
                  };
                });
              })()
            : (data?.activityMonthly ?? []);

          const W = 560, PAD_L = 28, PAD_R = 10, PAD_T = 14, PAD_B = 26;
          const H = 150;
          const plotW = W - PAD_L - PAD_R;
          const plotH = H - PAD_T - PAD_B;
          const n = pts.length;
          const globalMax = Math.max(...pts.map(p => p.projects), ...pts.map(p => p.videos), ...pts.map(p => p.users), 1);

          const coords = (key: "projects" | "videos" | "users") => pts.map((p, i) => ({
            x: PAD_L + (n <= 1 ? plotW / 2 : i * plotW / (n - 1)),
            y: PAD_T + (1 - p[key] / globalMax) * plotH,
          }));

          function toPath(cs: { x: number; y: number }[]) {
            return cs.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
          }

          function toArea(cs: { x: number; y: number }[]) {
            if (cs.length === 0) return "";
            const base = (PAD_T + plotH).toFixed(1);
            return `${toPath(cs)} L${cs[cs.length - 1].x.toFixed(1)},${base} L${cs[0].x.toFixed(1)},${base} Z`;
          }

          const projCoords = coords("projects");
          const videoCoords = coords("videos");
          const userCoords = coords("users");
          const showEvery = activityView === "daily" ? 2 : 1;

          function fmtLabel(date: string, i: number) {
            if (activityView === "weekly") return `Wk ${i + 1}`;
            if (activityView === "monthly") return new Date(date + "-01").toLocaleDateString("en", { month: "short" });
            return new Date(date + "T00:00:00").toLocaleDateString("en", { month: "short", day: "numeric" });
          }

          function tooltipDate(date: string, i: number) {
            if (activityView === "weekly") return `Week ${i + 1}`;
            if (activityView === "monthly") return new Date(date + "-01").toLocaleDateString("en", { month: "long", year: "numeric" });
            return new Date(date + "T00:00:00").toLocaleDateString("en", { month: "short", day: "numeric" });
          }

          const totalProjects = pts.reduce((s, p) => s + p.projects, 0);
          const totalVideos = pts.reduce((s, p) => s + p.videos, 0);
          const totalUsers = pts.reduce((s, p) => s + p.users, 0);
          const periodLabel = activityView === "daily" ? "Last 14 days" : activityView === "weekly" ? "Last 4 weeks" : "Last 12 months";
          const slotW = n > 1 ? plotW / (n - 1) : plotW;

          return (
            <div id="activity" className="p-5 rounded-2xl space-y-4" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)", display: showActivity ? undefined : "none" }}>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider mb-1" style={{ color: "oklch(0.50 0 0)" }}>Activity — {periodLabel}</p>
                  <div className="flex items-center gap-4">
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: "oklch(0.45 0 0)" }}>
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "#9b7ff5" }} />
                      {totalProjects} niches
                    </span>
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: "oklch(0.45 0 0)" }}>
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "var(--status-warn)" }} />
                      {totalVideos} videos
                    </span>
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: "oklch(0.45 0 0)" }}>
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "var(--status-ok)" }} />
                      {totalUsers} new users
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 p-0.5 rounded-lg" style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)" }}>
                  {(["daily", "weekly", "monthly"] as const).map(v => (
                    <button key={v} onClick={() => { setActivityView(v); setHoveredIdx(null); }}
                      className="px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer capitalize"
                      style={activityView === v
                        ? { background: "oklch(0.72 0.25 285)", color: "white" }
                        : { color: "oklch(0.45 0 0)" }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ overflowX: "clip" }}>
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 150 }}>
                  <defs>
                    <linearGradient id="projGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#9b7ff5" stopOpacity="0.2" />
                      <stop offset="100%" stopColor="#9b7ff5" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="videoGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--status-warn)" stopOpacity="0.18" />
                      <stop offset="100%" stopColor="var(--status-warn)" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="userGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--status-ok)" stopOpacity="0.15" />
                      <stop offset="100%" stopColor="var(--status-ok)" stopOpacity="0" />
                    </linearGradient>
                  </defs>

                  {/* Grid lines */}
                  {[0, 0.5, 1].map(t => {
                    const y = PAD_T + (1 - t) * plotH;
                    return (
                      <g key={t}>
                        <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} strokeWidth="1" stroke="rgba(0,0,0,0.06)" />
                        <text x={PAD_L - 4} y={y + 3.5} textAnchor="end" fontSize="8.5" fill="#999">
                          {Math.round(globalMax * t)}
                        </text>
                      </g>
                    );
                  })}

                  {/* Areas */}
                  <path d={toArea(projCoords)} fill="url(#projGrad)" />
                  <path d={toArea(videoCoords)} fill="url(#videoGrad)" />
                  <path d={toArea(userCoords)} fill="url(#userGrad)" />

                  {/* Lines */}
                  <path d={toPath(projCoords)} fill="none" stroke="#9b7ff5" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  <path d={toPath(videoCoords)} fill="none" stroke="var(--status-warn)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  <path d={toPath(userCoords)} fill="none" stroke="var(--status-ok)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

                  {/* Dots */}
                  {projCoords.map((c, i) => (
                    <circle key={i} cx={c.x} cy={c.y} r={hoveredIdx === i ? 4 : 2.5} fill="#9b7ff5" style={{ transition: "r 0.1s" }} />
                  ))}
                  {videoCoords.map((c, i) => (
                    <circle key={i} cx={c.x} cy={c.y} r={hoveredIdx === i ? 4 : 2.5} fill="var(--status-warn)" style={{ transition: "r 0.1s" }} />
                  ))}
                  {userCoords.map((c, i) => (
                    <circle key={i} cx={c.x} cy={c.y} r={hoveredIdx === i ? 4 : 2.5} fill="var(--status-ok)" style={{ transition: "r 0.1s" }} />
                  ))}

                  {/* Hover hit strips */}
                  {projCoords.map((c, i) => (
                    <rect
                      key={i}
                      x={Math.max(c.x - slotW / 2, PAD_L)}
                      y={PAD_T}
                      width={Math.min(slotW, plotW)}
                      height={plotH}
                      fill="transparent"
                      style={{ cursor: "crosshair" }}
                      onMouseEnter={() => setHoveredIdx(i)}
                      onMouseLeave={() => setHoveredIdx(null)}
                    />
                  ))}

                  {/* Tooltip */}
                  {hoveredIdx !== null && hoveredIdx < pts.length && (() => {
                    const pc = projCoords[hoveredIdx];
                    const vc = videoCoords[hoveredIdx];
                    const uc = userCoords[hoveredIdx];
                    const pt = pts[hoveredIdx];
                    const TW = 120, TH = 74, TR = 6;
                    const TX = Math.min(Math.max(pc.x - TW / 2, PAD_L), W - PAD_R - TW);
                    const TY = Math.max(Math.min(pc.y, vc.y, uc.y) - TH - 10, 2);
                    return (
                      <g pointerEvents="none">
                        <rect x={TX} y={TY} width={TW} height={TH} rx={TR} ry={TR}
                          fill="var(--bg-card)" stroke="rgba(0,0,0,0.10)" strokeWidth="1" />
                        <text x={TX + TW / 2} y={TY + 15} textAnchor="middle" fontSize="9.5" fill="#333" fontWeight="600">
                          {tooltipDate(pt.date, hoveredIdx)}
                        </text>
                        <circle cx={TX + 13} cy={TY + 30} r="3" fill="#9b7ff5" />
                        <text x={TX + 21} y={TY + 34} fontSize="9" fill="#666">
                          Niches: <tspan fill="#9b7ff5" fontWeight="700">{pt.projects}</tspan>
                        </text>
                        <circle cx={TX + 13} cy={TY + 46} r="3" fill="var(--status-warn)" />
                        <text x={TX + 21} y={TY + 50} fontSize="9" fill="#666">
                          Videos: <tspan fill="var(--status-warn)" fontWeight="700">{pt.videos}</tspan>
                        </text>
                        <circle cx={TX + 13} cy={TY + 62} r="3" fill="var(--status-ok)" />
                        <text x={TX + 21} y={TY + 66} fontSize="9" fill="#666">
                          Users: <tspan fill="var(--status-ok)" fontWeight="700">{pt.users}</tspan>
                        </text>
                      </g>
                    );
                  })()}

                  {/* X-axis labels */}
                  {pts.map((p, i) => i % showEvery === 0 && (
                    <text key={i} x={projCoords[i].x} y={H - 4} textAnchor="middle" fontSize="8.5" fill="#999">
                      {fmtLabel(p.date, i)}
                    </text>
                  ))}
                </svg>
              </div>
            </div>
          );
        })()}

        {/* Usage chart — videos created per day (single series, so no
            legend box; the heading names it). Reuses the same amber the
            Activity chart uses for videos so the colour keeps meaning
            the same thing across tabs. */}
        {(() => {
          const daily = data?.activity ?? [];
          const isToday = usageRange === "today";
          // Normalised to {label, full, videos} so the chart body doesn't
          // branch on hourly-vs-daily below.
          const pts = isToday
            ? (data?.usageToday ?? []).map((h) => ({
                label: h.hour,
                full: `${h.hour} UTC`,
                videos: h.videos,
              }))
            : (usageRange === "7d" ? daily.slice(-7) : daily.slice(-30)).map((d) => ({
                label: new Date(d.date + "T00:00:00").toLocaleDateString("en", { month: "short", day: "numeric" }),
                full: new Date(d.date + "T00:00:00").toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" }),
                videos: d.videos,
              }));

          const UW = 560, UPAD_L = 30, UPAD_R = 10, UPAD_T = 14, UPAD_B = 26;
          const UH = 360;
          const uPlotW = UW - UPAD_L - UPAD_R;
          const uPlotH = UH - UPAD_T - UPAD_B;
          const un = pts.length;
          const uMax = Math.max(...pts.map((p) => p.videos), 1);
          const uCoords = pts.map((p, i) => ({
            x: UPAD_L + (un <= 1 ? uPlotW / 2 : (i * uPlotW) / (un - 1)),
            y: UPAD_T + (1 - p.videos / uMax) * uPlotH,
          }));
          const uBase = (UPAD_T + uPlotH).toFixed(1);
          const uLine = uCoords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
          const uArea = uCoords.length
            ? `${uLine} L${uCoords[uCoords.length - 1].x.toFixed(1)},${uBase} L${uCoords[0].x.toFixed(1)},${uBase} Z`
            : "";
          const uTotal = pts.reduce((s, p) => s + p.videos, 0);
          const uSlotW = un > 1 ? uPlotW / (un - 1) : uPlotW;
          // Thin the x labels so they never collide; 8 ticks fits 560px.
          const uShowEvery = un <= 8 ? 1 : Math.ceil(un / 8);
          // Integer ticks only — videos are whole numbers, and a
          // proportional [0, .5, 1] split prints "0 1 1" when the max is 1.
          const uTicks = uMax <= 2
            ? Array.from({ length: uMax + 1 }, (_, i) => i)
            : [0, Math.round(uMax / 2), uMax];
          const rangeLabel = isToday ? "Today · by hour (UTC)" : usageRange === "7d" ? "Last 7 days" : "Last 30 days";

          return (
            <div id="usage" className="p-5 rounded-2xl space-y-4" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)", display: showActivity ? undefined : "none" }}>
              <div className="flex items-end justify-between flex-wrap gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider mb-1" style={{ color: "oklch(0.50 0 0)" }}>
                    Videos created — {rangeLabel}
                  </p>
                  <p className="text-2xl font-semibold leading-none" style={{ color: "oklch(0.25 0 0)" }}>
                    {uTotal}
                    <span className="text-xs font-normal ml-1.5" style={{ color: "oklch(0.50 0 0)" }}>
                      total
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-1 p-0.5 rounded-lg" style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)" }}>
                  {([["today", "Today"], ["7d", "7 days"], ["30d", "1 month"]] as const).map(([v, label]) => (
                    <button key={v} onClick={() => { setUsageRange(v); setUsageHoveredIdx(null); }}
                      className="px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer"
                      style={usageRange === v
                        ? { background: "oklch(0.72 0.25 285)", color: "white" }
                        : { color: "oklch(0.45 0 0)" }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ overflowX: "clip" }}>
                <svg viewBox={`0 0 ${UW} ${UH}`} className="w-full" style={{ height: 360 }}>
                  <defs>
                    <linearGradient id="usageGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--status-warn)" stopOpacity="0.18" />
                      <stop offset="100%" stopColor="var(--status-warn)" stopOpacity="0" />
                    </linearGradient>
                  </defs>

                  {/* Grid + y labels */}
                  {uTicks.map((t) => {
                    const y = UPAD_T + (1 - t / uMax) * uPlotH;
                    return (
                      <g key={t}>
                        <line x1={UPAD_L} y1={y} x2={UW - UPAD_R} y2={y} strokeWidth="1" stroke="rgba(0,0,0,0.06)" />
                        <text x={UPAD_L - 4} y={y + 3.5} textAnchor="end" fontSize="8.5" fill="#999">{t}</text>
                      </g>
                    );
                  })}

                  <path d={uArea} fill="url(#usageGrad)" />
                  <path d={uLine} fill="none" stroke="var(--status-warn)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

                  {uCoords.map((c, i) => (
                    <circle key={i} cx={c.x} cy={c.y} r={usageHoveredIdx === i ? 4 : 2.5} fill="var(--status-warn)" style={{ transition: "r 0.1s" }} />
                  ))}

                  {/* Hover hit strips — wider than the dots so the
                      tooltip is reachable without pixel-hunting. */}
                  {uCoords.map((c, i) => (
                    <rect
                      key={i}
                      x={Math.max(c.x - uSlotW / 2, UPAD_L)}
                      y={UPAD_T}
                      width={Math.min(uSlotW, uPlotW)}
                      height={uPlotH}
                      fill="transparent"
                      style={{ cursor: "crosshair" }}
                      onMouseEnter={() => setUsageHoveredIdx(i)}
                      onMouseLeave={() => setUsageHoveredIdx(null)}
                    />
                  ))}

                  {usageHoveredIdx !== null && usageHoveredIdx < un && (() => {
                    const c = uCoords[usageHoveredIdx];
                    const pt = pts[usageHoveredIdx];
                    const TW = 116, TH = 42, TR = 6;
                    const TX = Math.min(Math.max(c.x - TW / 2, UPAD_L), UW - UPAD_R - TW);
                    const TY = Math.max(c.y - TH - 10, 2);
                    return (
                      <g pointerEvents="none">
                        <line x1={c.x} y1={UPAD_T} x2={c.x} y2={UPAD_T + uPlotH} strokeWidth="1" stroke="rgba(0,0,0,0.14)" strokeDasharray="3 3" />
                        <rect x={TX} y={TY} width={TW} height={TH} rx={TR} ry={TR} fill="var(--bg-card)" stroke="rgba(0,0,0,0.10)" strokeWidth="1" />
                        <text x={TX + TW / 2} y={TY + 16} textAnchor="middle" fontSize="9.5" fill="#333" fontWeight="600">{pt.full}</text>
                        <circle cx={TX + 13} cy={TY + 30} r="3" fill="var(--status-warn)" />
                        <text x={TX + 21} y={TY + 33} fontSize="9" fill="#666">
                          Videos: <tspan fill="#333" fontWeight="700">{pt.videos}</tspan>
                        </text>
                      </g>
                    );
                  })()}

                  {/* X-axis labels */}
                  {pts.map((p, i) => i % uShowEvery === 0 && (
                    <text key={i} x={uCoords[i].x} y={UH - 4} textAnchor="middle" fontSize="8.5" fill="#999">
                      {p.label}
                    </text>
                  ))}
                </svg>
              </div>

              {un === 0 && (
                <p className="text-xs text-center py-2" style={{ color: "oklch(0.55 0 0)" }}>
                  No usage data for this range yet.
                </p>
              )}
            </div>
          );
        })()}

        {/* Users section */}
        <section id="users" className="rounded-2xl space-y-5 max-w-full min-w-0" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", padding: "10px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)", display: activeTab === "users" ? undefined : "none" }}>
          {/* Icon and title dropped — the page heading names this view. The
              count chip stays: it is data, not a label. */}
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-0.5 rounded-full"
              style={{ background: "var(--bg-elevated)", border: "1px solid oklch(1 0 0 / 0.06)", color: "var(--c-42)" }}>
              {users.length}
            </span>
          </div>

          {/* Plan-distribution strip. Colors mirror the row badges so
              admin can map a stat back to its rows at a glance. Clicking
              a pill filters the table to that bucket; clicking the
              active pill (or Total) clears the filter. */}
          <div className="flex flex-wrap gap-2 text-xs">
            {([
              { id: "all",        label: "Total",           value: users.length,                        accent: "oklch(0.55 0.15 220)", bg: "oklch(0 0 0 / 0.04)",          color: "var(--c-65)",       border: "oklch(0 0 0 / 0.08)" },
              { id: "admin",      label: "Admin",           value: userBreakdown.admin,                 accent: "oklch(0.72 0.18 75)",  bg: "oklch(0.72 0.18 75 / 0.15)",   color: "oklch(0.6 0.18 75)",  border: "oklch(0.72 0.18 75 / 0.4)" },
              { id: "founder",    label: "Founder",         value: userBreakdown.founder,               accent: "oklch(0.55 0.15 145)", bg: "oklch(0.55 0.15 145 / 0.15)",  color: "oklch(0.65 0.15 145)", border: "oklch(0.55 0.15 145 / 0.3)" },
              { id: "pro",        label: "Pro",             value: userBreakdown.pro,                   accent: "oklch(0.55 0.15 145)", bg: "oklch(0.55 0.15 145 / 0.15)",  color: "oklch(0.65 0.15 145)", border: "oklch(0.55 0.15 145 / 0.3)" },
              { id: "starter",    label: "Starter",         value: userBreakdown.starter,               accent: "oklch(0.55 0.15 145)", bg: "oklch(0.55 0.15 145 / 0.15)",  color: "oklch(0.65 0.15 145)", border: "oklch(0.55 0.15 145 / 0.3)" },
              { id: "free",       label: "Free/Demo",       value: userBreakdown.free,                  accent: "oklch(0.5 0 0)",       bg: "oklch(0 0 0 / 0.05)",          color: "var(--c-55)",       border: "oklch(0 0 0 / 0.12)" },
              { id: "pending",    label: "Pending",         value: userBreakdown.pending,               accent: "oklch(0.72 0.25 285)", bg: "oklch(0.72 0.25 285 / 0.1)",   color: "oklch(0.72 0.25 285)", border: "oklch(0.72 0.25 285 / 0.2)" },
              { id: "zero-video", label: "With zero video", value: users.filter(hasZeroVideos).length,  accent: "oklch(0.6 0.19 25)",   bg: "oklch(0.6 0.19 25 / 0.12)",    color: "oklch(0.55 0.19 25)", border: "oklch(0.6 0.19 25 / 0.3)" },
              { id: "no-setup",   label: "With no setup",   value: users.filter(hasNoSetup).length,     accent: "oklch(0.6 0.19 25)",   bg: "oklch(0.6 0.19 25 / 0.12)",    color: "oklch(0.55 0.19 25)", border: "oklch(0.6 0.19 25 / 0.3)" },
              { id: "anthropic",  label: "With Anthropic key", value: users.filter(hasAnthropicKey).length, accent: "oklch(0.62 0.15 220)", bg: "oklch(0.62 0.15 220 / 0.12)", color: "oklch(0.5 0.13 220)", border: "oklch(0.62 0.15 220 / 0.35)" },
            ] as const).map((s) => {
              const isActive = planFilter === s.id;
              // Every pill except Total carries its share of all users.
              const pct = s.id === "all" || users.length === 0 ? null : Math.round((s.value / users.length) * 100);
              return (
                <button
                  key={s.id}
                  onClick={() => { setPlanFilter(isActive ? "all" : s.id); setUsersPage(1); }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-medium tabular-nums transition-all hover:opacity-80 cursor-pointer"
                  style={{
                    background: s.bg,
                    color: s.color,
                    border: `1px solid ${s.border}`,
                    boxShadow: isActive ? `0 0 0 2px ${s.accent}` : "none",
                  }}
                >
                  <span>{s.label}</span>
                  <span className="font-semibold">{s.value}</span>
                  {pct !== null && <span className="opacity-70">· {pct}%</span>}
                </button>
              );
            })}
          </div>

          <AddUserForm onSuccess={mutate} />

          {/* Filter the table by email substring — useful once the list
              grows past a page or two. Resets pagination on every change
              so an active filter never shows an empty page. */}
          <div className="relative">
            <input
              type="search"
              value={userSearch}
              onChange={(e) => { setUserSearch(e.target.value); setUsersPage(1); }}
              placeholder="Search users by email…"
              className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm outline-none transition-all"
              style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
            />
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--c-40)" }}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            {userSearch && (
              <button
                onClick={() => { setUserSearch(""); setUsersPage(1); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-xs cursor-pointer transition-opacity hover:opacity-80"
                style={{ color: "var(--c-50)", background: "oklch(0 0 0 / 0.05)" }}
              >
                Clear
              </button>
            )}
          </div>

          {isLoading ? (
            <SkeletonRows cols={5} />
          ) : users.length === 0 ? (
            <div className="text-sm py-4 italic" style={{ color: "var(--c-35)" }}>No users yet.</div>
          ) : filteredUsers.length === 0 ? (
            <div className="text-sm py-4 italic" style={{ color: "var(--c-35)" }}>
              {userSearch
                ? <>No users match &ldquo;{userSearch}&rdquo;{planFilter !== "all" ? ` in ${planFilter}` : ""}.</>
                : <>No users in this filter.</>}
            </div>
          ) : (
            <div className="rounded-2xl overflow-x-auto w-full max-w-full"
              style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
              <table className="w-full border-collapse min-w-[520px]">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                    {["Email", "Plan", "Plan status", "Videos", "Niches", "Niches overwrite", "Last Sign-in", ""].map((h) => (
                      <th key={h} className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider"
                        style={{ color: "var(--c-40)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody key={`users-p${usersPage}`}>
                  {pagedUsers.map((u) => (
                    <tr key={u.email}
                      style={{ borderBottom: "1px solid var(--bd-4)" }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bd-2)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                    >
                      <td className="py-3 px-4 text-sm font-mono" style={{ color: "var(--c-78)" }}>
                        <span className="inline-flex items-center gap-1.5">
                          {u.email}
                          {u.isAdmin && (
                            <Crown size={12} aria-label="Admin account" style={{ color: "oklch(0.72 0.18 75)" }} />
                          )}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        {(() => {
                          // Plan → label/color mapping. Admins get a gold
                          // tag matching the crown icon and aren't
                          // editable. Every paid tier shares the green
                          // palette; Free/Demo is muted gray and Pending
                          // (user hasn't signed up) is purple.
                          const paidGreen = { bg: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "oklch(0.55 0.15 145 / 0.3)" };
                          const isAdmin = u.isAdmin;
                          // Lower+trim so casing/whitespace in
                          // app_metadata.plan doesn't fall through.
                          const planNorm = (u.plan ?? "").toLowerCase().trim();
                          const planBadge = isAdmin
                            ? { label: "Admin", bg: "oklch(0.72 0.18 75 / 0.15)", color: "oklch(0.6 0.18 75)", border: "oklch(0.72 0.18 75 / 0.4)" }
                            : u.status === "Pending"
                            ? { label: "Pending", bg: "oklch(0.72 0.25 285 / 0.1)", color: "oklch(0.72 0.25 285)", border: "oklch(0.72 0.25 285 / 0.2)" }
                            : planNorm === "founder"
                            ? { label: "Founder", ...paidGreen }
                            : planNorm === "pro"
                            ? { label: "Pro", ...paidGreen }
                            : planNorm === "starter"
                            ? { label: "Starter", ...paidGreen }
                            : u.status === "Paid"
                            // Paid user with no recognised plan — still
                            // surface as a paying customer (not Free/Demo)
                            // since they did pay. Indicates a data gap
                            // worth fixing manually.
                            ? { label: "Paid", ...paidGreen }
                            : { label: "Free/Demo", bg: "oklch(0 0 0 / 0.05)", color: "var(--c-55)", border: "oklch(0 0 0 / 0.12)" };
                          const lockedReason = isAdmin
                            ? "Admin accounts have unlimited niches and can't be overridden"
                            : u.status === "Pending"
                              ? "User hasn't signed up yet"
                              : null;
                          return (
                            <button
                              onClick={() => setNicheLimitUser(u)}
                              disabled={lockedReason !== null}
                              title={lockedReason ?? "Click to override niche limit"}
                              className="inline-flex items-center justify-center gap-1.5 w-[160px] h-7 rounded-full text-xs font-medium transition-opacity hover:opacity-80 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                              style={{ background: planBadge.bg, color: planBadge.color, border: `1px solid ${planBadge.border}` }}
                            >
                              {planBadge.label}
                            </button>
                          );
                        })()}
                      </td>
                      <td className="py-3 px-4">
                        {(() => {
                          // Subscription status, using the same predicate as
                          // lib/subscription.subscriptionExpired: ever-
                          // subscribed = paidAt/planExpiresAt present; expired
                          // when not currently Paid OR the paid-through date
                          // has lapsed; otherwise Paid; never-subscribed =
                          // Demo/free. Admins bypass the paywall entirely.
                          if (u.isAdmin) return <span className="text-xs" style={{ color: "var(--c-35)" }}>—</span>;
                          if (u.status === "Pending") return <span className="text-xs" style={{ color: "var(--c-35)" }}>—</span>;
                          const everSubscribed = !!(u.paidAt || u.planExpiresAt);
                          const expiresMs = u.planExpiresAt ? Date.parse(u.planExpiresAt) : NaN;
                          const timeExpired = Number.isFinite(expiresMs) && expiresMs <= Date.now();
                          const badge = !everSubscribed
                            ? { label: "Free", bg: "oklch(0 0 0 / 0.05)", color: "var(--c-55)", border: "oklch(0 0 0 / 0.12)" }
                            : (u.status !== "Paid" || timeExpired)
                              ? { label: "Expired", bg: "oklch(0.6 0.16 55 / 0.12)", color: "oklch(0.55 0.16 55)", border: "oklch(0.6 0.16 55 / 0.3)" }
                              : { label: "Active", bg: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "oklch(0.55 0.15 145 / 0.3)" };
                          return (
                            <span className="inline-flex items-center h-6 px-2.5 rounded-full text-xs font-medium"
                              style={{ background: badge.bg, color: badge.color, border: `1px solid ${badge.border}` }}>
                              {badge.label}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        {u.status === "Pending" ? (
                          <span className="text-sm" style={{ color: "var(--c-35)" }}>—</span>
                        ) : (() => {
                          const c = videoCountsByEmail.get(u.email) ?? { total: 0, completed: 0, inProgress: 0 };
                          const cell = (label: string, value: number) => (
                            <div className="flex flex-col items-center">
                              <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--c-40)" }}>{label}</span>
                              <span className="text-sm font-semibold tabular-nums" style={{ color: "var(--c-78)" }}>{value}</span>
                            </div>
                          );
                          return (
                            <div className="flex items-start gap-4">
                              {cell("Total", c.total)}
                              {cell("Compl", c.completed)}
                              {cell("InProg", c.inProgress)}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="py-3 px-4 text-sm" style={{ color: "var(--c-60)" }}>
                        {u.status === "Pending" ? (
                          "—"
                        ) : (
                          <span className="tabular-nums">
                            {u.nichesUsed}
                            <span style={{ color: "var(--c-35)" }}>
                              {" / "}{u.planDefaultLimit === null ? "∞" : u.planDefaultLimit}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-sm tabular-nums" style={{ color: "var(--c-60)" }}>
                        {u.nicheLimitOverride === null
                          ? <span style={{ color: "var(--c-35)" }}>—</span>
                          : u.nicheLimitOverride}
                      </td>
                      <td className="py-3 px-4 text-sm" style={{ color: "var(--c-45)" }}>
                        {u.lastSignIn ? timeAgo(u.lastSignIn) : "Never"}
                      </td>
                      <td className="py-3 px-4">
                        {/* Kebab menu — Pending users have nothing
                            actionable here (the Cancel-invite path
                            lives elsewhere). Admins get a single
                            "Remove admin" action; everyone else gets
                            the Make admin + Remove pair. Hardcoded
                            admins (lib/admin.ts ADMIN_EMAILS) can
                            still open the menu, but the server-side
                            demote will 409 and surface a toast that
                            explains the rejection. */}
                        {u.status !== "Pending" && (
                          <div className="relative inline-block">
                            <button
                              type="button"
                              onClick={() => setOpenUserMenu(openUserMenu === u.email ? null : u.email)}
                              disabled={removing === u.email || promotingUser === u.email || demotingUser === u.email || flaggingProdTest === u.email}
                              className="w-7 h-7 rounded-lg transition-all hover:opacity-80 disabled:opacity-40 inline-flex items-center justify-center"
                              style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)", color: "var(--c-55)" }}
                              aria-label="User actions"
                              aria-haspopup="menu"
                              aria-expanded={openUserMenu === u.email}
                            >
                              {(removing === u.email || promotingUser === u.email || demotingUser === u.email || flaggingProdTest === u.email)
                                ? <Spinner size={12} />
                                : <MoreVertical size={14} />}
                            </button>
                            {openUserMenu === u.email && (
                              <>
                                {/* Click-outside catcher. Sits behind
                                    the menu so a click anywhere else on
                                    the page closes the popover. */}
                                <div
                                  className="fixed inset-0 z-10"
                                  onClick={() => setOpenUserMenu(null)}
                                />
                                <div
                                  role="menu"
                                  className="absolute right-0 top-full mt-1 z-20 rounded-lg overflow-hidden min-w-[240px] py-1.5"
                                  style={{
                                    background: "var(--bg-card)",
                                    border: "1px solid oklch(0 0 0 / 0.08)",
                                    boxShadow: "0 8px 24px oklch(0 0 0 / 0.12)",
                                  }}
                                >
                                  {u.isAdmin ? (
                                    <>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setOpenUserMenu(null); setDemoteTarget(u); }}
                                        className="w-full text-left text-xs px-3 py-2 hover:bg-[oklch(0.6_0.22_25_/_0.08)] flex items-center gap-2 cursor-pointer"
                                        style={{ color: "oklch(0.6 0.22 25)" }}
                                      >
                                        <Crown size={12} />
                                        Remove admin
                                      </button>
                                      <div style={{ borderTop: "1px solid oklch(0 0 0 / 0.06)" }} />
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setOpenUserMenu(null); handleFlagProductionTest(u.email); }}
                                        disabled={flaggingProdTest === u.email}
                                        className="w-full text-left text-xs px-3 py-2 hover:bg-[oklch(0_0_0_/_0.04)] flex items-center gap-2 cursor-pointer disabled:opacity-50"
                                        style={{ color: "oklch(0.45 0.15 145)" }}
                                      >
                                        <FlaskConical size={12} />
                                        Flag as production test account
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setOpenUserMenu(null); setPromoteTarget(u); }}
                                        className="w-full text-left text-xs px-3 py-2 hover:bg-[oklch(0_0_0_/_0.04)] flex items-center gap-2 cursor-pointer"
                                        style={{ color: "oklch(0.45 0.15 220)" }}
                                      >
                                        <Crown size={12} />
                                        Make admin
                                      </button>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setOpenUserMenu(null); handleFlagProductionTest(u.email); }}
                                        disabled={flaggingProdTest === u.email}
                                        className="w-full text-left text-xs px-3 py-2 hover:bg-[oklch(0_0_0_/_0.04)] flex items-center gap-2 cursor-pointer disabled:opacity-50"
                                        style={{ color: "oklch(0.45 0.15 145)" }}
                                      >
                                        <FlaskConical size={12} />
                                        Flag as production test account
                                      </button>
                                      <div style={{ borderTop: "1px solid oklch(0 0 0 / 0.06)" }} />
                                      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "oklch(0.55 0 0)" }}>Subscription</div>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setOpenUserMenu(null); handleSetSubscription(u.email, "paid"); }}
                                        disabled={settingSub === u.email}
                                        className="w-full text-left text-xs px-3 py-2 hover:bg-[oklch(0_0_0_/_0.04)] flex items-center gap-2 cursor-pointer disabled:opacity-50"
                                        style={{ color: "oklch(0.45 0.15 145)" }}
                                      >
                                        <CreditCard size={12} />
                                        Mark as Paid
                                      </button>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setOpenUserMenu(null); handleSetSubscription(u.email, "expired"); }}
                                        disabled={settingSub === u.email}
                                        className="w-full text-left text-xs px-3 py-2 hover:bg-[oklch(0_0_0_/_0.04)] flex items-center gap-2 cursor-pointer disabled:opacity-50"
                                        style={{ color: "oklch(0.55 0.16 60)" }}
                                      >
                                        <Clock size={12} />
                                        Mark as Subscription expired
                                      </button>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setOpenUserMenu(null); handleSetSubscription(u.email, "demo"); }}
                                        disabled={settingSub === u.email}
                                        className="w-full text-left text-xs px-3 py-2 hover:bg-[oklch(0_0_0_/_0.04)] flex items-center gap-2 cursor-pointer disabled:opacity-50"
                                        style={{ color: "oklch(0.5 0 0)" }}
                                      >
                                        <Sparkles size={12} />
                                        Mark as Demo/free
                                      </button>
                                      <div style={{ borderTop: "1px solid oklch(0 0 0 / 0.06)" }} />
                                      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "oklch(0.55 0 0)" }}>Plan</div>
                                      {([
                                        { slug: "starter" as const, label: "Starter", Icon: Rocket, color: "oklch(0.45 0.15 145)" },
                                        { slug: "pro" as const,     label: "Pro",     Icon: Star,   color: "oklch(0.45 0.15 220)" },
                                        { slug: "founder" as const, label: "Founder", Icon: Gem,    color: "oklch(0.5 0.18 300)" },
                                      ]).map(({ slug, label, Icon, color }) => {
                                        const current = (u.plan ?? "").toLowerCase().trim() === slug;
                                        return (
                                          <button
                                            key={slug}
                                            type="button"
                                            role="menuitem"
                                            onClick={() => { setOpenUserMenu(null); handleSetPlan(u.email, slug); }}
                                            disabled={settingPlan === u.email || current}
                                            className="w-full text-left text-xs px-3 py-2 hover:bg-[oklch(0_0_0_/_0.04)] flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-default"
                                            style={{ color }}
                                          >
                                            <Icon size={12} />
                                            <span className="flex-1">Set plan: {label}</span>
                                            {current && <Check size={12} />}
                                          </button>
                                        );
                                      })}
                                      <div style={{ borderTop: "1px solid oklch(0 0 0 / 0.06)" }} />
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setOpenUserMenu(null); setRemoveTarget(u); }}
                                        className="w-full text-left text-xs px-3 py-2 hover:bg-[oklch(0.6_0.22_25_/_0.08)] flex items-center gap-2 cursor-pointer"
                                        style={{ color: "oklch(0.6 0.22 25)" }}
                                      >
                                        <Trash2 size={12} />
                                        Remove
                                      </button>
                                    </>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={usersPage} total={filteredUsers.length} onChange={setUsersPage} />
            </div>
          )}
        </section>

        {/* Projects section */}
        <section id="projects" className="rounded-2xl space-y-5 pb-[10px] max-w-full min-w-0" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", padding: "10px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)", display: activeTab === "projects" ? undefined : "none" }}>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-0.5 rounded-full"
              style={{ background: "var(--bg-elevated)", border: "1px solid oklch(1 0 0 / 0.06)", color: "var(--c-42)" }}>
              {projects.length}
            </span>
            {/* Average wall-clock assembly time across all projects
                that have actually completed a run. Computed inline
                from the same assembleSeconds the column renders, so
                the chip always agrees with the rows on screen.
                Hidden when no project has a duration yet — better to
                show nothing than "0s" or "—" which read like errors. */}
            {(() => {
              const durations = projects
                .map((p) => p.assembleSeconds)
                .filter((s): s is number => typeof s === "number" && s > 0);
              if (durations.length === 0) return null;
              const avg = Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length);
              return (
                <span
                  className="ml-auto text-base font-bold px-3 py-1 rounded-full inline-flex items-center gap-1.5 tabular-nums"
                  style={{ background: "oklch(0.55 0.15 220 / 0.08)", border: "1px solid oklch(0.55 0.15 220 / 0.22)", color: "oklch(0.45 0.15 220)" }}
                  title={`Average across ${durations.length} completed assembl${durations.length === 1 ? "y" : "ies"}`}
                >
                  <Clock size={14} />
                  Avg processing time: {formatAssembleTime(avg)}
                </span>
              );
            })()}
          </div>

          {/* Sub-tabs — General (current videos table) vs Cost
              (per-step usage rollup from project_costs). Each tab
              renders its own table below; the section header above
              stays constant so the count + Avg processing chip are
              visible regardless of which sub-tab is selected. */}
          <div className="flex items-center gap-1 p-1 rounded-xl w-full"
            style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)" }}>
            {(["general", "cost"] as const).map((id) => (
              <button key={id} onClick={() => { setVideosSubTab(id); setSelectedCostProject(null); setSelectedGeneralProject(null); }}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer capitalize"
                style={videosSubTab === id
                  ? { background: "oklch(0.55 0.15 145)", color: "white", boxShadow: "0 2px 8px oklch(0.55 0.15 145 / 0.35)" }
                  : { color: "oklch(0.50 0 0)" }}
              >
                {id}
              </button>
            ))}
          </div>

          {/* Shared search input — drives both General and Cost
              tables. Hidden in the details view since there are no
              rows to filter; the back button is the only way out
              and that's enough. Placed below the sub-tabs so the
              tab choice feels primary and the filter feels like a
              refinement on whatever view is active. */}
          {/* Status breakdown strip — one pill per status/step with live
              counts (computed over all videos, ignoring the search box).
              Clicking a pill applies that filter; clicking the active
              pill (or Total) clears it. Mirrors the Users tab's strip. */}
          {!selectedCostProject && !selectedGeneralProject && (
            <div className="flex flex-wrap gap-2 text-xs">
              {PROJECT_STATUS_FILTERS.map((f) => {
                const isActive = projectStatusFilter === f.id;
                const value = f.id === "all" ? projects.length : projects.filter(f.match).length;
                const tone = f.id === "all"
                  ? { accent: "oklch(0.55 0.15 220)", bg: "oklch(0 0 0 / 0.04)",         color: "var(--c-65)",           border: "oklch(0 0 0 / 0.08)" }
                  : f.id === "completed"
                    ? { accent: "oklch(0.55 0.15 145)", bg: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "oklch(0.55 0.15 145 / 0.3)" }
                    : f.id === "inprogress"
                      ? { accent: "oklch(0.72 0.18 75)", bg: "oklch(0.72 0.18 75 / 0.15)",  color: "oklch(0.6 0.18 75)",  border: "oklch(0.72 0.18 75 / 0.4)" }
                      : f.id.includes("-")
                        // Today/yesterday pills — blue, to read as a time
                        // slice rather than a pipeline step.
                        ? { accent: "oklch(0.55 0.15 220)", bg: "oklch(0.55 0.15 220 / 0.12)", color: "oklch(0.5 0.15 220)", border: "oklch(0.55 0.15 220 / 0.3)" }
                        : { accent: "oklch(0.72 0.25 285)", bg: "oklch(0.72 0.25 285 / 0.1)", color: "oklch(0.72 0.25 285)", border: "oklch(0.72 0.25 285 / 0.2)" };
                return (
                  <button
                    key={f.id}
                    onClick={() => { setProjectStatusFilter(isActive ? "all" : f.id); setProjectsPage(1); }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-medium tabular-nums transition-all hover:opacity-80 cursor-pointer"
                    style={{
                      background: tone.bg,
                      color: tone.color,
                      border: `1px solid ${tone.border}`,
                      boxShadow: isActive ? `0 0 0 2px ${tone.accent}` : "none",
                    }}
                  >
                    <span>{f.id === "all" ? "Total" : f.label}</span>
                    <span className="font-semibold">{value}</span>
                  </button>
                );
              })}
            </div>
          )}

          {!selectedCostProject && !selectedGeneralProject && (
            <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <input
                  type="search"
                  value={projectSearch}
                  onChange={(e) => { setProjectSearch(e.target.value); setProjectsPage(1); setSelectedCostProject(null); setSelectedGeneralProject(null); }}
                  placeholder="Search videos by topic, channel, user, or project ID…"
                  className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm outline-none transition-all"
                  style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
                />
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--c-40)" }}>
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                {projectSearch && (
                  <button
                    onClick={() => { setProjectSearch(""); setProjectsPage(1); setSelectedCostProject(null); setSelectedGeneralProject(null); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-xs cursor-pointer transition-opacity hover:opacity-80"
                    style={{ color: "var(--c-50)", background: "oklch(0 0 0 / 0.05)" }}
                  >
                    Clear
                  </button>
                )}
              </div>
              <select
                value={projectStatusFilter}
                onChange={(e) => { setProjectStatusFilter(e.target.value); setProjectsPage(1); setSelectedCostProject(null); setSelectedGeneralProject(null); }}
                title="Filter videos by status or wizard step"
                className="px-3 py-2.5 rounded-lg text-sm outline-none cursor-pointer shrink-0"
                style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
              >
                {PROJECT_STATUS_FILTERS.map((f) => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
              </select>
            </div>
          )}

          {videosSubTab === "general" && (isLoading ? (
            <SkeletonRows cols={8} />
          ) : selectedGeneralProject ? (
            (() => {
              const p = selectedGeneralProject;
              const isComplete = p.isComplete;
              type StatField = { label: string; value: React.ReactNode };
              const stats: StatField[] = [
                { label: "User",            value: p.userEmail ?? "—" },
                { label: "Project ID",      value: <span className="font-mono">{p.id}</span> },
                { label: "Channel",         value: p.channelName ?? "—" },
                { label: "Topic",           value: p.selectedTopic ?? "—" },
                { label: "Phase",           value: p.phaseLabel },
                { label: "Progress",        value: `${p.progress}%` },
                { label: "Assemble time",   value: formatAssembleTime(p.assembleSeconds) },
                { label: "Created",         value: timeAgo(p.createdAt) },
              ];
              return (
                <div className="rounded-2xl w-full max-w-full p-4 space-y-4"
                  style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <button
                      onClick={() => setSelectedGeneralProject(null)}
                      className="text-xs px-3 py-1.5 rounded-lg font-semibold cursor-pointer transition-opacity hover:opacity-90 inline-flex items-center gap-1.5"
                      style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.35)" }}
                    >
                      <ArrowLeft size={12} />
                      Back to table
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Title</p>
                      <p className="text-base font-semibold truncate" style={{ color: "var(--c-90)" }}>
                        {p.selectedTopic ?? p.channelName ?? "—"}
                      </p>
                    </div>
                    <Link
                      href={`/projects/${p.id}/${PHASE_PATHS[p.currentState] ?? "channel"}`}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium transition-opacity hover:opacity-80 inline-flex items-center gap-1.5"
                      style={{ background: "oklch(0.72 0.25 285 / 0.1)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}
                    >
                      Open project →
                    </Link>
                  </div>

                  {/* Phase + progress strip — the bit a glance-and-go
                      operator actually wants to see. Phase pill
                      matches the table's color treatment and the
                      bar mirrors the General-row progress style. */}
                  <div className="rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap"
                    style={{ background: "var(--bg-elevated)", border: "1px solid oklch(0 0 0 / 0.06)" }}>
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
                      {p.phaseLabel}
                    </span>
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden min-w-[140px]"
                      style={{ background: "var(--bg-track)" }}>
                      <div className="h-full rounded-full transition-all"
                        style={{
                          width: `${p.progress}%`,
                          background: isComplete
                            ? "oklch(0.55 0.15 145)"
                            : "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                        }} />
                    </div>
                    <span className="text-xs tabular-nums font-medium" style={{ color: "var(--c-60)" }}>
                      {p.progress}%
                    </span>
                  </div>

                  {/* Field table — two columns: label and value.
                      Label column gets the same silver highlight as
                      Title on the main table so the eye anchors to
                      the field names on the left. Label width drops
                      to 110px on mobile (was 180px which ate half a
                      360px viewport) and the value column gets
                      break-words so long topics + UUIDs wrap inside
                      the card instead of forcing horizontal scroll. */}
                  <div className="overflow-x-auto rounded-xl"
                    style={{ background: "var(--bg-elevated)", border: "1px solid oklch(0 0 0 / 0.06)" }}>
                    <table className="w-full border-collapse table-fixed">
                      <colgroup>
                        <col className="w-[110px] sm:w-[180px]" />
                        <col />
                      </colgroup>
                      <tbody>
                        {stats.map((f, i) => (
                          <tr key={f.label} style={{ borderBottom: i === stats.length - 1 ? undefined : "1px solid var(--bd-4)" }}>
                            <td className="py-2.5 px-3 text-[11px] uppercase tracking-wider font-bold align-top"
                              style={{ color: "black", background: "oklch(0.88 0 0)" }}>
                              {f.label}
                            </td>
                            <td className="py-2.5 px-3 text-sm break-words" style={{ color: "black" }}>
                              {f.value}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()
          ) : projects.length === 0 ? (
            <div className="text-sm py-4 italic" style={{ color: "var(--c-35)" }}>No projects yet.</div>
          ) : sortedProjects.length === 0 ? (
            <div className="text-sm py-4 italic" style={{ color: "var(--c-35)" }}>
              {projectSearchLower
                ? <>No videos match &ldquo;{projectSearch}&rdquo;{statusFilter.id !== "all" ? ` in ${statusFilter.label}` : ""}.</>
                : <>No videos in {statusFilter.label}.</>}
            </div>
          ) : (
            <div className="rounded-2xl overflow-x-auto w-full max-w-full"
              style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
              <table className="w-full border-collapse min-w-[640px]">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                    {["User", "Project ID", "Channel", "Topic", "Phase", "Progress", "Length", "Assemble Time", "Created", ""].map((h) => (
                      <th key={h} className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider"
                        style={{ color: "var(--c-40)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody key={`projects-p${projectsPage}`}>
                  {pagedProjects.map((p) => {
                    const isComplete = p.isComplete;
                    return (
                      <tr key={p.id}
                        onClick={() => setSelectedGeneralProject(p)}
                        style={{ borderBottom: "1px solid var(--bd-4)", cursor: "pointer" }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bd-2)"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                      >
                        <td className="py-3 px-4 text-xs font-mono max-w-[160px]"
                          style={{ color: "var(--c-55)" }}>
                          {p.userEmail ? (
                            <span className="inline-flex items-center gap-1.5 max-w-full">
                              <span className="truncate">{p.userEmail}</span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void navigator.clipboard.writeText(p.userEmail!);
                                  toast.success("Email copied");
                                }}
                                title={`Copy ${p.userEmail} to clipboard`}
                                aria-label="Copy email"
                                className="shrink-0 p-1 -m-1 opacity-50 hover:opacity-100 transition-opacity cursor-copy"
                              >
                                <Copy size={11} />
                              </button>
                            </span>
                          ) : (
                            <span style={{ color: "var(--c-35)" }}>—</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs font-mono max-w-[160px]"
                          style={{ color: "var(--c-55)" }}>
                          <span className="inline-flex items-center gap-1.5 max-w-full">
                            <span className="truncate">{p.id.slice(0, 8)}…{p.id.slice(-4)}</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void navigator.clipboard.writeText(p.id);
                                toast.success("Project ID copied");
                              }}
                              title={`Copy ${p.id} to clipboard`}
                              aria-label="Copy project ID"
                              className="shrink-0 p-1 -m-1 opacity-50 hover:opacity-100 transition-opacity cursor-copy"
                            >
                              <Copy size={11} />
                            </button>
                          </span>
                        </td>
                        <td className="py-3 px-4 text-sm max-w-[140px]"
                          style={{ color: "var(--c-72)" }}>
                          <TruncatedCell value={p.channelName} maxLen={18} />
                        </td>
                        <td className="py-3 px-4 text-sm max-w-[200px]"
                          style={{ color: p.selectedTopic ? "var(--c-82)" : "var(--c-35)" }}>
                          <TruncatedCell value={p.selectedTopic} maxLen={28} fallback="No topic" />
                        </td>
                        <td className="py-3 px-4">
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
                            {p.phaseLabel}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1 rounded-full overflow-hidden"
                              style={{ background: "var(--bg-track)" }}>
                              <div className="h-full rounded-full transition-all"
                                style={{
                                  width: `${p.progress}%`,
                                  background: isComplete
                                    ? "oklch(0.55 0.15 145)"
                                    : "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                                }}
                              />
                            </div>
                            <span className="text-xs" style={{ color: "var(--c-40)" }}>{p.progress}%</span>
                          </div>
                        </td>
                        <td
                          className="py-3 px-4 text-sm tabular-nums font-mono"
                          style={{ color: p.lengthSeconds !== null ? "var(--c-72)" : "var(--c-35)" }}
                          title={p.lengthSeconds !== null
                            ? `${p.lengthSeconds} seconds of finished video`
                            : isComplete ? "Assembled before video length was recorded" : "Not assembled yet"}
                        >
                          {formatVideoLength(p.lengthSeconds)}
                        </td>
                        <td
                          className="py-3 px-4 text-sm tabular-nums font-mono"
                          style={{ color: p.assembleSeconds !== null ? "var(--c-72)" : "var(--c-35)" }}
                          title={p.assembleSeconds !== null ? `${p.assembleSeconds} seconds` : "Not assembled yet"}
                        >
                          {formatAssembleTime(p.assembleSeconds)}
                        </td>
                        <td className="py-3 px-4 text-sm" style={{ color: "var(--c-42)" }}>
                          {timeAgo(p.createdAt)}
                        </td>
                        <td className="py-3 px-4">
                          <Link
                            href={`/projects/${p.id}/${PHASE_PATHS[p.currentState] ?? "channel"}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
                            style={{
                              background: "oklch(0.72 0.25 285 / 0.1)",
                              color: "oklch(0.72 0.25 285)",
                              border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                            }}
                          >
                            Open
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Pagination page={projectsPage} total={sortedProjects.length} onChange={setProjectsPage} />
            </div>
          ))}

          {videosSubTab === "cost" && !selectedCostProject && <TtsCostLens />}

          {videosSubTab === "cost" && (() => {
            // Build a project-id → cost rollup map so the table can
            // render a row per project (using the same pagination
            // as General) and look up its cost cells in O(1). Empty
            // map covers the no-data case — every cell renders "—".
            const costsByProject = new Map<string, Record<CostColumn, CostColumnSummary>>();
            for (const p of costsData?.projects ?? []) {
              costsByProject.set(p.projectId, p.columns);
            }
            const COLS: { key: CostColumn; label: string }[] = [
              { key: "channel_analysis", label: "Channel" },
              { key: "topic",            label: "Topic" },
              { key: "script",           label: "Script" },
              { key: "visuals",          label: "Visuals" },
              { key: "prompts",          label: "Prompts" },
              { key: "voiceover",        label: "Voiceover" },
              { key: "generate",         label: "Generate" },
              { key: "assemble",         label: "Assemble" },
              { key: "thumbnail",        label: "Thumbnail" },
            ];

            // Sum totals + merge breakdown across every column for one
            // project into a single CostColumnSummary the Total cell
            // renders. Breakdown merge collapses duplicate
            // (provider, model, unitKind) triples that may appear in
            // multiple steps (e.g. Claude Opus shows up in Channel
            // Analysis AND Prompts AND Thumbnail) so the tooltip
            // doesn't repeat rows.
            const projectTotal = (cells: Record<CostColumn, CostColumnSummary> | undefined): CostColumnSummary | undefined => {
              if (!cells) return undefined;
              const totals: Record<string, number> = {};
              const bdMap = new Map<string, CostBreakdownEntry>();
              for (const c of COLS) {
                const cell = cells[c.key];
                if (!cell) continue;
                for (const [k, v] of Object.entries(cell.totals)) {
                  totals[k] = (totals[k] ?? 0) + v;
                }
                for (const b of cell.breakdown) {
                  const key = `${b.provider}|${b.model ?? ""}|${b.unitKind}`;
                  const existing = bdMap.get(key);
                  if (existing) existing.units += b.units;
                  else bdMap.set(key, { ...b });
                }
              }
              const breakdown = Array.from(bdMap.values());
              if (breakdown.length === 0) return undefined;
              return { totals, breakdown };
            };

            // Details view — clicking a Cost-table row drops the user
            // into a per-step breakdown of that single project. The
            // section header, sub-tabs, and search bar above stay
            // visible so navigation/back is always one click away.
            if (selectedCostProject) {
              const p = selectedCostProject;
              const cells = costsByProject.get(p.id);
              return (
                <div className="rounded-2xl w-full max-w-full p-4 space-y-4"
                  style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <button
                      onClick={() => setSelectedCostProject(null)}
                      className="text-xs px-3 py-1.5 rounded-lg font-semibold cursor-pointer transition-opacity hover:opacity-90 inline-flex items-center gap-1.5"
                      style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.35)" }}
                    >
                      <ArrowLeft size={12} />
                      Back to table
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Title</p>
                      <p className="text-base font-semibold truncate" style={{ color: "var(--c-90)" }}>
                        {p.selectedTopic ?? p.channelName ?? "—"}
                      </p>
                    </div>
                  </div>

                  {/* Provider × step matrix. Rows = the same 9
                      display columns the table uses. Columns = the
                      providers that actually appear in this
                      project's data (so empty providers don't take
                      up screen real-estate). Each cell aggregates
                      the units that provider contributed at that
                      step. Bottom Total row sums each provider
                      column across all steps. No right-most
                      total column — the per-row total would mix
                      tokens with credits with chars and not be
                      summable. The Total bar above already gives
                      the project-level grand total. */}
                  {(() => {
                    // Build the list of providers present + per
                    // (step, provider) units bucketed by unit_kind.
                    type StepProviderBucket = Record<string /* unit_kind */, number>;
                    const providersSet = new Set<string>();
                    const matrix: Record<CostColumn, Record<string /* provider */, StepProviderBucket>> = {} as Record<CostColumn, Record<string, StepProviderBucket>>;
                    for (const c of COLS) {
                      matrix[c.key] = {};
                      const cell = cells?.[c.key];
                      if (!cell) continue;
                      for (const b of cell.breakdown) {
                        providersSet.add(b.provider);
                        const stepProv = matrix[c.key][b.provider] ?? {};
                        // Collapse Claude's four token sub-kinds into
                        // a single "claude_tokens" bucket so the cell
                        // shows one "Xk tok" tally per step rather
                        // than four separate sub-numbers.
                        const kind = b.unitKind.startsWith("claude_tokens_") ? "claude_tokens" : b.unitKind;
                        stepProv[kind] = (stepProv[kind] ?? 0) + b.units;
                        matrix[c.key][b.provider] = stepProv;
                      }
                    }
                    // Fixed provider list — always show the four
                    // canonical providers as columns even when this
                    // project has no rows for one of them. Empty
                    // cells render the em-dash so the table shape
                    // stays consistent across projects and the
                    // reader can tell at a glance "this step uses
                    // KIE, that step uses Anthropic". Any future
                    // provider that turns up in the breakdown but
                    // isn't in this list falls to the end
                    // alphabetically.
                    const ORDER = ["anthropic", "kie", "elevenlabs", "supadata"];
                    const extras = Array.from(providersSet)
                      .filter((p) => !ORDER.includes(p))
                      .sort((a, b) => a.localeCompare(b));
                    const providers = [...ORDER, ...extras];

                    // Friendly per-provider label for the header.
                    const PROVIDER_LABEL: Record<string, string> = {
                      anthropic:  "Anthropic",
                      kie:        "KIE",
                      elevenlabs: "ElevenLabs",
                      supadata:   "Supadata",
                    };
                    // Default unit_kind for each provider — used so
                    // an empty bucket still displays its natural
                    // unit suffix (e.g. "0 cr" reads better than
                    // a bare em-dash for visual scanning, though
                    // we still use the dash for true-empty cells).
                    const renderBucket = (bucket: StepProviderBucket | undefined) => {
                      if (!bucket) return <span style={{ color: "var(--c-35)" }}>—</span>;
                      const parts: string[] = [];
                      for (const [kind, units] of Object.entries(bucket)) {
                        if (units > 0) parts.push(`${compactNumber(units)} ${unitSuffix(kind)}`);
                      }
                      return parts.length ? parts.join(" · ") : <span style={{ color: "var(--c-35)" }}>—</span>;
                    };

                    // Per-provider grand total across all steps —
                    // sum the (step, provider) buckets down each
                    // column. Same unit_kinds so summing is honest.
                    const providerTotals: Record<string, StepProviderBucket> = {};
                    for (const provider of providers) {
                      const acc: StepProviderBucket = {};
                      for (const c of COLS) {
                        const stepBucket = matrix[c.key][provider];
                        if (!stepBucket) continue;
                        for (const [k, v] of Object.entries(stepBucket)) {
                          acc[k] = (acc[k] ?? 0) + v;
                        }
                      }
                      providerTotals[provider] = acc;
                    }

                    // Always render the table even when there are
                    // no logged cost rows — the four canonical
                    // providers stay as columns and every cell
                    // shows the em-dash. Keeps the UX consistent
                    // for projects that pre-date the cost ledger
                    // migration (052) and for projects that ran
                    // without producing any billable upstream
                    // calls — clicking through to a row always
                    // lands on the same layout.
                    return (
                      <div className="overflow-x-auto rounded-xl"
                        style={{ background: "var(--bg-elevated)", border: "1px solid oklch(0 0 0 / 0.06)" }}>
                        <table className="w-full border-collapse min-w-[640px]">
                          <thead>
                            <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                              <th className="text-left py-2.5 px-3" style={{ background: "var(--bg-elevated)" }} />
                              {providers.map((prov) => (
                                <th key={prov} className="text-left py-2.5 px-3 text-[11px] font-semibold uppercase tracking-wider"
                                  style={{ color: "black" }}>
                                  {PROVIDER_LABEL[prov] ?? prov}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {COLS.map((c) => (
                              <tr key={c.key} style={{ borderBottom: "1px solid var(--bd-4)" }}>
                                <td className="py-2.5 px-3 text-xs font-bold" style={{ color: "black" }}>
                                  {c.label}
                                </td>
                                {providers.map((prov) => (
                                  <td key={prov} className="py-2.5 px-3 text-xs font-mono tabular-nums" style={{ color: "black" }}>
                                    {renderBucket(matrix[c.key][prov])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr style={{ borderTop: "2px solid var(--bd-7)" }}>
                              <td className="py-2.5 px-3 text-[11px] font-bold uppercase tracking-wider"
                                style={{ color: "black", background: "var(--skeleton)" }}>
                                Total
                              </td>
                              {providers.map((prov) => (
                                <td key={prov} className="py-2.5 px-3 text-xs font-mono font-bold tabular-nums"
                                  style={{ color: "black", background: "var(--skeleton)" }}>
                                  {renderBucket(providerTotals[prov])}
                                </td>
                              ))}
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    );
                  })()}
                </div>
              );
            }

            return (
              <div className="rounded-2xl overflow-x-auto w-full max-w-full"
                style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
                <table className="w-full border-collapse min-w-[900px]">
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                      {["Title", "Total", ...COLS.map((c) => c.label)].map((h) => {
                        const isTitle = h === "Title";
                        const isTotal = h === "Total";
                        return (
                          <th key={h} className="text-left py-3 px-3 text-[11px] uppercase tracking-wider"
                            style={{
                              color: isTitle || isTotal ? "black" : "var(--c-40)",
                              background: isTotal ? "var(--skeleton)" : isTitle ? "oklch(0.88 0 0)" : undefined,
                              fontWeight: isTotal ? 700 : 500,
                            }}>
                            {h}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody key={`cost-p${projectsPage}`}>
                    {pagedProjects.map((p) => {
                      const cells = costsByProject.get(p.id);
                      const total = projectTotal(cells);
                      return (
                        <tr key={p.id}
                          onClick={() => setSelectedCostProject(p)}
                          title="Click to view details"
                          style={{ borderBottom: "1px solid var(--bd-4)", cursor: "pointer" }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bd-2)"; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                          <td className="py-3 px-3 text-sm max-w-[200px]"
                            style={{ color: "black", background: "oklch(0.88 0 0)" }}>
                            <TruncatedCell value={p.selectedTopic ?? p.channelName} maxLen={24} fallback="—" />
                          </td>
                          <td className="py-3 px-3 text-xs font-mono font-bold tabular-nums"
                            style={{ color: "black", background: "var(--skeleton)" }}>
                            <CostCell summary={total} showProviders={false} />
                          </td>
                          {COLS.map((c) => (
                            <td key={c.key} className="py-3 px-3 text-xs font-mono tabular-nums" style={{ color: "var(--c-75)" }}>
                              <CostCell summary={cells?.[c.key]} />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <Pagination page={projectsPage} total={sortedProjects.length} onChange={setProjectsPage} />
              </div>
            );
          })()}
        </section>

        {/* Reports section — mounted only while active; everything is
            computed from data other tabs already fetch. */}
        {activeTab === "reports" && (
          <ReportsSection stats={stats} users={users} projects={projects} revenue={revenue} activity={data?.activity ?? []} />
        )}

        {/* Revenue section */}
        {(() => {
          const PLAN_MRR: Record<string, number> = { founder: 40 / 12, starter: 19, pro: 49 };
          const PLAN_LABEL: Record<string, string> = { founder: "Founder", starter: "Starter", pro: "Pro" };
          // Most-recent payments first; nulls-last for any paid user
          // whose paidAt isn't set (e.g. a manual grant without a
          // timestamp).
          //
          // Once the Launch action has set product_config
          // .activity_cutoff_at, the table is scoped to post-launch
          // subscriptions only — anyone whose paidAt predates launch
          // is hidden, so the view stays focused on real day-1+
          // customers instead of being mixed with pre-launch test
          // accounts. Before launch (launchedAt = null) the filter is
          // a no-op and everyone with paid=true is shown.
          const launchedAtMs = revenue?.launchedAt ? new Date(revenue.launchedAt).getTime() : null;
          // Date-range filter for the payments table. From/To are
          // inclusive; To covers the entire selected day (23:59:59.999)
          // so picking the same date in both inputs shows that day's
          // payments. Rows without a paidAt are hidden while a filter
          // is active — an unknown date can't be proven in-range.
          const fromMs = revDateFrom ? new Date(`${revDateFrom}T00:00:00`).getTime() : null;
          const toMs = revDateTo ? new Date(`${revDateTo}T23:59:59.999`).getTime() : null;
          const dateFilterActive = fromMs !== null || toMs !== null;
          // Post-launch paid users, before the date/plan filters — this
          // is also the source for the plan dropdown's option list, so
          // options never disappear because the current filter excludes
          // them.
          const basePaidUsers = users
            .filter((u) => u.status === "Paid")
            .filter((u) => {
              if (launchedAtMs === null) return true;
              if (!u.paidAt) return false;
              return new Date(u.paidAt).getTime() >= launchedAtMs;
            });
          // All known plans always listed (even with zero payments), plus
          // any unexpected slug found on a paid user (e.g. legacy or
          // test plans) so no payment is ever unfilterable.
          const planOptions = [...new Set([
            ...Object.keys(PLAN_LABEL),
            ...basePaidUsers.map((u) => u.plan).filter((p): p is string => !!p),
          ])].sort();
          const filtersActive = dateFilterActive || revPlanFilter !== "";
          const paidUsers = basePaidUsers
            .filter((u) => {
              if (!dateFilterActive) return true;
              if (!u.paidAt) return false;
              const t = new Date(u.paidAt).getTime();
              if (fromMs !== null && t < fromMs) return false;
              if (toMs !== null && t > toMs) return false;
              return true;
            })
            .filter((u) => revPlanFilter === "" || u.plan === revPlanFilter)
            .sort((a, b) => {
              const ta = a.paidAt ? new Date(a.paidAt).getTime() : -Infinity;
              const tb = b.paidAt ? new Date(b.paidAt).getTime() : -Infinity;
              return tb - ta;
            });
          // All four cards now sourced from revenue_events via
          // /api/admin/revenue. paidUsers (derived from
          // auth.users.app_metadata) is still used below for the
          // "Paid users" table, which is intentionally a view of
          // CURRENTLY-paying subscriptions and not historical revenue.
          const mrr = (revenue?.mrrCents ?? 0) / 100;
          const arr = (revenue?.arrCents ?? 0) / 100;
          const payingUserCount = revenue?.payingUserCount ?? 0;

          // Revenue history sourced from the immutable revenue_events
          // ledger via /api/admin/revenue. Survives user deletion,
          // unlike the prior approach which derived months from
          // auth.users.app_metadata.paid_at and silently dropped any
          // revenue tied to a deleted user.
          const last12Months = revenue?.last12Months ?? Array.from({ length: 12 }, (_, i) => {
            const d = new Date();
            d.setUTCDate(1);
            d.setUTCMonth(d.getUTCMonth() - (11 - i));
            return { month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, amountCents: 0 };
          });
          const chartPts = last12Months.map((m) => ({
            month: m.month,
            revenue: m.amountCents / 100,
          }));
          const totalRevenue = (revenue?.totalCents ?? 0) / 100;

          // SVG chart
          const W = 560, PAD_L = 40, PAD_R = 10, PAD_T = 14, PAD_B = 26;
          const H = 150;
          const plotW = W - PAD_L - PAD_R;
          const plotH = H - PAD_T - PAD_B;
          const n = chartPts.length;
          const maxRev = Math.max(...chartPts.map(p => p.revenue), 1);
          const cs = chartPts.map((p, i) => ({
            x: PAD_L + (n <= 1 ? plotW / 2 : i * plotW / (n - 1)),
            y: PAD_T + (1 - p.revenue / maxRev) * plotH,
          }));
          const toPath = (pts: { x: number; y: number }[]) =>
            pts.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
          const toArea = (pts: { x: number; y: number }[]) => {
            if (pts.length === 0) return "";
            const base = (PAD_T + plotH).toFixed(1);
            return `${toPath(pts)} L${pts[pts.length - 1].x.toFixed(1)},${base} L${pts[0].x.toFixed(1)},${base} Z`;
          };
          const slotW = n > 1 ? plotW / (n - 1) : plotW;

          return (
            <section id="revenue" className="rounded-2xl space-y-5" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)", display: activeTab === "revenue" ? undefined : "none" }}>
              {(revenue?.unconverted?.count ?? 0) > 0 && (
                <p className="text-xs px-3 py-2 rounded-lg"
                  style={{ background: "oklch(0.75 0.15 65 / 0.12)", border: "1px solid oklch(0.75 0.15 65 / 0.3)", color: "oklch(0.45 0.12 65)" }}>
                  {revenue!.unconverted.count} payment{revenue!.unconverted.count === 1 ? "" : "s"} counted as $0 —
                  stored in {revenue!.unconverted.currencies.join(", ").toUpperCase()} with no USD settlement amount.
                  Every figure below is short by that much.
                </p>
              )}

              {/* Summary cards. The Total card carries a per-plan
                  breakdown line sourced from the same ledger. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Paid Users",     value: payingUserCount.toString() },
                  {
                    label: "Total Revenue",
                    value: `$${totalRevenue.toFixed(2)}`,
                    sub: (["founder", "starter", "pro"] as const)
                      .map((p) => `${PLAN_LABEL[p] ?? p}: $${((revenue?.byPlan?.[p]?.cents ?? 0) / 100).toFixed(2)}`)
                      .join("  ·  "),
                  },
                  { label: "Est. MRR",       value: `$${mrr.toFixed(2)}` },
                  { label: "Est. ARR",       value: `$${arr.toFixed(2)}` },
                ].map(({ label, value, ...card }) => (
                  <div key={label} className="p-4 rounded-xl text-center space-y-1"
                    style={{ background: "oklch(0.55 0.18 65 / 0.06)", border: "1px solid oklch(0.55 0.18 65 / 0.12)" }}>
                    <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "oklch(0.55 0 0)" }}>{label}</p>
                    <p className="text-2xl font-black" style={{ color: "oklch(0.72 0.18 65)" }}>{value}</p>
                    {"sub" in card && card.sub && (
                      <p className="text-[10px] whitespace-nowrap overflow-hidden text-ellipsis" style={{ color: "oklch(0.55 0 0)" }} title={card.sub}>
                        {card.sub}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {/* Monthly revenue chart */}
              <div className="p-4 rounded-2xl space-y-3"
                style={{ background: "oklch(0 0 0 / 0.015)", border: "1px solid oklch(0 0 0 / 0.07)" }}>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "oklch(0.50 0 0)" }}>
                    Monthly Revenue — Last 12 Months
                  </p>
                  <span className="text-xs font-semibold" style={{ color: "oklch(0.72 0.18 65)" }}>
                    ${totalRevenue.toFixed(2)} collected
                  </span>
                </div>
                <div style={{ overflowX: "clip" }}>
                  <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 150 }}>
                    <defs>
                      <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--status-warn)" stopOpacity="0.25" />
                        <stop offset="100%" stopColor="var(--status-warn)" stopOpacity="0" />
                      </linearGradient>
                    </defs>

                    {[0, 0.5, 1].map(t => {
                      const y = PAD_T + (1 - t) * plotH;
                      return (
                        <g key={t}>
                          <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} strokeWidth="1" stroke="rgba(0,0,0,0.06)" />
                          <text x={PAD_L - 4} y={y + 3.5} textAnchor="end" fontSize="8.5" fill="#999">
                            ${Math.round(maxRev * t)}
                          </text>
                        </g>
                      );
                    })}

                    <path d={toArea(cs)} fill="url(#revGrad)" />
                    <path d={toPath(cs)} fill="none" stroke="var(--status-warn)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

                    {cs.map((c, i) => (
                      <circle key={i} cx={c.x} cy={c.y} r={hoveredRevIdx === i ? 4 : 2.5} fill="var(--status-warn)" style={{ transition: "r 0.1s" }} />
                    ))}

                    {/* Hover hit strips */}
                    {cs.map((c, i) => (
                      <rect
                        key={i}
                        x={Math.max(c.x - slotW / 2, PAD_L)}
                        y={PAD_T}
                        width={Math.min(slotW, plotW)}
                        height={plotH}
                        fill="transparent"
                        style={{ cursor: "crosshair" }}
                        onMouseEnter={() => setHoveredRevIdx(i)}
                        onMouseLeave={() => setHoveredRevIdx(null)}
                      />
                    ))}

                    {/* Tooltip */}
                    {hoveredRevIdx !== null && hoveredRevIdx < chartPts.length && (() => {
                      const c = cs[hoveredRevIdx];
                      const pt = chartPts[hoveredRevIdx];
                      const TW = 110, TH = 48, TR = 6;
                      const TX = Math.min(Math.max(c.x - TW / 2, PAD_L), W - PAD_R - TW);
                      const TY = Math.max(c.y - TH - 10, 2);
                      const label = new Date(pt.month + "-01").toLocaleDateString("en", { month: "long", year: "numeric" });
                      return (
                        <g pointerEvents="none">
                          <rect x={TX} y={TY} width={TW} height={TH} rx={TR} ry={TR}
                            fill="var(--bg-card)" stroke="rgba(0,0,0,0.10)" strokeWidth="1" />
                          <text x={TX + TW / 2} y={TY + 15} textAnchor="middle" fontSize="9" fill="#555" fontWeight="600">{label}</text>
                          <circle cx={TX + 14} cy={TY + 32} r="3" fill="var(--status-warn)" />
                          <text x={TX + 22} y={TY + 36} fontSize="9.5" fill="#666">
                            Revenue: <tspan fill="var(--status-warn)" fontWeight="700">${pt.revenue.toFixed(2)}</tspan>
                          </text>
                        </g>
                      );
                    })()}

                    {/* X-axis labels */}
                    {chartPts.map((p, i) => i % 2 === 0 && (
                      <text key={i} x={cs[i].x} y={H - 4} textAnchor="middle" fontSize="8.5" fill="#999">
                        {new Date(p.month + "-01").toLocaleDateString("en", { month: "short" })}
                      </text>
                    ))}
                  </svg>
                </div>
              </div>

              {/* Per-plan filter cards for the payments table — payment
                  count + lifetime revenue from the ledger. Clicking one
                  filters the table to that plan (same state as the Plan
                  dropdown); clicking the active card clears it. */}
              <div className="grid grid-cols-3 gap-3">
                {(["founder", "starter", "pro"] as const).map((p) => {
                  const entry = revenue?.byPlan?.[p];
                  const isActive = revPlanFilter === p;
                  return (
                    <button
                      key={p}
                      onClick={() => setRevPlanFilter(isActive ? "" : p)}
                      className="p-3 rounded-xl text-center space-y-0.5 cursor-pointer transition-all hover:opacity-90"
                      style={{
                        background: isActive ? "oklch(0.55 0.18 65 / 0.12)" : "oklch(0 0 0 / 0.015)",
                        border: `1px solid ${isActive ? "oklch(0.55 0.18 65 / 0.5)" : "oklch(0 0 0 / 0.08)"}`,
                        boxShadow: isActive ? "0 0 0 2px oklch(0.72 0.18 65 / 0.35)" : "none",
                      }}
                    >
                      <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "oklch(0.5 0 0)" }}>
                        {PLAN_LABEL[p]}
                      </p>
                      <p className="text-lg font-black tabular-nums" style={{ color: "oklch(0.72 0.18 65)" }}>
                        ${((entry?.cents ?? 0) / 100).toFixed(2)}
                      </p>
                      <p className="text-[11px] tabular-nums" style={{ color: "oklch(0.55 0 0)" }}>
                        {entry?.count ?? 0} payment{(entry?.count ?? 0) === 1 ? "" : "s"}
                      </p>
                    </button>
                  );
                })}
              </div>

              {/* Date-range filter for the payments table */}
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <label htmlFor="rev-date-from" className="block text-[11px] font-medium uppercase tracking-wider" style={{ color: "oklch(0.5 0 0)" }}>From</label>
                  <input
                    id="rev-date-from"
                    type="date"
                    value={revDateFrom}
                    max={revDateTo || undefined}
                    onChange={(e) => setRevDateFrom(e.target.value)}
                    className="px-3 py-2 rounded-lg text-sm bg-white text-zinc-900 outline-none transition-all"
                    style={{ border: "1px solid oklch(0 0 0 / 0.12)" }}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="rev-date-to" className="block text-[11px] font-medium uppercase tracking-wider" style={{ color: "oklch(0.5 0 0)" }}>To</label>
                  <input
                    id="rev-date-to"
                    type="date"
                    value={revDateTo}
                    min={revDateFrom || undefined}
                    onChange={(e) => setRevDateTo(e.target.value)}
                    className="px-3 py-2 rounded-lg text-sm bg-white text-zinc-900 outline-none transition-all"
                    style={{ border: "1px solid oklch(0 0 0 / 0.12)" }}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="rev-plan-filter" className="block text-[11px] font-medium uppercase tracking-wider" style={{ color: "oklch(0.5 0 0)" }}>Plan</label>
                  <select
                    id="rev-plan-filter"
                    value={revPlanFilter}
                    onChange={(e) => setRevPlanFilter(e.target.value)}
                    className="px-3 py-2 rounded-lg text-sm bg-white text-zinc-900 outline-none transition-all cursor-pointer"
                    style={{ border: "1px solid oklch(0 0 0 / 0.12)" }}
                  >
                    <option value="">All plans</option>
                    {planOptions.map((p) => (
                      <option key={p} value={p} className="capitalize">
                        {PLAN_LABEL[p] ?? p}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={() => {
                    // Local date, not toISOString() — UTC would point at
                    // yesterday/tomorrow near midnight in non-UTC zones.
                    const d = new Date();
                    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                    setRevDateFrom(today);
                    setRevDateTo(today);
                  }}
                  className="px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer hover:bg-zinc-100"
                  style={{ color: "oklch(0.72 0.18 65)", border: "1px solid oklch(0.55 0.18 65 / 0.3)" }}
                >
                  Today
                </button>
                {filtersActive && (
                  <button
                    onClick={() => { setRevDateFrom(""); setRevDateTo(""); setRevPlanFilter(""); }}
                    className="px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer hover:bg-zinc-100"
                    style={{ color: "oklch(0.5 0 0)", border: "1px solid oklch(0 0 0 / 0.12)" }}
                  >
                    Clear
                  </button>
                )}
                <span className="ml-auto text-xs font-semibold pb-2.5" style={{ color: "oklch(0.72 0.18 65)" }}>
                  {paidUsers.length} payment{paidUsers.length === 1 ? "" : "s"}{filtersActive ? " matching" : ""}
                </span>
              </div>

              {/* Paid users table */}
              {paidUsers.length === 0 ? (
                <p className="text-sm italic py-2" style={{ color: "var(--c-35)" }}>
                  {filtersActive ? "No payments match the selected filters." : "No paid users yet."}
                </p>
              ) : (
                <div className="rounded-2xl overflow-x-auto"
                  style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
                  <table className="w-full border-collapse min-w-[560px]">
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                        {["Email", "Plan", "Paid At", "Expires", "MRR equiv"].map((h) => (
                          <th key={h} className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: "var(--c-40)" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {paidUsers.map((u) => (
                        <tr key={u.email} style={{ borderBottom: "1px solid var(--bd-4)" }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bd-2)"; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                          <td className="py-3 px-4 text-sm font-mono" style={{ color: "var(--c-78)" }}>{u.email}</td>
                          <td className="py-3 px-4">
                            {u.plan ? (
                              <span className="text-xs px-2.5 py-0.5 rounded-full font-medium capitalize"
                                style={{ background: "oklch(0.72 0.25 285 / 0.1)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}>
                                {PLAN_LABEL[u.plan] ?? u.plan}
                              </span>
                            ) : <span style={{ color: "var(--c-35)" }}>—</span>}
                          </td>
                          <td className="py-3 px-4 text-sm" style={{ color: "var(--c-55)" }}>
                            {u.paidAt ? new Date(u.paidAt).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                          </td>
                          <td className="py-3 px-4 text-sm" style={{ color: "var(--c-55)" }}>
                            {u.planExpiresAt ? new Date(u.planExpiresAt).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" }) : "Ongoing"}
                          </td>
                          <td className="py-3 px-4 text-sm font-semibold" style={{ color: "oklch(0.72 0.18 65)" }}>
                            {u.plan ? `$${(PLAN_MRR[u.plan] ?? 0).toFixed(2)}/mo` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })()}

        {/* Logs section — recent activity, system errors, worker output */}
        {activeTab === "logs" && (
          <LogsSection />
        )}

        {/* Emails section — Inbox/Sent + compose. Backed by Hostinger
            IMAP/SMTP via /api/admin/emails. */}
        {activeTab === "freeusage" && <FreeUsagePanel />}

        {activeTab === "agent" && (
          <section id="agent" className="rounded-2xl max-w-full min-w-0"
            style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
            <HeclusAgentPanel />
          </section>
        )}

        {activeTab === "emails" && <EmailsPanel />}

        {/* Support section — in-app HelpButton ticket queue, status
            triage, admin notes. Backed by support_tickets table. */}
        {activeTab === "support" && (
          <section
            id="support"
            className="rounded-2xl max-w-full min-w-0"
            style={{
              background: "var(--bg-card)",
              border: "1px solid oklch(0 0 0 / 0.07)",
              padding: "16px",
              scrollMarginTop: "80px",
              boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)",
            }}
          >
            <SupportPanel />
          </section>
        )}

        {activeTab === "reviews" && (
          <section
            id="reviews"
            className="rounded-2xl max-w-full min-w-0"
            style={{
              background: "var(--bg-card)",
              border: "1px solid oklch(0 0 0 / 0.07)",
              padding: "16px",
              scrollMarginTop: "80px",
              boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)",
            }}
          >
            <FeedbackPanel />
          </section>
        )}

        {activeTab === "features" && (
          <section
            id="features"
            className="rounded-2xl max-w-full min-w-0"
            style={{
              background: "var(--bg-card)",
              border: "1px solid oklch(0 0 0 / 0.07)",
              padding: "16px",
              scrollMarginTop: "80px",
              boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)",
            }}
          >
            <FeatureRequestsPanel />
          </section>
        )}

        {/* Memory section — per-stage RSS + timing from the video
            worker's projects.assembly_metrics column. Helps locate
            where assembly memory peaks and which stage takes longest. */}
        {activeTab === "memory" && <MemoryPanel />}

        {/* Setup section — product-wide API key management */}
        {activeTab === "setup" && (
          <SetupSection productKeys={productKeys} keysLoading={keysLoading} mutateKeys={mutateKeys} />
        )}
      </main>

      {nicheLimitUser && (
        <NicheLimitOverrideModal
          user={nicheLimitUser}
          onClose={() => setNicheLimitUser(null)}
          onSaved={() => mutate()}
        />
      )}

      <Dialog
        open={promoteTarget !== null}
        onOpenChange={(open) => { if (!open && promotingUser === null) setPromoteTarget(null); }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Make admin?</DialogTitle>
            <DialogDescription>
              The user will gain full access to the admin dashboard — including all
              user management actions, API key controls, and concurrency settings.
              You can reverse this later via &quot;Remove admin&quot; on the same kebab menu.
            </DialogDescription>
          </DialogHeader>
          {promoteTarget && (
            <div className="rounded-xl p-3 space-y-1.5"
              style={{ background: "oklch(0.55 0.15 220 / 0.06)", border: "1px solid oklch(0.55 0.15 220 / 0.2)" }}>
              <p className="text-xs font-mono truncate" style={{ color: "var(--c-78)" }}>{promoteTarget.email}</p>
              <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: "var(--c-55)" }}>
                <span>Plan: <span className="font-semibold" style={{ color: "var(--c-90)" }}>{promoteTarget.plan ?? "—"}</span></span>
                <span>Projects: <span className="font-semibold tabular-nums" style={{ color: "var(--c-90)" }}>{promoteTarget.projectCount}</span></span>
                <span>Last sign-in: <span className="font-semibold" style={{ color: "var(--c-90)" }}>{promoteTarget.lastSignIn ? timeAgo(promoteTarget.lastSignIn) : "Never"}</span></span>
              </div>
            </div>
          )}
          <DialogFooter>
            <button
              onClick={() => { if (promoteTarget) handleMakeAdmin(promoteTarget.email); }}
              disabled={promotingUser !== null}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.55 0.15 220)", color: "white" }}
            >
              {promotingUser !== null ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <Spinner size={14} className="text-white" />
                  Promoting…
                </span>
              ) : "Make admin"}
            </button>
            <button
              onClick={() => setPromoteTarget(null)}
              disabled={promotingUser !== null}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={demoteTarget !== null}
        onOpenChange={(open) => { if (!open && demotingUser === null) setDemoteTarget(null); }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove admin?</DialogTitle>
            <DialogDescription>
              The user will lose access to the admin dashboard immediately. Their
              account, projects, and existing plan are untouched — you can re-promote
              them later via &quot;Make admin&quot;.
            </DialogDescription>
          </DialogHeader>
          {demoteTarget && (
            <div className="rounded-xl p-3 space-y-1.5"
              style={{ background: "oklch(0.6 0.22 25 / 0.06)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}>
              <p className="text-xs font-mono truncate" style={{ color: "var(--c-78)" }}>{demoteTarget.email}</p>
              <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: "var(--c-55)" }}>
                <span>Plan: <span className="font-semibold" style={{ color: "var(--c-90)" }}>{demoteTarget.plan ?? "—"}</span></span>
                <span>Projects: <span className="font-semibold tabular-nums" style={{ color: "var(--c-90)" }}>{demoteTarget.projectCount}</span></span>
                <span>Last sign-in: <span className="font-semibold" style={{ color: "var(--c-90)" }}>{demoteTarget.lastSignIn ? timeAgo(demoteTarget.lastSignIn) : "Never"}</span></span>
              </div>
            </div>
          )}
          <DialogFooter>
            <button
              onClick={() => { if (demoteTarget) handleRemoveAdmin(demoteTarget.email); }}
              disabled={demotingUser !== null}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.6 0.22 25)", color: "white" }}
            >
              {demotingUser !== null ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <Spinner size={14} className="text-white" />
                  Removing…
                </span>
              ) : "Remove admin"}
            </button>
            <button
              onClick={() => setDemoteTarget(null)}
              disabled={demotingUser !== null}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => { if (!open && removing === null) setRemoveTarget(null); }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove user?</DialogTitle>
            <DialogDescription>
              This permanently deletes the auth account and cascades to all of their projects, beats,
              thumbnails, and app settings. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          {removeTarget && (
            <div className="rounded-xl p-3 space-y-1.5"
              style={{ background: "oklch(0.6 0.22 25 / 0.06)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}>
              <p className="text-xs font-mono truncate" style={{ color: "var(--c-78)" }}>{removeTarget.email}</p>
              <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: "var(--c-55)" }}>
                <span>Plan: <span className="font-semibold" style={{ color: "var(--c-90)" }}>{removeTarget.plan ?? "—"}</span></span>
                <span>Projects: <span className="font-semibold tabular-nums" style={{ color: "var(--c-90)" }}>{removeTarget.projectCount}</span></span>
                <span>Niches used: <span className="font-semibold tabular-nums" style={{ color: "var(--c-90)" }}>{removeTarget.nichesUsed}</span></span>
              </div>
            </div>
          )}
          <DialogFooter>
            <button
              onClick={() => { if (removeTarget) handleRemoveUser(removeTarget.email); }}
              disabled={removing !== null}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.55 0.22 25)", color: "white" }}
            >
              {removing !== null ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <Spinner size={14} className="text-white" />
                  Removing…
                </span>
              ) : "Remove user"}
            </button>
            <button
              onClick={() => setRemoveTarget(null)}
              disabled={removing !== null}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
