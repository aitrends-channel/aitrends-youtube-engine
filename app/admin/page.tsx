"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import {
  ArrowLeft, LogOut, BarChart3, Users, UserCheck, FolderOpen,
  CheckCircle2, UserCog, UserPlus, Settings, TrendingUp, Clapperboard, Film, Clock,
  DollarSign, SlidersHorizontal, Sparkles, RotateCcw, Pencil, FileText, AlertCircle, Activity, Server,
  Crown, MoreVertical, Trash2, Copy, Gauge, Eye, EyeOff, Mail, KeyRound, CreditCard, Rocket, X, Check, LifeBuoy, FlaskConical, MemoryStick,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { launchAllowedClient } from "@/lib/env";
import useSWR from "swr";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { isAdminUser } from "@/lib/admin";
import EmailsPanel from "./EmailsPanel";
import { TtsCostLens } from "@/components/admin/TtsCostLens";
import { SupportPanel } from "@/components/admin/SupportPanel";
import { MemoryPanel } from "@/components/admin/MemoryPanel";

const PHASE_PATHS: Record<number, string> = {
  1: "channel", 2: "channel", 3: "channel", 4: "channel", 5: "channel",
  6: "topic", 7: "visuals", 8: "visuals", 9: "prompts", 10: "prompts",
  11: "visuals", 12: "visuals", 13: "prompts", 14: "generate", 15: "assemble",
};

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
          background: "white",
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
  phaseLabel: string;
  phasePath: string;
  progress: number;
  createdAt: string;
  // Wall-clock seconds between worker pickup and terminal status
  // (done/stopped/failed). Null when the project hasn't completed
  // an assembly yet, or pre-dates migration 049_assembly_timing.
  assembleSeconds: number | null;
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

const SERVICES = ["youtube_data_api_key", "supadata_api_key", "heclus_kie_api_key", "anthropic_api_key"] as const;
type Service = typeof SERVICES[number];

const SERVICE_LABELS: Record<Service, string> = {
  youtube_data_api_key: "YouTube Data API Key",
  supadata_api_key: "Supadata API Key",
  heclus_kie_api_key: "Heclus KIE API Key",
  anthropic_api_key: "Anthropic API Key (direct)",
};

interface ActivityPoint {
  date: string;
  projects: number;
  videos: number;
  users: number;
}

interface AdminStatsResponse {
  stats: AdminStats;
  activity: ActivityPoint[];
  activityMonthly: ActivityPoint[];
  users: AdminUser[];
  projects: AdminProject[];
}

