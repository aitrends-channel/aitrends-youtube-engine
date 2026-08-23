"use client";

import { useState } from "react";
import useSWR from "swr";
import type { AdminJob } from "@/app/api/admin/jobs/route";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

interface JobsResponse {
  jobs: AdminJob[];
  total: number;
  inFlight: number;
  failed: number;
  held: number;
}

const FILTERS = [
  { id: "flight", label: "In flight" },
  { id: "failed", label: "Failed" },
  { id: "all", label: "All" },
] as const;

/** How long ago, in the shortest form that is still true. */
function age(since: string | null): string {
  if (!since) return "—";
  const ms = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Anything in flight longer than this is not working, it is stuck. The
 *  longest legitimate wait is a video clip, which the worker itself gives up on
 *  at twenty minutes. */
const STUCK_MINUTES = 30;

function isStuck(job: AdminJob): boolean {
  if (!job.inFlight || !job.since) return false;
  return Date.now() - new Date(job.since).getTime() > STUCK_MINUTES * 60_000;
}

const KIND_COLOR: Record<string, string> = {
  image: "oklch(0.55 0.15 240)",
  video: "oklch(0.55 0.18 300)",
  voiceover: "oklch(0.55 0.15 145)",
};

// Every piece of provider work in flight, and what is holding it up.
//
// The question this exists to answer is "the customer says it is stuck, is it".
// So the default filter is in-flight, the sort puts the oldest first, and
// anything waiting longer than a clip could plausibly take is flagged rather
// than left for the reader to work out from a timestamp.
export function JobsPanel() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("flight");
  const { data, isLoading, mutate } = useSWR<JobsResponse>(
    `/api/admin/jobs?filter=${filter}`,
    fetcher,
    { refreshInterval: 20_000, revalidateOnFocus: false },
  );

  const jobs = data?.jobs ?? [];
  const stuck = jobs.filter(isStuck).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1 p-1 rounded-xl" style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.09)" }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer"
              style={filter === f.id
                ? { background: "var(--bg-card)", color: "oklch(0.62 0.15 220)", boxShadow: "0 1px 3px oklch(0 0 0 / 0.06)" }
                : { background: "transparent", color: "var(--c-50)" }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => mutate()}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
          style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
        >
          Refresh
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="In flight" value={data?.inFlight ?? 0} />
        <Stat label="Stuck over 30m" value={stuck} alarm={stuck > 0} />
        <Stat label="Failed" value={data?.failed ?? 0} alarm={(data?.failed ?? 0) > 0} />
        <Stat label="Credits held" value={Number((data?.held ?? 0).toFixed(2))} />
      </div>

      <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--input)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "oklch(0 0 0 / 0.03)", color: "var(--c-45)" }}>
                <th className="text-left font-medium py-2 px-3">Kind</th>
                <th className="text-left font-medium py-2 px-3">Status</th>
                <th className="text-left font-medium py-2 px-3">Model</th>
                <th className="text-left font-medium py-2 px-3">Who</th>
                <th className="text-left font-medium py-2 px-3">Beat</th>
                <th className="text-right font-medium py-2 px-3">Held</th>
                <th className="text-right font-medium py-2 px-3">Age</th>
                <th className="text-left font-medium py-2 px-3">Task / error</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={8} className="py-6 px-3 text-center" style={{ color: "var(--c-45)" }}>Loading…</td></tr>
              )}
              {!isLoading && jobs.length === 0 && (
                <tr><td colSpan={8} className="py-6 px-3 text-center" style={{ color: "var(--c-45)" }}>
                  {filter === "flight" ? "Nothing in flight." : filter === "failed" ? "Nothing failed." : "No jobs."}
                </td></tr>
              )}
              {jobs.map((j) => (
                <tr key={`${j.kind}-${j.projectId}-${j.beatNumber}`} style={{ borderTop: "1px solid oklch(0 0 0 / 0.06)" }}>
                  <td className="py-2 px-3">
                    <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide"
                      style={{ background: `${KIND_COLOR[j.kind]}20`, color: KIND_COLOR[j.kind] }}>
                      {j.kind}
                    </span>
                  </td>
                  <td className="py-2 px-3" style={{ color: j.status === "failed" ? "oklch(0.6 0.22 25)" : "var(--c-70)" }}>
                    {j.status || "—"}
                    {isStuck(j) && (
                      <span className="ml-1.5 text-[11px] font-semibold" style={{ color: "oklch(0.62 0.18 45)" }}>stuck</span>
                    )}
                  </td>
                  <td className="py-2 px-3 font-mono text-xs" style={{ color: "var(--c-55)" }}>
                    {j.model ?? "—"}
                    {j.operator && <span style={{ color: "var(--c-35)" }}> · {j.operator}</span>}
                  </td>
                  <td className="py-2 px-3" style={{ color: "var(--c-55)" }}>{j.email ?? j.userId.slice(0, 8)}</td>
                  <td className="py-2 px-3 tabular-nums" style={{ color: "var(--c-45)" }}>#{j.beatNumber}</td>
                  <td className="py-2 px-3 text-right tabular-nums"
                    style={{ color: j.heldCredits ? "oklch(0.62 0.18 45)" : "var(--c-35)", fontWeight: j.heldCredits ? 600 : 400 }}>
                    {j.heldCredits ? j.heldCredits.toFixed(2) : "—"}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums"
                    style={{ color: isStuck(j) ? "oklch(0.62 0.18 45)" : "var(--c-45)" }}>
                    {age(j.since)}
                  </td>
                  <td className="py-2 px-3 text-xs" style={{ color: j.error ? "oklch(0.6 0.22 25)" : "var(--c-40)" }}>
                    <span className="font-mono">{j.error ? j.error.slice(0, 90) : j.taskId ?? "—"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-sm" style={{ color: "var(--c-42)" }}>
        Age comes from the credit hold where there is one, and from the project's last update where there is not,
        because beats carry no timestamps of their own. A held figure means credits are reserved against that beat
        and something still has to answer for them.
      </p>
    </div>
  );
}

function Stat({ label, value, alarm }: { label: string; value: number; alarm?: boolean }) {
  return (
    <div className="p-3 rounded-xl" style={{ background: "oklch(0 0 0 / 0.015)", border: "1px solid var(--input)" }}>
      <p className="text-sm" style={{ color: "var(--c-45)" }}>{label}</p>
      <p className="text-xl font-bold tabular-nums leading-tight"
        style={{ color: alarm ? "oklch(0.62 0.18 45)" : "var(--c-90)" }}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}
