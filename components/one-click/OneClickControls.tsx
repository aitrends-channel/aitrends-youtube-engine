"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Zap, Pause, Play, Square } from "lucide-react";

// Live-run controls for a 1Click project: a status badge plus
// Pause/Resume and Stop. Rendered on the dashboard card for any
// project with auto_pilot on. Stop disengages autopilot entirely
// (the project stays put and the normal wizard takes over); Pause
// just parks it so the tick loop skips it until Resume.
export function OneClickControls({ projectId, status, error, onChanged }: {
  projectId: string;
  status: string | null; // running | paused | needs_attention | completed | stopped
  error: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function pauseResume(action: "pause" | "resume") {
    setBusy(true);
    try {
      const res = await fetch("/api/one-click/start", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, action }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `Request failed (${res.status})`);
      toast.success(action === "pause" ? "1Click paused" : "1Click resumed");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      const res = await fetch(`/api/one-click/start?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `Stop failed (${res.status})`);
      toast.success("1Click stopped — you can finish this video yourself anytime");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stop failed");
    } finally {
      setBusy(false);
    }
  }

  const badge = (() => {
    switch (status) {
      case "running":         return { label: "1Click running", bg: "oklch(0.72 0.25 285 / 0.12)", fg: "oklch(0.72 0.25 285)", bd: "oklch(0.72 0.25 285 / 0.3)", spin: true };
      case "paused":          return { label: "1Click paused",  bg: "oklch(0.72 0.18 65 / 0.12)",  fg: "oklch(0.7 0.16 65)",   bd: "oklch(0.72 0.18 65 / 0.3)",  spin: false };
      case "needs_attention": return { label: "Needs attention", bg: "oklch(0.6 0.19 25 / 0.1)",   fg: "oklch(0.6 0.19 25)",   bd: "oklch(0.6 0.19 25 / 0.3)",   spin: false };
      default:                return null; // completed / stopped → no controls
    }
  })();
  if (!badge) return null;

  const iconBtn = (onClick: () => void, title: string, node: React.ReactNode, danger = false) => (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      disabled={busy}
      title={title}
      className="w-7 h-7 rounded-lg flex items-center justify-center transition-opacity hover:opacity-90 disabled:opacity-40 cursor-pointer"
      style={{
        background: danger ? "transparent" : "oklch(0.72 0.25 285 / 0.12)",
        border: `1px solid ${danger ? "oklch(0.6 0.22 25 / 0.4)" : "oklch(0.72 0.25 285 / 0.3)"}`,
        color: danger ? "oklch(0.7 0.22 25)" : "oklch(0.72 0.25 285)",
      }}
    >
      {node}
    </button>
  );

  return (
    <div className="flex items-center gap-2 flex-wrap" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium"
        style={{ background: badge.bg, color: badge.fg, border: `1px solid ${badge.bd}` }}>
        {badge.spin
          ? <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
          : <Zap size={12} />}
        {badge.label}
      </span>
      {status !== "needs_attention" && (
        status === "paused"
          ? iconBtn(() => pauseResume("resume"), "Resume 1Click", <Play size={13} />)
          : iconBtn(() => pauseResume("pause"), "Pause 1Click", <Pause size={13} />)
      )}
      {iconBtn(stop, "Stop 1Click (finish manually)", <Square size={12} />, true)}
      {status === "needs_attention" && error && (
        <span className="text-[11px] w-full" style={{ color: "oklch(0.6 0.19 25)" }}>{error}</span>
      )}
    </div>
  );
}