function StatCard({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number | undefined;
  icon: React.ElementType;
  accent?: "purple" | "green" | "amber";
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
      style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.06), 0 1px 3px oklch(0 0 0 / 0.04)" }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
          {label}
        </span>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: iconBg, border: `1px solid ${iconBorder}` }}>
          <Icon size={15} style={{ color: iconColor }} />
        </div>
      </div>
      <div className="text-3xl font-black" style={{ color: valueColor }}>
        {value === undefined ? "—" : value.toLocaleString()}
      </div>
    </div>
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
      style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
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
      style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.55 0.15 220 / 0.1)", border: "1px solid oklch(0.55 0.15 220 / 0.2)" }}>
          <FileText size={16} style={{ color: "oklch(0.62 0.15 220)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Logs</h2>
          <p className="text-xs" style={{ color: "var(--c-42)" }}>Recent activity, system errors, and worker output</p>
        </div>
      </div>

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
  const [setupTab, setSetupTab] = usePersistentTab<"keys" | "models" | "anthropic" | "concurrency" | "plans">(
    "config", "keys", ["keys", "models", "anthropic", "concurrency", "plans"],
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
    <section id="setup" className="rounded-2xl space-y-5" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.55 0.15 220 / 0.1)", border: "1px solid oklch(0.55 0.15 220 / 0.2)" }}>
          <SlidersHorizontal size={16} style={{ color: "oklch(0.62 0.15 220)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Config</h2>
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
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setSetupTab(t.id)}
            className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer"
            style={setupTab === t.id ? {
              background: "white",
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
        <div className="space-y-4">
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
                                  style={{ background: "white", border: "1px solid oklch(0.62 0.15 220 / 0.4)", color: "oklch(0.2 0 0)" }}
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
                                      style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.08)", boxShadow: "0 8px 24px oklch(0 0 0 / 0.12)" }}>
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
  const { data: videoModels } = useSWR<{ id: string; name: string }[]>("/api/kie/models?type=video", fetcher);

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
};

// Mirrors lib/concurrency-config.ts CONCURRENCY_FIELDS + CONCURRENCY_DEFAULTS —
// kept in sync by hand. Defaults live here too so the UI can seed the
// inputs and the "Reset to defaults" button without an extra round-trip.
const CONCURRENCY_FIELDS: {
  key: keyof ConcurrencyConfig;
  label: string;
  description: string;
  default: number;
  min: number;
  max: number;
  disabled?: boolean;
  group?: string;
}[] = [
  { key: "image_prompts_chunks",   label: "Image prompts generation", description: "How many chunks generated at a time.", default: 1, min: 1, max: 20, group: "Prompts" },
  { key: "video_prompts_chunks",   label: "Video prompts generation", description: "How many chunks generated at a time.", default: 1, min: 1, max: 20, group: "Prompts" },
  { key: "tts_beat_batch",         label: "Voiceovers",          description: "Voiceover beats generated per batch.", default: 5, min: 1, max: 20, group: "Media" },
  { key: "video_worker",           label: "AI videos generation", description: "How many videos generated at once.",   default: 3, min: 1, max: 50, group: "Media" },
  { key: "image_generation_batch", label: "AI image generation",  description: "How many images generated at once.",   default: 3, min: 1, max: 20, group: "Media" },
  { key: "assembly_projects",      label: "Projects",            description: "How many videos assembled at once.",   default: 1, min: 1, max: 5,  group: "Assemble" },
  { key: "assembly_beats",         label: "Beats",               description: "Beats processed at once per video.",   default: 1, min: 1, max: 10, group: "Assemble" },
  { key: "finish_images_poll",     label: "Image finishers",     description: "Workers finalizing completed images.", default: 5, min: 1, max: 50, disabled: true, group: "Others" },
  { key: "thumbnail_batch",        label: "Thumbnail batch",     description: "Thumbnails generated per batch.",      default: 2, min: 1, max: 20, group: "Others" },
];

function ConcurrencyPanel() {
  const { data, mutate, isLoading } = useSWR<ConcurrencyConfig>(
    "/api/admin/concurrency",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [draft, setDraft] = useState<Record<keyof ConcurrencyConfig, string>>(() => {
    const seed = {} as Record<keyof ConcurrencyConfig, string>;
    for (const f of CONCURRENCY_FIELDS) seed[f.key] = String(f.default);
    return seed;
  });
  const [savingKey, setSavingKey] = useState<keyof ConcurrencyConfig | null>(null);
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

  function parsedField(key: keyof ConcurrencyConfig) {
    const raw = draft[key].trim();
    if (raw === "") return { value: null as number | null, valid: false };
    const n = Number(raw);
    const field = CONCURRENCY_FIELDS.find(f => f.key === key)!;
    const valid = Number.isInteger(n) && n >= field.min && n <= field.max;
    return { value: n, valid };
  }

  function isDirty(key: keyof ConcurrencyConfig): boolean {
    if (!data) return false;
    const { value } = parsedField(key);
    return value !== data[key];
  }

  async function saveField(key: keyof ConcurrencyConfig) {
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
                  background: inGroup ? "white" : "oklch(0 0 0 / 0.02)",
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

type Routing = "client_kie" | "heclus_kie" | "heclus_direct";
type WorkflowStep =
  | "analyze"
  | "ideas"
  | "script"
  | "visual_analysis"
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
    description: "Each user's own KIE API key (from their Settings) is used. Calls are billed to the end user.",
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
// union exported from lib/claude/routing.ts.
const WORKFLOW_STEP_LABELS: Record<WorkflowStep, { title: string; subtitle: string }> = {
  analyze:         { title: "Channel Analysis",  subtitle: "Reverse-engineers the channel's style from transcripts" },
  ideas:           { title: "Video Ideas",       subtitle: "Generates trending topic suggestions" },
  script:          { title: "Script Generation", subtitle: "Writes the long-form narration script" },
  visual_analysis: { title: "Visual Analysis",   subtitle: "Extracts the channel's visual style from frames" },
  image_prompts:   { title: "Image Prompts",     subtitle: "One AI image prompt per script beat" },
  video_prompts:   { title: "Video Prompts",     subtitle: "Motion + camera instructions per beat" },
  thumbnails:      { title: "Thumbnail Concepts", subtitle: "Generates 5 thumbnail design concepts" },
};
const WORKFLOW_STEP_LIST: WorkflowStep[] = [
  "analyze", "ideas", "script", "visual_analysis",
  "image_prompts", "video_prompts", "thumbnails",
];

interface RoutingResponse {
  routing: Routing;
  per_step: Partial<Record<WorkflowStep, Routing>>;
  steps: WorkflowStep[];
}

function AnthropicRoutingPanel() {
  const swr = useSWR<RoutingResponse>("/api/admin/anthropic-routing", fetcher, { revalidateOnFocus: false });
  const [subTab, setSubTab] = usePersistentTab<"general" | "per_step">(
    "config.anthropic", "general", ["general", "per_step"],
  );

  const subTabs: { id: "general" | "per_step"; label: string }[] = [
    { id: "general",  label: "General"  },
    { id: "per_step", label: "Per step" },
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
  selected: RoutingValue;
  serverActive?: RoutingValue;
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
              background: active ? "oklch(0.62 0.15 220 / 0.08)" : "white",
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
                {active && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "white" }} />}
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
  onConfirm,
  onCancel,
}: {
  open: boolean;
  saving: boolean;
  title: string;
  description: string;
  preview: RoutingChoice | null;
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
            ) : "Switch routing"}
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

function PerStepRoutingPanel({ swr }: { swr: ReturnType<typeof useSWR<RoutingResponse>> }) {
  const { data, mutate, isLoading } = swr;
  const [pending, setPending] = useState<{ step: WorkflowStep; value: RoutingValue } | null>(null);
  const [saving, setSaving] = useState(false);

  const generalLabel = data
    ? (ROUTING_OPTIONS.find((o) => o.id === data.routing)?.title ?? data.routing)
    : "—";
  const perStepChoices = buildPerStepChoices(generalLabel);
  const pendingChoice = pending ? perStepChoices.find((c) => c.id === pending.value) ?? null : null;
  const pendingStepMeta = pending ? WORKFLOW_STEP_LABELS[pending.step] : null;

  async function applyStepRouting(step: WorkflowStep, value: RoutingValue) {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/anthropic-routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step, routing: value === "inherit" ? null : value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed to save");
      }
      toast.success(value === "inherit"
        ? `${WORKFLOW_STEP_LABELS[step].title}: inheriting from General`
        : `${WORKFLOW_STEP_LABELS[step].title} routing saved`);
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
      </p>

      {isLoading && <p className="text-xs" style={{ color: "var(--c-42)" }}>Loading…</p>}

      <div className="space-y-4">
        {WORKFLOW_STEP_LIST.map((step) => {
          const override = data?.per_step?.[step] ?? null;
          const selectedValue: RoutingValue = override ?? "inherit";
          const meta = WORKFLOW_STEP_LABELS[step];
          // Disable interaction while ANY step is saving so a confirm
          // mid-dialog can't be racing another save's optimistic state.
          const disabled = saving;
          return (
            <div
              key={step}
              className="rounded-xl p-4 space-y-3"
              style={{
                background: "white",
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
                  {meta.title}
                </span>
                {override === null ? (
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
                <span className="text-[11px]" style={{ color: "var(--c-50)" }}>
                  · {meta.subtitle}
                </span>
              </div>

              <RoutingRadios
                options={perStepChoices}
                selected={selectedValue}
                serverActive={selectedValue}
                disabled={disabled}
                onPick={(id) => setPending({ step, value: id })}
              />
            </div>
          );
        })}
      </div>

      <RoutingConfirmDialog
        open={pending !== null}
        saving={saving}
        title={pendingStepMeta ? `Switch routing for ${pendingStepMeta.title}?` : "Switch routing?"}
        description="Only this step is affected. Change takes effect immediately for all users."
        preview={pendingChoice}
        onConfirm={() => { if (pending) applyStepRouting(pending.step, pending.value); }}
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
      <div className="rounded-2xl p-5 space-y-4 mt-[15px]" style={{ background: "white", border: "2px solid silver" }}>
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

    const payload = {
      ...(mode === "create" ? { slug } : {}),
      name: name.trim(),
      price_display: priceDisplay.trim(),
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

function LaunchModal({ onClose }: { onClose: () => void }) {
  const [excludeEmails, setExcludeEmails] = useState<string[]>([]);
  const [excludeInput, setExcludeInput] = useState("");
  const [clearAllLogs, setClearAllLogs] = useState(false);
  const [clearAllActivity, setClearAllActivity] = useState(false);
  const [resetFounderSlots, setResetFounderSlots] = useState(false);
  const [clearEmails, setClearEmails] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [launching, setLaunching] = useState(false);
  const [results, setResults] = useState<LaunchStepResult[] | null>(null);
  const allOk = results !== null && results.every((r) => r.ok);

  async function fireLaunch() {
    setLaunching(true);
    try {
      const res = await fetch("/api/admin/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          excludeEmails,
          clearLogs: clearAllLogs,
          clearActivity: clearAllActivity,
          resetFounderSlots,
          clearEmails,
        }),
      });
      const json = await res.json().catch(() => ({})) as { results?: LaunchStepResult[]; error?: string };
      if (json.results) {
        setResults(json.results);
        if (res.ok) toast.success("Launch complete");
        else toast.error("Launch finished with errors — see details");
      } else {
        throw new Error(json.error ?? `Launch failed (${res.status})`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Launch failed");
    } finally {
      setLaunching(false);
    }
  }

  function addExcludeEmail() {
    const candidate = excludeInput.trim().toLowerCase();
    if (!candidate) return;
    // Loose email shape check — the deletion endpoint will validate
    // against auth.users anyway; this just guards against obvious
    // fat-finger entries.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) {
      toast.error("Not a valid email");
      return;
    }
    if (excludeEmails.includes(candidate)) {
      toast.error("Already in the list");
      return;
    }
    setExcludeEmails((prev) => [...prev, candidate]);
    setExcludeInput("");
  }

  function removeExcludeEmail(email: string) {
    setExcludeEmails((prev) => prev.filter((e) => e !== email));
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-2xl text-base">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Rocket size={18} style={{ color: "oklch(0.55 0.15 145)" }} />
            Launch Heclus
          </DialogTitle>
          <DialogDescription className="text-sm">
            Review what gets cleared from each surface before flipping the switch.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto space-y-5 pr-1">
          {/* ── Users section ─────────────────────────────────── */}
          <section className="space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-zinc-800">Users</p>
              <p className="text-xs text-zinc-500">
                Enter one email at a time and click Add. Listed emails are kept; everyone else gets deleted when launch fires.
              </p>
            </div>

            <div className="flex items-stretch gap-2">
              <input
                type="email"
                value={excludeInput}
                onChange={(e) => setExcludeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addExcludeEmail();
                  }
                }}
                placeholder="admin@heclus.io"
                className="flex-1 px-3 py-2.5 rounded-lg text-sm outline-none font-mono bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400"
              />
              <button
                type="button"
                onClick={addExcludeEmail}
                disabled={!excludeInput.trim()}
                className="px-4 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: "oklch(0.55 0.15 145)", color: "white" }}
              >
                Add
              </button>
            </div>

            {excludeEmails.length === 0 ? (
              <p className="text-xs italic text-zinc-400">No emails added yet.</p>
            ) : (
              <ul className="space-y-1">
                {excludeEmails.map((email) => (
                  <li
                    key={email}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-zinc-50 ring-1 ring-zinc-200"
                  >
                    <span className="text-sm font-mono text-zinc-700 truncate">{email}</span>
                    <button
                      type="button"
                      onClick={() => removeExcludeEmail(email)}
                      className="p-1 rounded transition-all hover:bg-red-100 cursor-pointer"
                      title="Remove"
                    >
                      <X size={14} className="text-red-600" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Logs section ──────────────────────────────────── */}
          <section className="space-y-2 pt-4 border-t border-zinc-200">
            <p className="text-sm font-semibold text-zinc-800">Logs</p>
            <label className="flex items-center gap-3 cursor-pointer text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={clearAllLogs}
                onChange={(e) => setClearAllLogs(e.target.checked)}
                className="w-5 h-5 cursor-pointer accent-emerald-600"
              />
              Clear all system logs
            </label>
          </section>

          {/* ── Activity section ──────────────────────────────── */}
          <section className="space-y-2 pt-4 border-t border-zinc-200">
            <p className="text-sm font-semibold text-zinc-800">Activity</p>
            <label className="flex items-center gap-3 cursor-pointer text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={clearAllActivity}
                onChange={(e) => setClearAllActivity(e.target.checked)}
                className="w-5 h-5 cursor-pointer accent-emerald-600"
              />
              Reset activity chart from launch day
            </label>
          </section>

          {/* ── Founder promo section ─────────────────────────── */}
          <section className="space-y-2 pt-4 border-t border-zinc-200">
            <p className="text-sm font-semibold text-zinc-800">Founder promo</p>
            <label className="flex items-center gap-3 cursor-pointer text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={resetFounderSlots}
                onChange={(e) => setResetFounderSlots(e.target.checked)}
                className="w-5 h-5 cursor-pointer accent-emerald-600"
              />
              Reset founder slot counter and clear claims log
            </label>
          </section>

          {/* ── Emails section ────────────────────────────────── */}
          <section className="space-y-2 pt-4 border-t border-zinc-200">
            <p className="text-sm font-semibold text-zinc-800">Emails</p>
            <label className="flex items-center gap-3 cursor-pointer text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={clearEmails}
                onChange={(e) => setClearEmails(e.target.checked)}
                className="w-5 h-5 cursor-pointer accent-emerald-600"
              />
              Clear email history (admin Emails panel)
            </label>
          </section>
        </div>

        {results && (
          <div className="rounded-lg p-3 space-y-2 bg-zinc-50 ring-1 ring-zinc-200">
            <p className="text-sm font-semibold text-zinc-700">Launch results</p>
            <ul className="space-y-1">
              {results.map((r) => (
                <li key={r.step} className="flex items-start gap-2 text-xs">
                  <span className="mt-0.5 shrink-0">
                    {r.ok ? <Check size={14} className="text-emerald-600" /> : <X size={14} className="text-red-600" />}
                  </span>
                  <div className="min-w-0">
                    <p className="font-mono text-zinc-700">{r.step}</p>
                    {r.detail && <p className="text-zinc-500 break-words">{r.detail}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          {!results ? (
            <>
              {(() => {
                // Disable Launch when the admin hasn't configured the
                // form at all — either no exclude emails entered, or
                // none of the optional cleanups checked. Forces an
                // explicit "I picked who to keep AND what to clean"
                // decision instead of a silent click-through.
                const hasExcludes = excludeEmails.length > 0;
                const hasAnyCheck = clearAllLogs || clearAllActivity || resetFounderSlots || clearEmails;
                const canSubmit = hasExcludes && hasAnyCheck;
                const reason = !hasExcludes && !hasAnyCheck
                  ? "Add at least one exclude email and check at least one cleanup option"
                  : !hasExcludes
                    ? "Add at least one email to exclude from deletion"
                    : "Check at least one cleanup option";
                return (
                  <button
                    onClick={() => { setConfirmText(""); setConfirmOpen(true); }}
                    disabled={launching || !canSubmit}
                    title={canSubmit ? "Launch Heclus" : reason}
                    className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      background: "oklch(0.55 0.15 145)",
                      color: "white",
                      boxShadow: canSubmit ? "0 0 12px oklch(0.55 0.15 145 / 0.25)" : "none",
                    }}
                  >
                    <span className="inline-flex items-center justify-center gap-2">
                      <Rocket size={14} />
                      Launch
                    </span>
                  </button>
                );
              })()}
              <button
                onClick={onClose}
                disabled={launching}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-all bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-40"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-all bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-100"
            >
              Close
            </button>
          )}
        </DialogFooter>
      </DialogContent>

      {confirmOpen && (
        <Dialog open onOpenChange={(open) => { if (!open && !launching) setConfirmOpen(false); }}>
          <DialogContent showCloseButton={false} className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Rocket size={16} style={{ color: "oklch(0.55 0.15 145)" }} />
                Confirm launch
              </DialogTitle>
              <DialogDescription className="text-sm">
                The following will happen, in order. None of it is reversible without backup.
              </DialogDescription>
            </DialogHeader>

            <ul className="text-sm space-y-2 list-disc pl-5 text-zinc-700 max-h-[40vh] overflow-y-auto">
              <li>
                Delete <span className="font-semibold">every user</span> in auth.users except the {excludeEmails.length} email{excludeEmails.length === 1 ? "" : "s"} you excluded. Their projects, beats, voiceovers, account_settings, and other per-user rows cascade.
              </li>
              <li>
                Sweep <code className="text-xs bg-zinc-100 px-1 rounded">project_costs</code> — delete every cost row not owned by an excluded user (catches orphans the FK cascade missed).
              </li>
              <li>
                Wipe each deleted user&apos;s <span className="font-semibold">R2 bucket folder</span> (<code className="text-xs bg-zinc-100 px-1 rounded">&lt;email&gt;/</code>) — all their generated images, voiceovers, thumbnails, and assembled MP4s.
              </li>
              <li>
                Drop any <code className="text-xs bg-zinc-100 px-1 rounded">assembly:&lt;projectId&gt;</code> entries from <span className="font-semibold">Upstash Redis</span> for the deleted projects.
              </li>
              {clearAllLogs && <li>Truncate <code className="text-xs bg-zinc-100 px-1 rounded">system_logs</code>.</li>}
              {clearAllActivity && <li>Set the activity-chart cutoff to now — the admin chart starts fresh from launch day.</li>}
              {resetFounderSlots && <li>Reset founder slot counter to 0, re-arm the promo, and truncate <code className="text-xs bg-zinc-100 px-1 rounded">founder_claims_log</code>.</li>}
              {clearEmails && <li>Truncate <code className="text-xs bg-zinc-100 px-1 rounded">emails</code>.</li>}
              <li>Flip <code className="text-xs bg-zinc-100 px-1 rounded">dodo_payment_mode</code> to <span className="font-semibold">production</span>.</li>
            </ul>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-zinc-700">
                Type <span className="font-mono">LAUNCH</span> to confirm
              </label>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={launching}
                autoFocus
                placeholder="LAUNCH"
                className="w-full px-3 py-2 rounded-lg text-sm outline-none font-mono bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400"
              />
            </div>

            <DialogFooter>
              <button
                onClick={async () => {
                  setConfirmOpen(false);
                  await fireLaunch();
                }}
                disabled={launching || confirmText !== "LAUNCH"}
                className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed bg-red-600 text-white"
              >
                {launching ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <Spinner size={14} className="text-white" />
                    Launching…
                  </span>
                ) : "Yes, launch"}
              </button>
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={launching}
                className="flex-1 py-2 rounded-xl text-sm font-medium transition-all bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-40"
              >
                Cancel
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {launching && (
        <Dialog open onOpenChange={() => {}}>
          <DialogContent showCloseButton={false} className="sm:max-w-xs">
            <div className="flex flex-col items-center gap-3 py-4">
              <Spinner size={24} className="text-emerald-600" />
              <p className="text-sm font-semibold text-zinc-700">Launching…</p>
              <p className="text-xs text-zinc-500 text-center">
                Deleting users, then cleanup, then flipping payment mode. Don&apos;t close this tab.
              </p>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* allOk drives an emerald banner above results when present;
          kept inline so the modal layout stays single-scroll. */}
      {results && allOk && null}
    </Dialog>
  );
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
        style={{ background: "#ecf0f1" }}
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
  const [saving, setSaving] = useState(false);

  const keyValue = activeEnv === "test" ? testKey : prodKey;
  const urlValue = activeEnv === "test" ? testUrl : prodUrl;
  const webhookValue = activeEnv === "test" ? testWebhook : prodWebhook;
  const savedKey = (activeEnv === "test" ? settings?.secretKeyTest : settings?.secretKeyProduction) ?? "";
  const savedUrl = (activeEnv === "test" ? settings?.baseUrlTest : settings?.baseUrlProduction) ?? "";
  const savedWebhook = (activeEnv === "test" ? settings?.webhookSecretTest : settings?.webhookSecretProduction) ?? "";
  // Dirty when the admin has typed something into any of the three
  // inputs for the active env. Empty inputs are a no-op — clearing
  // a saved value isn't supported through this card on purpose.
  const dirty = !!keyValue.trim() || !!urlValue.trim() || !!webhookValue.trim();

  function clearActiveEnvBuffers() {
    if (activeEnv === "test") {
      setTestKey(""); setTestUrl(""); setTestWebhook("");
    } else {
      setProdKey(""); setProdUrl(""); setProdWebhook("");
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
      style={{ background: "white", border: "2px solid silver" }}
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
              ? { background: "white", color: "var(--c-90)", boxShadow: "0 1px 3px oklch(0 0 0 / 0.1)" }
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

const SK = { background: "oklch(0 0 0 / 0.07)" };
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
        <div className="rounded-2xl space-y-3" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07)" }}>
          <div className="h-3 w-10 rounded animate-pulse" style={SK} />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-[10px]">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="p-6 rounded-2xl space-y-4"
                style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.06)" }}>
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
        <div className="p-5 rounded-2xl space-y-4" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07)" }}>
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
        <div className="rounded-2xl space-y-4" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07)" }}>
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

export default function AdminPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const [launchOpen, setLaunchOpen] = useState(false);

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

  // Revenue tab reads everything (Total/MRR/ARR/paying count + chart)
  // from the immutable revenue_events ledger so the numbers survive
  // user deletion. MRR and ARR are rolling-window actual-revenue
  // figures (last 30 / 365 days), not amortized recurring math.
  const { data: revenue } = useSWR<{
    totalCents: number;
    mrrCents: number;
    arrCents: number;
    payingUserCount: number;
    launchedAt: string | null;
    last12Months: { month: string; amountCents: number }[];
    recentEvents: { amountCents: number; occurredAt: string | null; userEmail: string | null; plan: string | null; eventType: string | null; dodoPaymentId: string | null }[];
    eventCount: number;
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
  const [usersPage, setUsersPage] = useState(1);
  const [userSearch, setUserSearch] = useState("");
  type PlanBucket = "all" | "admin" | "founder" | "pro" | "starter" | "free" | "pending";
  const [planFilter, setPlanFilter] = useState<PlanBucket>("all");
  const [nicheLimitUser, setNicheLimitUser] = useState<AdminUser | null>(null);
  const [projectsPage, setProjectsPage] = useState(1);
  // Single search input shared by both Videos sub-tabs (General +
  // Cost) — both render rows out of the same sortedProjects array
  // so one filter feeds both tables. Matches against title (topic),
  // channel name, user email, and project ID for flexibility.
  const [projectSearch, setProjectSearch] = useState("");
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
  const [activeTab, setActiveTab] = usePersistentTab<
    "stats" | "activity" | "users" | "projects" | "revenue" | "logs" | "emails" | "support" | "memory" | "setup"
  >(
    "main",
    "stats",
    ["stats", "activity", "users", "projects", "revenue", "logs", "emails", "support", "memory", "setup"],
  );

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

  if (!authChecked) return (
    <div className="min-h-screen flex flex-col" data-theme="light" style={{ background: "var(--bg-page)" }}>
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
  function bucketOf(u: AdminUser): Exclude<PlanBucket, "all"> {
    if (u.isAdmin) return "admin";
    if (u.status === "Pending") return "pending";
    const planNorm = (u.plan ?? "").toLowerCase().trim();
    if (planNorm === "founder") return "founder";
    if (planNorm === "pro") return "pro";
    if (planNorm === "starter") return "starter";
    if (u.status === "Paid") return "starter";
    return "free";
  }

  const userSearchLower = userSearch.trim().toLowerCase();
  const filteredUsers = users.filter((u) => {
    if (planFilter !== "all" && bucketOf(u) !== planFilter) return false;
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
  const filteredProjects = projectSearchLower
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

  return (
    <div className="min-h-screen flex flex-col" data-theme="light" style={{ background: "var(--bg-page)" }}>
      {/* Header */}
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
                      style={{ color: "#f87171" }}
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

      <main className="flex-1 w-full px-[30px] py-8 sm:py-12 space-y-6 sm:space-y-10">
        {/* Page heading + Launch action, sharing one row */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
              <BarChart3 size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-foreground">Admin Dashboard</h1>
              <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                Users, projects, and system overview
              </p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 shrink-0">
            {(() => {
              const canLaunch = launchAllowedClient();
              return (
                <button
                  onClick={() => setLaunchOpen(true)}
                  disabled={!canLaunch}
                  title={canLaunch ? "Launch Heclus" : "Disabled on staging — only enabled in production or local dev"}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg text-base font-bold transition-all hover:opacity-90 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                  style={{
                    width: "100px",
                    height: "50px",
                    padding: "10px",
                    background: "oklch(0.55 0.15 145)",
                    color: "white",
                    boxShadow: canLaunch ? "0 0 12px oklch(0.55 0.15 145 / 0.25)" : "none",
                  }}
                >
                  <Rocket size={16} />
                  Launch
                </button>
              );
            })()}
            {revenue?.launchedAt && (
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
            )}
          </div>
        </div>

        {/* Tabs — original (in flow, always rendered, observed by IntersectionObserver) */}
        {(() => {
          const TAB_ITEMS = [
            { id: "stats",    label: "Stats",    icon: BarChart3 },
            { id: "activity", label: "Activity", icon: TrendingUp },
            { id: "users",    label: "Users",    icon: Users },
            { id: "projects", label: "Videos",   icon: Clapperboard },
            { id: "revenue",  label: "Revenue",  icon: DollarSign },
            { id: "logs",     label: "Logs",     icon: FileText },
            { id: "emails",   label: "Emails",   icon: Mail },
            { id: "support",  label: "Support tickets",  icon: LifeBuoy },
            { id: "memory",   label: "Memory",   icon: MemoryStick },
            { id: "setup",    label: "Config",   icon: Settings },
          ] as const;

          const tabButtons = (TAB_ITEMS).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className="flex-1 flex items-center justify-center gap-1.5 px-2 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all cursor-pointer"
              style={activeTab === id
                ? { background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.35)" }
                : { color: "oklch(0.50 0 0)" }}
            >
              <Icon size={14} />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ));

          return (
            <div
              className="flex items-center gap-1 p-1 rounded-xl w-full"
              style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)" }}
            >
              {tabButtons}
            </div>
          );
        })()}

        {/* Stats cards */}
        <div id="stats" className="rounded-2xl space-y-3" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)", display: activeTab === "stats" ? undefined : "none" }}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "oklch(0.50 0 0)" }}>Stats</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-[10px]">
            <StatCard label="Total Niches"      value={stats?.totalProjects}    icon={FolderOpen}                    />
            <StatCard label="Access Granted"    value={stats?.accessGranted}    icon={Users}         accent="purple" />
            <StatCard label="Active Accounts"   value={stats?.activeAccounts}   icon={UserCheck}                     />
            <StatCard label="Total Videos"      value={stats?.totalProjects}    icon={Film}                          />
            <StatCard label="Videos in Progress" value={stats?.videosInProgress} icon={Clock}        accent="amber"  />
            <StatCard label="Videos Completed"  value={stats?.completed}        icon={CheckCircle2}  accent="green"  />
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
            <div id="activity" className="p-5 rounded-2xl space-y-4" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)", display: activeTab === "activity" ? undefined : "none" }}>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider mb-1" style={{ color: "oklch(0.50 0 0)" }}>Activity — {periodLabel}</p>
                  <div className="flex items-center gap-4">
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: "oklch(0.45 0 0)" }}>
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "#9b7ff5" }} />
                      {totalProjects} niches
                    </span>
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: "oklch(0.45 0 0)" }}>
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "#f59e0b" }} />
                      {totalVideos} videos
                    </span>
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: "oklch(0.45 0 0)" }}>
                      <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "#34d399" }} />
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
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.18" />
                      <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="userGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity="0.15" />
                      <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
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
                  <path d={toPath(videoCoords)} fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  <path d={toPath(userCoords)} fill="none" stroke="#34d399" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

                  {/* Dots */}
                  {projCoords.map((c, i) => (
                    <circle key={i} cx={c.x} cy={c.y} r={hoveredIdx === i ? 4 : 2.5} fill="#9b7ff5" style={{ transition: "r 0.1s" }} />
                  ))}
                  {videoCoords.map((c, i) => (
                    <circle key={i} cx={c.x} cy={c.y} r={hoveredIdx === i ? 4 : 2.5} fill="#f59e0b" style={{ transition: "r 0.1s" }} />
                  ))}
                  {userCoords.map((c, i) => (
                    <circle key={i} cx={c.x} cy={c.y} r={hoveredIdx === i ? 4 : 2.5} fill="#34d399" style={{ transition: "r 0.1s" }} />
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
                          fill="white" stroke="rgba(0,0,0,0.10)" strokeWidth="1" />
                        <text x={TX + TW / 2} y={TY + 15} textAnchor="middle" fontSize="9.5" fill="#333" fontWeight="600">
                          {tooltipDate(pt.date, hoveredIdx)}
                        </text>
                        <circle cx={TX + 13} cy={TY + 30} r="3" fill="#9b7ff5" />
                        <text x={TX + 21} y={TY + 34} fontSize="9" fill="#666">
                          Niches: <tspan fill="#9b7ff5" fontWeight="700">{pt.projects}</tspan>
                        </text>
                        <circle cx={TX + 13} cy={TY + 46} r="3" fill="#f59e0b" />
                        <text x={TX + 21} y={TY + 50} fontSize="9" fill="#666">
                          Videos: <tspan fill="#f59e0b" fontWeight="700">{pt.videos}</tspan>
                        </text>
                        <circle cx={TX + 13} cy={TY + 62} r="3" fill="#34d399" />
                        <text x={TX + 21} y={TY + 66} fontSize="9" fill="#666">
                          Users: <tspan fill="#34d399" fontWeight="700">{pt.users}</tspan>
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

        {/* Users section */}
        <section id="users" className="rounded-2xl space-y-5 max-w-full min-w-0" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "10px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)", display: activeTab === "users" ? undefined : "none" }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "oklch(0.72 0.25 285 / 0.1)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}>
              <UserCog size={16} style={{ color: "oklch(0.72 0.25 285)" }} />
            </div>
            <h2 className="text-lg font-bold text-foreground">Users</h2>
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
              { id: "all",     label: "Total",     value: users.length,          accent: "oklch(0.55 0.15 220)", bg: "oklch(0 0 0 / 0.04)",          color: "var(--c-65)",       border: "oklch(0 0 0 / 0.08)" },
              { id: "admin",   label: "Admin",     value: userBreakdown.admin,   accent: "oklch(0.72 0.18 75)",  bg: "oklch(0.72 0.18 75 / 0.15)",   color: "oklch(0.6 0.18 75)",  border: "oklch(0.72 0.18 75 / 0.4)" },
              { id: "founder", label: "Founder",   value: userBreakdown.founder, accent: "oklch(0.55 0.15 145)", bg: "oklch(0.55 0.15 145 / 0.15)",  color: "oklch(0.65 0.15 145)", border: "oklch(0.55 0.15 145 / 0.3)" },
              { id: "pro",     label: "Pro",       value: userBreakdown.pro,     accent: "oklch(0.55 0.15 145)", bg: "oklch(0.55 0.15 145 / 0.15)",  color: "oklch(0.65 0.15 145)", border: "oklch(0.55 0.15 145 / 0.3)" },
              { id: "starter", label: "Starter",   value: userBreakdown.starter, accent: "oklch(0.55 0.15 145)", bg: "oklch(0.55 0.15 145 / 0.15)",  color: "oklch(0.65 0.15 145)", border: "oklch(0.55 0.15 145 / 0.3)" },
              { id: "free",    label: "Free/Demo", value: userBreakdown.free,    accent: "oklch(0.5 0 0)",       bg: "oklch(0 0 0 / 0.05)",          color: "var(--c-55)",       border: "oklch(0 0 0 / 0.12)" },
              { id: "pending", label: "Pending",   value: userBreakdown.pending, accent: "oklch(0.72 0.25 285)", bg: "oklch(0.72 0.25 285 / 0.1)",   color: "oklch(0.72 0.25 285)", border: "oklch(0.72 0.25 285 / 0.2)" },
            ] as const).map((s) => {
              const isActive = planFilter === s.id;
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
              style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
              <table className="w-full border-collapse min-w-[520px]">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                    {["Email", "Plan", "Niches", "Niches overwrite", "Last Sign-in", ""].map((h) => (
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
                                  className="absolute right-0 top-full mt-1 z-20 rounded-lg overflow-hidden min-w-[160px]"
                                  style={{
                                    background: "white",
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
        <section id="projects" className="rounded-2xl space-y-5 pb-[10px] max-w-full min-w-0" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "10px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)", display: activeTab === "projects" ? undefined : "none" }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "oklch(0.55 0.15 145 / 0.1)", border: "1px solid oklch(0.55 0.15 145 / 0.2)" }}>
              <FolderOpen size={16} style={{ color: "oklch(0.65 0.15 145)" }} />
            </div>
            <h2 className="text-lg font-bold text-foreground">All Videos</h2>
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
          {!selectedCostProject && !selectedGeneralProject && (
            <div className="relative">
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
          )}

          {videosSubTab === "general" && (isLoading ? (
            <SkeletonRows cols={8} />
          ) : selectedGeneralProject ? (
            (() => {
              const p = selectedGeneralProject;
              const isComplete = p.currentState >= 15;
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
                  style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
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
              No videos match &ldquo;{projectSearch}&rdquo;.
            </div>
          ) : (
            <div className="rounded-2xl overflow-x-auto w-full max-w-full"
              style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
              <table className="w-full border-collapse min-w-[640px]">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                    {["User", "Project ID", "Channel", "Topic", "Phase", "Progress", "Assemble Time", "Created", ""].map((h) => (
                      <th key={h} className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider"
                        style={{ color: "var(--c-40)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody key={`projects-p${projectsPage}`}>
                  {pagedProjects.map((p) => {
                    const isComplete = p.currentState >= 15;
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
                  style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
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
                                style={{ color: "black", background: "#ecf0f1" }}>
                                Total
                              </td>
                              {providers.map((prov) => (
                                <td key={prov} className="py-2.5 px-3 text-xs font-mono font-bold tabular-nums"
                                  style={{ color: "black", background: "#ecf0f1" }}>
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
                style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
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
                              background: isTotal ? "#ecf0f1" : isTitle ? "oklch(0.88 0 0)" : undefined,
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
                            style={{ color: "black", background: "#ecf0f1" }}>
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
          const paidUsers = users
            .filter((u) => u.status === "Paid")
            .filter((u) => {
              if (launchedAtMs === null) return true;
              if (!u.paidAt) return false;
              return new Date(u.paidAt).getTime() >= launchedAtMs;
            })
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
            <section id="revenue" className="rounded-2xl space-y-5" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)", display: activeTab === "revenue" ? undefined : "none" }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: "oklch(0.55 0.18 65 / 0.1)", border: "1px solid oklch(0.55 0.18 65 / 0.2)" }}>
                  <DollarSign size={16} style={{ color: "oklch(0.72 0.18 65)" }} />
                </div>
                <h2 className="text-lg font-bold text-foreground">Revenue</h2>
              </div>

              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Paid Users",     value: payingUserCount.toString() },
                  { label: "Total Revenue",  value: `$${totalRevenue.toFixed(2)}` },
                  { label: "Est. MRR",       value: `$${mrr.toFixed(2)}` },
                  { label: "Est. ARR",       value: `$${arr.toFixed(2)}` },
                ].map(({ label, value }) => (
                  <div key={label} className="p-4 rounded-xl text-center space-y-1"
                    style={{ background: "oklch(0.55 0.18 65 / 0.06)", border: "1px solid oklch(0.55 0.18 65 / 0.12)" }}>
                    <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "oklch(0.55 0 0)" }}>{label}</p>
                    <p className="text-2xl font-black" style={{ color: "oklch(0.72 0.18 65)" }}>{value}</p>
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
                        <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.25" />
                        <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
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
                    <path d={toPath(cs)} fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

                    {cs.map((c, i) => (
                      <circle key={i} cx={c.x} cy={c.y} r={hoveredRevIdx === i ? 4 : 2.5} fill="#f59e0b" style={{ transition: "r 0.1s" }} />
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
                            fill="white" stroke="rgba(0,0,0,0.10)" strokeWidth="1" />
                          <text x={TX + TW / 2} y={TY + 15} textAnchor="middle" fontSize="9" fill="#555" fontWeight="600">{label}</text>
                          <circle cx={TX + 14} cy={TY + 32} r="3" fill="#f59e0b" />
                          <text x={TX + 22} y={TY + 36} fontSize="9.5" fill="#666">
                            Revenue: <tspan fill="#f59e0b" fontWeight="700">${pt.revenue.toFixed(2)}</tspan>
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

              {/* Paid users table */}
              {paidUsers.length === 0 ? (
                <p className="text-sm italic py-2" style={{ color: "var(--c-35)" }}>No paid users yet.</p>
              ) : (
                <div className="rounded-2xl overflow-x-auto"
                  style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
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
        {activeTab === "emails" && <EmailsPanel />}

        {/* Support section — in-app HelpButton ticket queue, status
            triage, admin notes. Backed by support_tickets table. */}
        {activeTab === "support" && (
          <section
            id="support"
            className="rounded-2xl max-w-full min-w-0"
            style={{
              background: "white",
              border: "1px solid oklch(0 0 0 / 0.07)",
              padding: "16px",
              scrollMarginTop: "80px",
              boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)",
            }}
          >
            <SupportPanel />
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

      {launchOpen && <LaunchModal onClose={() => setLaunchOpen(false)} />}

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
