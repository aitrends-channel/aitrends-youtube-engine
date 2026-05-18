"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import {
  ArrowLeft, LogOut, BarChart3, Users, UserCheck, FolderOpen,
  CheckCircle2, UserCog, UserPlus,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import useSWR from "swr";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { ThemeToggle } from "@/components/ThemeToggle";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

const PHASE_PATHS: Record<number, string> = {
  1: "channel", 2: "channel", 3: "channel", 4: "channel", 5: "channel",
  6: "topic", 7: "visuals", 8: "visuals", 9: "prompts", 10: "prompts",
  11: "visuals", 12: "visuals", 13: "prompts", 14: "generate", 15: "assemble",
};

const STATS_KEY = "/api/admin/stats";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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
}

interface AdminUser {
  email: string;
  status: "Registered" | "Pending" | "Paid";
  projectCount: number;
  lastSignIn: string | null;
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

interface AdminStatsResponse {
  stats: AdminStats;
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
  accent?: "purple" | "green";
}) {
  const valueColor = accent === "purple"
    ? "oklch(0.72 0.25 285)"
    : accent === "green"
    ? "oklch(0.65 0.15 145)"
    : "var(--c-90)";
  const iconBg = accent === "purple"
    ? "oklch(0.72 0.25 285 / 0.12)"
    : accent === "green"
    ? "oklch(0.55 0.15 145 / 0.12)"
    : "var(--bd-6)";
  const iconBorder = accent === "purple"
    ? "oklch(0.72 0.25 285 / 0.25)"
    : accent === "green"
    ? "oklch(0.55 0.15 145 / 0.25)"
    : "var(--bd-10)";
  const iconColor = accent === "purple"
    ? "oklch(0.72 0.25 285)"
    : accent === "green"
    ? "oklch(0.65 0.15 145)"
    : "var(--c-55)";

  return (
    <div className="p-6 rounded-2xl space-y-4"
      style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}>
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
      style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}>
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
          style={{ background: "oklch(0.55 0.15 145)", color: "oklch(0.08 0 0)" }}
        >
          <UserPlus size={14} />
          {adding ? "Adding…" : "Grant Access"}
        </button>
      </div>
    </form>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user || data.user.email !== ADMIN_EMAIL) {
        router.push("/");
      } else {
        setAuthChecked(true);
      }
    });
  }, [router]);

  const { data, isLoading, mutate } = useSWR<AdminStatsResponse>(
    authChecked ? STATS_KEY : null,
    fetcher
  );

  const [removing, setRemoving] = useState<string | null>(null);

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
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-page)" }}>
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon.png" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
            <span className="text-sm tracking-tight ml-1" style={{ color: "var(--c-50)" }}>Admin</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80 cursor-pointer"
            style={{ background: "var(--bg-control)", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
          >
            <LogOut size={15} />
            <span>Sign Out</span>
          </button>
          <ThemeToggle />
          <Link
            href="/"
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80"
            style={{ background: "var(--bg-control)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
          >
            <ArrowLeft size={14} />
            Back to Home
          </Link>
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

        {/* Stats cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Access Granted" value={stats?.accessGranted} icon={Users} accent="purple" />
          <StatCard label="Active Accounts" value={stats?.activeAccounts} icon={UserCheck} />
          <StatCard label="Total Projects" value={stats?.totalProjects} icon={FolderOpen} />
          <StatCard label="Completed" value={stats?.completed} icon={CheckCircle2} accent="green" />
        </div>

        {/* Users section */}
        <section className="space-y-5">
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
              style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}>
              <table className="w-full border-collapse">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                    {["Email", "Status", "Projects", "Last Sign-in", ""].map((h) => (
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
        <section className="space-y-5 pb-12">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "oklch(0.55 0.15 145 / 0.1)", border: "1px solid oklch(0.55 0.15 145 / 0.2)" }}>
              <FolderOpen size={16} style={{ color: "oklch(0.65 0.15 145)" }} />
            </div>
            <h2 className="text-lg font-bold text-foreground">All Projects</h2>
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
              style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}>
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
      </main>
    </div>
  );
}
