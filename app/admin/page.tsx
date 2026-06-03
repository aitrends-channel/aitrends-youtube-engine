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
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import useSWR from "swr";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

const PHASE_PATHS: Record<number, string> = {
  1: "channel", 2: "channel", 3: "channel", 4: "channel", 5: "channel",
  6: "topic", 7: "visuals", 8: "visuals", 9: "prompts", 10: "prompts",
  11: "visuals", 12: "visuals", 13: "prompts", 14: "generate", 15: "assemble",
};

const STATS_KEY = "/api/admin/stats";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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
  const [logTab, setLogTab] = useState<LogSubTab>("activity");
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
  const [setupTab, setSetupTab] = useState<"keys" | "models" | "anthropic">("keys");
  const [serviceInput, setServiceInput] = useState<Service>("youtube_data_api_key");
  const [keyInput, setKeyInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null); // "rowId:index"
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);

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
                            <span className="flex-1 text-sm font-mono truncate" style={{ color: "var(--c-55)", letterSpacing: "0.02em" }}>
                              {maskKey(k)}
                            </span>
                            <button
                              onClick={() => handleRemoveKey(row.id, i)}
                              disabled={removingKey === tag}
                              className="text-xs px-2 py-1 rounded-lg transition-all hover:opacity-80 disabled:opacity-40 cursor-pointer shrink-0 flex items-center gap-1"
                              style={{ background: "oklch(0.6 0.22 25 / 0.08)", color: "oklch(0.7 0.22 25)", border: "1px solid oklch(0.6 0.22 25 / 0.15)" }}>
                              {removingKey === tag ? <Spinner size={11} /> : "✕"}
                            </button>
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

