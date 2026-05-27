"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import {
  ArrowLeft, LogOut, BarChart3, Users, UserCheck, FolderOpen,
  CheckCircle2, UserCog, UserPlus, Settings, TrendingUp, Clapperboard, Film, Clock,
  DollarSign, SlidersHorizontal,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
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

interface YouTubeKey {
  id: string;
  label: string | null;
  key: string;
  active: boolean;
  created_at: string;
}

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
    <form onSubmit={handleSubmit} className="p-5 rounded-2xl space-y-3"
      style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
      <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Email address</label>
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="user@example.com"
          className="flex-1 px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
          style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
        />
        <button
          type="submit"
          disabled={adding}
          className="px-4 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center gap-2"
          style={{ background: "oklch(0.52 0.20 145)", color: "white" }}
        >
          <UserPlus size={14} />
          {adding ? "Adding…" : "Grant Access"}
        </button>
      </div>
    </form>
  );
}

function SetupSection({
  ytKeys,
  keysLoading,
  mutateKeys,
}: {
  ytKeys: YouTubeKey[];
  keysLoading: boolean;
  mutateKeys: () => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await fetch("/api/admin/youtube-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: keyInput, label: labelInput }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Failed to add key");
      toast.success("API key added");
      setKeyInput("");
      setLabelInput("");
      mutateKeys();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add key");
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(k: YouTubeKey) {
    setTogglingId(k.id);
    try {
      const res = await fetch(`/api/admin/youtube-keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !k.active }),
      });
      if (!res.ok) throw new Error("Failed to update");
      mutateKeys();
    } catch {
      toast.error("Failed to update key");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleRemove(id: string) {
    setRemovingId(id);
    try {
      const res = await fetch(`/api/admin/youtube-keys/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove");
      toast.success("API key removed");
      mutateKeys();
    } catch {
      toast.error("Failed to remove key");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <section id="setup" className="rounded-2xl space-y-5" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.55 0.15 220 / 0.1)", border: "1px solid oklch(0.55 0.15 220 / 0.2)" }}>
          <SlidersHorizontal size={16} style={{ color: "oklch(0.62 0.15 220)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Setup</h2>
          <p className="text-xs" style={{ color: "var(--c-42)" }}>YouTube Data API keys used to serve all customers</p>
        </div>
        <span className="ml-auto text-xs px-2.5 py-0.5 rounded-full"
          style={{ background: "var(--bg-elevated)", border: "1px solid oklch(1 0 0 / 0.06)", color: "var(--c-42)" }}>
          {ytKeys.length} key{ytKeys.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Add key form */}
      <form onSubmit={handleAdd} className="p-4 rounded-2xl space-y-3"
        style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid oklch(0 0 0 / 0.07)" }}>
        <p className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Add API Key</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            placeholder="Label (optional)"
            className="w-36 px-3 py-2.5 rounded-lg text-sm outline-none transition-all shrink-0"
            style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.62 0.15 220 / 0.5)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
          />
          <input
            type="text"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            required
            placeholder="AIzaSy…"
            className="flex-1 px-3 py-2.5 rounded-lg text-sm outline-none transition-all font-mono"
            style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.62 0.15 220 / 0.5)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
          />
          <button
            type="submit"
            disabled={adding}
            className="px-4 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer flex items-center gap-2 shrink-0"
            style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
          >
            <UserPlus size={14} />
            {adding ? "Adding…" : "Add Key"}
          </button>
        </div>
      </form>

      {/* Keys list */}
      {keysLoading ? (
        <div className="flex items-center gap-2 py-4" style={{ color: "var(--c-40)" }}>
          <Spinner size={14} />
          <span className="text-sm">Loading keys…</span>
        </div>
      ) : ytKeys.length === 0 ? (
        <p className="text-sm italic py-2" style={{ color: "var(--c-35)" }}>No API keys configured yet.</p>
      ) : (
        <div className="rounded-2xl overflow-hidden"
          style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
          <table className="w-full border-collapse">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                {["Label", "Key", "Status", "Added", ""].map((h) => (
                  <th key={h} className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider" style={{ color: "var(--c-40)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ytKeys.map((k) => (
                <tr key={k.id} style={{ borderBottom: "1px solid var(--bd-4)" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bd-2)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                  <td className="py-3 px-4 text-sm" style={{ color: "var(--c-65)" }}>
                    {k.label ?? <span style={{ color: "var(--c-35)" }}>—</span>}
                  </td>
                  <td className="py-3 px-4 text-sm font-mono" style={{ color: "var(--c-55)", letterSpacing: "0.02em" }}>
                    {maskKey(k.key)}
                  </td>
                  <td className="py-3 px-4">
                    <button
                      onClick={() => handleToggle(k)}
                      disabled={togglingId === k.id}
                      className="text-xs px-2.5 py-0.5 rounded-full font-medium transition-all hover:opacity-80 cursor-pointer disabled:opacity-50"
                      style={k.active ? {
                        background: "oklch(0.55 0.15 145 / 0.15)",
                        color: "oklch(0.65 0.15 145)",
                        border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                      } : {
                        background: "oklch(0.6 0.22 25 / 0.1)",
                        color: "oklch(0.65 0.22 25)",
                        border: "1px solid oklch(0.6 0.22 25 / 0.2)",
                      }}
                    >
                      {togglingId === k.id ? "…" : k.active ? "Active" : "Disabled"}
                    </button>
                  </td>
                  <td className="py-3 px-4 text-sm" style={{ color: "var(--c-42)" }}>
                    {new Date(k.created_at).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}
                  </td>
                  <td className="py-3 px-4">
                    <button
                      onClick={() => handleRemove(k.id)}
                      disabled={removingId === k.id}
                      className="text-xs px-2.5 py-1 rounded-lg transition-all hover:opacity-80 disabled:opacity-40 cursor-pointer flex items-center gap-1"
                      style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.22 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}
                    >
                      {removingId === k.id ? <><Spinner size={11} />Removing…</> : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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

  const { data: ytKeysRaw, isLoading: keysLoading, mutate: mutateKeys } = useSWR<YouTubeKey[]>(
    authChecked ? "/api/admin/youtube-keys" : null,
    fetcher
  );
  const ytKeys: YouTubeKey[] = Array.isArray(ytKeysRaw) ? ytKeysRaw : [];

  const [removing, setRemoving] = useState<string | null>(null);
  const [activityView, setActivityView] = useState<"daily" | "weekly" | "monthly">("daily");
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [hoveredRevIdx, setHoveredRevIdx] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState("stats");
  const [tabsFixed, setTabsFixed] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(64);

  useEffect(() => {
    if (!authChecked) return;
    if (headerRef.current) setHeaderHeight(headerRef.current.offsetHeight);
    const tabs = tabsRef.current;
    if (!tabs) return;
    const observer = new IntersectionObserver(
      ([entry]) => setTabsFixed(!entry.isIntersecting),
      { threshold: 0 }
    );
    observer.observe(tabs);
    return () => observer.disconnect();
  }, [authChecked]);

  function scrollTo(id: string) {
    setActiveTab(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

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
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove user");
    } finally {
      setRemoving(null);
    }
  }

  if (!authChecked) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-page)" }}>
      <Spinner size={28} className="text-purple-400" />
    </div>
  );

  const stats = data?.stats;
  const users = data?.users ?? [];
  const projects = data?.projects ?? [];

  return (
    <div className="min-h-screen flex flex-col" data-theme="light" style={{ background: "var(--bg-page)" }}>
      {/* Header */}
      <header ref={headerRef} className="flex items-center justify-between px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
            <span className="text-sm tracking-tight ml-1" style={{ color: "var(--c-50)" }}>Admin</span>
          </div>
        </div>
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

      <main className="flex-1 w-full max-w-6xl mx-auto px-8 py-12 space-y-10">
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
            { id: "setup",    label: "Setup",    icon: SlidersHorizontal },
          ] as const;

          const tabButtons = (TAB_ITEMS).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => scrollTo(id)}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all cursor-pointer"
              style={activeTab === id
                ? { background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.35)" }
                : { color: "oklch(0.50 0 0)" }}
            >
              <Icon size={14} />
              {label}
            </button>
          ));

          return (
            <>
              <div
                ref={tabsRef}
                className="flex items-center gap-1 p-1 rounded-xl w-full"
                style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)" }}
              >
                {tabButtons}
              </div>

              {/* Fixed clone — only shown when original is scrolled out of view */}
              {tabsFixed && (
                <div
                  className="flex items-center gap-1 p-1 rounded-xl"
                  style={{
                    position: "fixed",
                    top: headerHeight + 8,
                    left: 32,
                    right: 32,
                    zIndex: 9999,
                    background: "white",
                    border: "1px solid oklch(0 0 0 / 0.07)",
                    boxShadow: "0 8px 32px oklch(0 0 0 / 0.18), 0 2px 8px oklch(0 0 0 / 0.10)",
                    borderRadius: "12px",
                  }}
                >
                  {tabButtons}
                </div>
              )}
            </>
          );
        })()}

        {/* Stats cards */}
        <div id="stats" className="rounded-2xl space-y-3" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "oklch(0.50 0 0)" }}>Stats</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-[10px]">
            <StatCard label="Access Granted"    value={stats?.accessGranted}    icon={Users}         accent="purple" />
            <StatCard label="Active Accounts"   value={stats?.activeAccounts}   icon={UserCheck}                     />
            <StatCard label="Total Niches"      value={stats?.totalProjects}    icon={FolderOpen}                    />
            <StatCard label="Total Videos"      value={stats?.totalProjects}    icon={Film}                          />
            <StatCard label="Videos in Progress" value={stats?.videosInProgress} icon={Clock}        accent="amber"  />
            <StatCard label="Videos Completed"  value={stats?.completed}        icon={CheckCircle2}  accent="green"  />
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
            <div id="activity" className="p-5 rounded-2xl space-y-4" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
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
        <section id="users" className="rounded-2xl space-y-5" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "10px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
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
            <div className="flex items-center gap-2 py-4" style={{ color: "var(--c-40)" }}>
              <Spinner size={14} />
              <span className="text-sm">Loading users…</span>
            </div>
          ) : users.length === 0 ? (
            <div className="text-sm py-4 italic" style={{ color: "var(--c-35)" }}>No users yet.</div>
          ) : (
            <div className="rounded-2xl overflow-hidden"
              style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
              <table className="w-full border-collapse">
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
                <tbody>
                  {users.map((u) => (
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
            </div>
          )}
        </section>

        {/* Projects section */}
        <section id="projects" className="rounded-2xl space-y-5 pb-[10px]" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "10px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
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
            <div className="flex items-center gap-2 py-4" style={{ color: "var(--c-40)" }}>
              <Spinner size={14} />
              <span className="text-sm">Loading projects…</span>
            </div>
          ) : projects.length === 0 ? (
            <div className="text-sm py-4 italic" style={{ color: "var(--c-35)" }}>No projects yet.</div>
          ) : (
            <div className="rounded-2xl overflow-hidden"
              style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
              <table className="w-full border-collapse">
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
                <tbody>
                  {projects.map((p) => {
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
            <section id="revenue" className="rounded-2xl space-y-5" style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", padding: "16px", scrollMarginTop: "80px", boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)" }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: "oklch(0.55 0.18 65 / 0.1)", border: "1px solid oklch(0.55 0.18 65 / 0.2)" }}>
                  <DollarSign size={16} style={{ color: "oklch(0.72 0.18 65)" }} />
                </div>
                <h2 className="text-lg font-bold text-foreground">Revenue</h2>
              </div>

              {/* Summary cards */}
              <div className="grid grid-cols-4 gap-3">
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
                <div className="rounded-2xl overflow-hidden"
                  style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
                  <table className="w-full border-collapse">
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

        {/* Setup section — YouTube Data API key management */}
        <SetupSection ytKeys={ytKeys} keysLoading={keysLoading} mutateKeys={mutateKeys} />
      </main>
    </div>
  );
}