function AnthropicRoutingPanel() {
  type Routing = "client_kie" | "heclus_kie" | "heclus_direct";
  const { data, mutate, isLoading } = useSWR<{ routing: Routing }>("/api/admin/anthropic-routing", fetcher, { revalidateOnFocus: false });

  const [sel, setSel] = useState<Routing>("client_kie");
  const [pending, setPending] = useState<Routing | null>(null);
  const [saving, setSaving] = useState(false);

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    hydratedRef.current = true;
    setSel(data.routing ?? "client_kie");
  }, [data]);

  const options: { id: Routing; title: string; description: string; requires?: string }[] = [
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

  const pendingOption = pending ? options.find((o) => o.id === pending) ?? null : null;

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
        Pick how Claude (Anthropic) calls are routed. Applies to all users globally.
      </p>

      {isLoading && <p className="text-xs" style={{ color: "var(--c-42)" }}>Loading…</p>}

      <div className="space-y-2">
        {options.map((opt) => {
          const active = sel === opt.id;
          const isServerActive = data?.routing === opt.id;
          return (
            <button
              key={opt.id}
              onClick={() => { if (!active) setPending(opt.id); }}
              disabled={saving}
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

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => { if (!open && !saving) setPending(null); }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Switch Anthropic routing?</DialogTitle>
            <DialogDescription>
              This change applies to all users globally and takes effect immediately.
            </DialogDescription>
          </DialogHeader>
          {pendingOption && (
            <div className="rounded-xl p-3" style={{ background: "oklch(0.62 0.15 220 / 0.06)", border: "1px solid oklch(0.62 0.15 220 / 0.25)" }}>
              <p className="text-sm font-semibold" style={{ color: "oklch(0.62 0.15 220)" }}>
                {pendingOption.title}
              </p>
              <p className="text-xs mt-1 leading-relaxed" style={{ color: "var(--c-55)" }}>
                {pendingOption.description}
              </p>
              {pendingOption.requires && (
                <p className="text-[11px] mt-1.5" style={{ color: "oklch(0.6 0.15 60)" }}>
                  ⓘ {pendingOption.requires}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <button
              onClick={() => { if (pending) applyRouting(pending); }}
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
              onClick={() => setPending(null)}
              disabled={saving}
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
    <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-8 py-8 sm:py-12 space-y-6 sm:space-y-10">
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

  useEffect(() => {
    let cancelled = false;
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      if (!data.user || data.user.email !== ADMIN_EMAIL) {
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

  const { data: productKeysRaw, isLoading: keysLoading, mutate: mutateKeys } = useSWR<ProductApiKey[]>(
    authChecked ? "/api/admin/product-keys" : null,
    fetcher
  );
  const productKeys: ProductApiKey[] = Array.isArray(productKeysRaw) ? productKeysRaw : [];

  const { data: founderSpots, mutate: mutateFounderSpots } = useSWR<{ active: boolean; spots_left: number; limit: number }>(
    authChecked ? "/api/founder-spots" : null,
    fetcher,
  );

  const [resettingSlots, setResettingSlots] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  async function confirmResetFounderSlots() {
    if (resettingSlots) return;
    setResettingSlots(true);
    try {
      const res = await fetch("/api/admin/reset-founder-slots", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Reset failed (${res.status})`);
      await mutateFounderSpots();
      toast.success("Founder slots reset");
      setResetConfirmOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setResettingSlots(false);
    }
  }

  const [editLimitOpen, setEditLimitOpen] = useState(false);
  const [limitInput, setLimitInput] = useState("");
  const [savingLimit, setSavingLimit] = useState(false);
  function openEditLimit() {
    setLimitInput(String(founderSpots?.limit ?? ""));
    setEditLimitOpen(true);
  }
  async function confirmSetFounderLimit() {
    if (savingLimit) return;
    const parsed = Number(limitInput);
    if (!Number.isInteger(parsed) || parsed < 0) {
      toast.error("Enter a whole number ≥ 0");
      return;
    }
    setSavingLimit(true);
    try {
      const res = await fetch("/api/admin/founder-limit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: parsed }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Update failed (${res.status})`);
      await mutateFounderSpots();
      toast.success(`Founder cap set to ${parsed}`);
      setEditLimitOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSavingLimit(false);
    }
  }

  const [removing, setRemoving] = useState<string | null>(null);
  const [usersPage, setUsersPage] = useState(1);
  const [projectsPage, setProjectsPage] = useState(1);
  const [activityView, setActivityView] = useState<"daily" | "weekly" | "monthly">("daily");
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [hoveredRevIdx, setHoveredRevIdx] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState("stats");

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
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove user");
    } finally {
      setRemoving(null);
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
  const users = data?.users ?? [];
  const projects = data?.projects ?? [];
  const pagedUsers = users.slice((usersPage - 1) * PER_PAGE, usersPage * PER_PAGE);
  const pagedProjects = projects.slice((projectsPage - 1) * PER_PAGE, projectsPage * PER_PAGE);

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

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-8 py-8 sm:py-12 space-y-6 sm:space-y-10">
        {/* Page heading */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
            <BarChart3 size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Admin Dashboard</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Users, projects, and system overview
            </p>
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
              <button
                type="button"
                onClick={openEditLimit}
                disabled={!founderSpots}
                title="Change the total Founder slot cap"
                className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[10px] font-semibold uppercase tracking-wider transition disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: "oklch(0.97 0.005 240)",
                  border: "1px solid oklch(0.88 0.01 240)",
                  color: "oklch(0.35 0 0)",
                }}
              >
                <Pencil size={10} />
                Edit Limit
              </button>
              <button
                type="button"
                onClick={() => setResetConfirmOpen(true)}
                disabled={!founderSpots}
                title="Reset slot counter to 0 and clear the claims log"
                className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[10px] font-semibold uppercase tracking-wider transition disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: "oklch(0.97 0.005 240)",
                  border: "1px solid oklch(0.88 0.01 240)",
                  color: "oklch(0.35 0 0)",
                }}
              >
                <RotateCcw size={10} />
                Reset Slots
              </button>
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

          <AddUserForm onSuccess={mutate} />

          {isLoading ? (
            <SkeletonRows cols={5} />
          ) : users.length === 0 ? (
            <div className="text-sm py-4 italic" style={{ color: "var(--c-35)" }}>No users yet.</div>
          ) : (
            <div className="rounded-2xl overflow-x-auto w-full max-w-full"
              style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
              <table className="w-full border-collapse min-w-[520px]">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                    {["Email", "Status", "Niches", "Last Sign-in", ""].map((h) => (
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
                        {u.email}
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-xs px-2.5 py-0.5 rounded-full font-medium"
                          style={u.status === "Paid" ? {
                            background: "oklch(0.55 0.18 65 / 0.15)",
                            color: "oklch(0.75 0.18 65)",
                            border: "1px solid oklch(0.55 0.18 65 / 0.3)",
                          } : u.status === "Registered" ? {
                            background: "oklch(0.55 0.15 145 / 0.15)",
                            color: "oklch(0.65 0.15 145)",
                            border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                          } : {
                            background: "oklch(0.72 0.25 285 / 0.1)",
                            color: "oklch(0.72 0.25 285)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.2)",
                          }}>
                          {u.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-sm" style={{ color: "var(--c-60)" }}>
                        {u.projectCount}
                      </td>
                      <td className="py-3 px-4 text-sm" style={{ color: "var(--c-45)" }}>
                        {u.lastSignIn ? timeAgo(u.lastSignIn) : "Never"}
                      </td>
                      <td className="py-3 px-4">
                        {u.email !== ADMIN_EMAIL && (
                          <button
                            onClick={() => handleRemoveUser(u.email)}
                            disabled={removing === u.email}
                            className="text-xs px-2.5 py-1 rounded-lg transition-all hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center gap-1"
                            style={{
                              background: "oklch(0.6 0.22 25 / 0.1)",
                              color: "oklch(0.7 0.22 25)",
                              border: "1px solid oklch(0.6 0.22 25 / 0.2)",
                            }}
                          >
                            {removing === u.email ? <><Spinner size={11} />Removing…</> : "Remove"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={usersPage} total={users.length} onChange={setUsersPage} />
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
          </div>

          {isLoading ? (
            <SkeletonRows cols={7} />
          ) : projects.length === 0 ? (
            <div className="text-sm py-4 italic" style={{ color: "var(--c-35)" }}>No projects yet.</div>
          ) : (
            <div className="rounded-2xl overflow-x-auto w-full max-w-full"
              style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
              <table className="w-full border-collapse min-w-[640px]">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                    {["User", "Channel", "Topic", "Phase", "Progress", "Created", ""].map((h) => (
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
                        style={{ borderBottom: "1px solid var(--bd-4)" }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bd-2)"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                      >
                        <td className="py-3 px-4 text-xs font-mono max-w-[160px] truncate"
                          style={{ color: "var(--c-55)" }}>
                          {p.userEmail}
                        </td>
                        <td className="py-3 px-4 text-sm max-w-[140px] truncate"
                          style={{ color: "var(--c-72)" }}>
                          {p.channelName ?? <span style={{ color: "var(--c-35)" }}>—</span>}
                        </td>
                        <td className="py-3 px-4 text-sm max-w-[200px] truncate"
                          style={{ color: p.selectedTopic ? "var(--c-82)" : "var(--c-35)" }}>
                          {p.selectedTopic ?? "No topic"}
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
                        <td className="py-3 px-4 text-sm" style={{ color: "var(--c-42)" }}>
                          {timeAgo(p.createdAt)}
                        </td>
                        <td className="py-3 px-4">
                          <Link
                            href={`/projects/${p.id}/${PHASE_PATHS[p.currentState] ?? "channel"}`}
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
              <Pagination page={projectsPage} total={projects.length} onChange={setProjectsPage} />
            </div>
          )}
        </section>

        {/* Revenue section */}
        {(() => {
          const PLAN_MRR: Record<string, number> = { founder: 40 / 12, starter: 19, pro: 49 };
          const PLAN_AMOUNT: Record<string, number> = { founder: 40, starter: 19, pro: 49 };
          const PLAN_LABEL: Record<string, string> = { founder: "Founder", starter: "Starter", pro: "Pro" };
          const paidUsers = users.filter((u) => u.status === "Paid");
          const mrr = paidUsers.reduce((sum, u) => sum + (u.plan ? (PLAN_MRR[u.plan] ?? 0) : 0), 0);
          const arr = mrr * 12;

          // Monthly revenue chart data — last 12 months
          const last12 = Array.from({ length: 12 }, (_, i) => {
            const d = new Date();
            d.setUTCDate(1);
            d.setUTCMonth(d.getUTCMonth() - (11 - i));
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
          });
          const revenueByMonth = new Map<string, number>();
          for (const u of paidUsers) {
            if (!u.paidAt) continue;
            const month = new Date(u.paidAt).toISOString().slice(0, 7);
            revenueByMonth.set(month, (revenueByMonth.get(month) ?? 0) + (u.plan ? (PLAN_AMOUNT[u.plan] ?? 0) : 0));
          }
          const chartPts = last12.map(m => ({ month: m, revenue: revenueByMonth.get(m) ?? 0 }));
          const totalRevenue = chartPts.reduce((s, p) => s + p.revenue, 0);

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
                  { label: "Paid Users",     value: paidUsers.length.toString() },
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

        {/* Setup section — product-wide API key management */}
        {activeTab === "setup" && (
          <SetupSection productKeys={productKeys} keysLoading={keysLoading} mutateKeys={mutateKeys} />
        )}
      </main>

      <Dialog
        open={resetConfirmOpen}
        onOpenChange={(open) => { if (!open && !resettingSlots) setResetConfirmOpen(false); }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Reset Founder slots?</DialogTitle>
            <DialogDescription>This will:</DialogDescription>
          </DialogHeader>
          <ul className="space-y-1 pl-5 list-disc text-sm" style={{ color: "var(--c-55)" }}>
            <li>
              Set the counter back to <span className="font-semibold">0 of {founderSpots?.limit ?? 0}</span>
            </li>
            <li>Re-arm the promo so new claims can come in</li>
            <li>Clear the claims log so old payment IDs can be reused for testing</li>
          </ul>
          <DialogFooter>
            <button
              onClick={confirmResetFounderSlots}
              disabled={resettingSlots}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.55 0.15 145)", color: "white" }}
            >
              {resettingSlots ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <Spinner size={14} className="text-white" />
                  Resetting…
                </span>
              ) : "Reset Slots"}
            </button>
            <button
              onClick={() => setResetConfirmOpen(false)}
              disabled={resettingSlots}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editLimitOpen}
        onOpenChange={(open) => { if (!open && !savingLimit) setEditLimitOpen(false); }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Set Founder slot cap</DialogTitle>
            <DialogDescription>
              Total number of Founder spots offered. Already-claimed spots are preserved — only the ceiling changes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
              New cap
            </label>
            <input
              type="number"
              min={0}
              step={1}
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              disabled={savingLimit}
              className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all tabular-nums"
              style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
            />
            <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
              Current cap: <span className="font-semibold tabular-nums">{founderSpots?.limit ?? "—"}</span>
              {" · "}
              Setting below the already-claimed count will mark the promo as ended.
            </p>
          </div>
          <DialogFooter>
            <button
              onClick={confirmSetFounderLimit}
              disabled={savingLimit}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.55 0.15 145)", color: "white" }}
            >
              {savingLimit ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <Spinner size={14} className="text-white" />
                  Saving…
                </span>
              ) : "Save cap"}
            </button>
            <button
              onClick={() => setEditLimitOpen(false)}
              disabled={savingLimit}
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
