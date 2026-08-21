"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";

interface StageMetric {
  stage: string;
  rss_mb: number;
  heap_mb: number;
  t_ms: number;
}

interface AssemblyMetrics {
  peak_rss_mb: number;
  stages: StageMetric[];
}

interface MetricRow {
  id: string;
  channel_name: string | null;
  assembly_status: string | null;
  assembly_started_at: string | null;
  assembly_finished_at: string | null;
  assembly_metrics: AssemblyMetrics;
  duration_ms: number | null;
}

interface StageAgg {
  stage: string;
  avg_rss_mb: number;
  max_rss_mb: number;
  avg_t_ms: number;
  count: number;
}

interface Response {
  rows: MetricRow[];
  summary: { sampleSize: number; peakRssMaxMb: number; peakRssAvgMb: number };
  stageAgg: StageAgg[];
}

const fetcher = (url: string) => fetch(url).then((r) => r.ok ? r.json() : Promise.reject(r.status));

const fmtMb = (n: number) => `${n.toLocaleString()} MB`;
const fmtMs = (ms: number) => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
const fmtTime = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

const STATUS_COLORS: Record<string, string> = {
  done: "oklch(0.55 0.18 145)",
  failed: "oklch(0.6 0.2 25)",
  stopped: "oklch(0.65 0.1 60)",
};

// RSS bar fill — color shifts from green to red as we approach the
// Render free tier ceiling (512 MB on starter). Above 90% the bar
// goes solid red so the worst offenders jump out.
function rssBarColor(rssMb: number, ceiling: number): string {
  const pct = Math.min(1, rssMb / ceiling);
  if (pct >= 0.9) return "oklch(0.6 0.2 25)";
  if (pct >= 0.7) return "oklch(0.7 0.18 60)";
  return "oklch(0.6 0.15 145)";
}

export function MemoryPanel() {
  const [statusFilter, setStatusFilter] = useState<"all" | "done" | "failed" | "stopped">("all");
  // Render starter (free) = 512 MB; paid web service = 2 GB. Configurable
  // so the admin can re-anchor the bar colors after a plan upgrade.
  const [ceiling, setCeiling] = useState(512);

  const qs = new URLSearchParams({ limit: "100" });
  if (statusFilter !== "all") qs.set("status", statusFilter);
  const { data, isLoading } = useSWR<Response>(
    `/api/admin/assembly-metrics?${qs.toString()}`,
    fetcher,
    { revalidateOnFocus: false },
  );

  return (
    <section
      className="rounded-2xl space-y-5 max-w-full min-w-0"
      style={{
        background: "white",
        border: "1px solid oklch(0 0 0 / 0.10)",
        padding: "16px",
        scrollMarginTop: "80px",
        boxShadow: "0 4px 24px oklch(0 0 0 / 0.07), 0 1px 4px oklch(0 0 0 / 0.05)",
      }}
    >
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Memory + timing</p>
          <p className="text-sm" style={{ color: "var(--c-50)" }}>Per-stage RSS and wall-clock from recent video-worker assemblies</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs" style={{ color: "var(--c-50)" }}>
            Status
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="ml-1 px-2 py-1 rounded text-xs"
              style={{ background: "oklch(0.97 0 0)", border: "1px solid oklch(0 0 0 / 0.1)" }}
            >
              <option value="all">All</option>
              <option value="done">Done</option>
              <option value="failed">Failed</option>
              <option value="stopped">Stopped</option>
            </select>
          </label>
          <label className="text-xs" style={{ color: "var(--c-50)" }}>
            Ceiling
            <input
              type="number"
              min={128}
              step={64}
              value={ceiling}
              onChange={(e) => setCeiling(Math.max(128, Number(e.target.value) || 512))}
              className="ml-1 px-2 py-1 rounded text-xs w-20"
              style={{ background: "oklch(0.97 0 0)", border: "1px solid oklch(0 0 0 / 0.1)" }}
            />
            <span className="ml-1">MB</span>
          </label>
        </div>
      </div>

      {isLoading && <p className="text-xs" style={{ color: "var(--c-50)" }}>Loading…</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Sample size" value={data.summary.sampleSize.toLocaleString()} />
            <Stat label="Avg peak RSS" value={fmtMb(data.summary.peakRssAvgMb)} />
            <Stat label="Max peak RSS" value={fmtMb(data.summary.peakRssMaxMb)} />
            <Stat
              label="Headroom @ ceiling"
              value={fmtMb(Math.max(0, ceiling - data.summary.peakRssMaxMb))}
              hint={`Ceiling: ${ceiling} MB`}
            />
          </div>

          {data.stageAgg.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Stage averages (worst → best)</p>
              <div className="space-y-1.5">
                {data.stageAgg.map((s) => (
                  <div key={s.stage} className="flex items-center gap-3 text-xs">
                    <span className="shrink-0" style={{ minWidth: 140, color: "var(--c-78)" }}>{s.stage}</span>
                    <div className="flex-1 h-5 rounded overflow-hidden relative" style={{ background: "oklch(0 0 0 / 0.05)" }}>
                      <div
                        className="h-full transition-all"
                        style={{
                          width: `${Math.min(100, (s.avg_rss_mb / ceiling) * 100)}%`,
                          background: rssBarColor(s.avg_rss_mb, ceiling),
                        }}
                      />
                      <span className="absolute inset-0 flex items-center px-2 tabular-nums" style={{ color: "var(--c-90)" }}>
                        {fmtMb(s.avg_rss_mb)} avg · {fmtMb(s.max_rss_mb)} max · {fmtMs(s.avg_t_ms)} · n={s.count}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.rows.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--c-50)" }}>
              No assemblies with metrics yet. Run an assembly on the latest video-worker build to populate this table.
            </p>
          ) : (
            <div>
              <p className="text-xs uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Recent assemblies</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ color: "var(--c-50)", borderBottom: "1px solid oklch(0 0 0 / 0.11)" }}>
                      <th className="text-left py-2 pr-3 font-medium">When</th>
                      <th className="text-left py-2 pr-3 font-medium">Channel</th>
                      <th className="text-left py-2 pr-3 font-medium">Status</th>
                      <th className="text-left py-2 pr-3 font-medium">Peak RSS</th>
                      <th className="text-left py-2 pr-3 font-medium">Duration</th>
                      <th className="text-left py-2 pr-3 font-medium">Stages</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <RowItem key={r.id} row={r} ceiling={ceiling} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RowItem({ row, ceiling }: { row: MetricRow; ceiling: number }) {
  const [expanded, setExpanded] = useState(false);
  const peakColor = rssBarColor(row.assembly_metrics.peak_rss_mb, ceiling);
  const heaviestStage = [...row.assembly_metrics.stages].sort((a, b) => b.rss_mb - a.rss_mb)[0];
  return (
    <>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className="cursor-pointer hover:bg-black/[0.02]"
        style={{ borderBottom: "1px solid oklch(0 0 0 / 0.10)" }}
      >
        <td className="py-2 pr-3 tabular-nums" style={{ color: "var(--c-78)" }}>
          {fmtTime(row.assembly_finished_at ?? row.assembly_started_at)}
        </td>
        <td className="py-2 pr-3" style={{ color: "var(--c-78)" }}>
          <Link
            href={`/admin?project=${row.id}`}
            onClick={(e) => e.stopPropagation()}
            className="hover:underline"
          >
            {row.channel_name ?? row.id.slice(0, 8)}
          </Link>
        </td>
        <td className="py-2 pr-3">
          <span
            className="px-1.5 py-0.5 rounded text-xs font-medium"
            style={{
              background: `${STATUS_COLORS[row.assembly_status ?? ""] ?? "oklch(0.6 0 0)"} / 0.12`,
              color: STATUS_COLORS[row.assembly_status ?? ""] ?? "oklch(0.6 0 0)",
            }}
          >
            {row.assembly_status ?? "—"}
          </span>
        </td>
        <td className="py-2 pr-3 tabular-nums font-semibold" style={{ color: peakColor }}>
          {fmtMb(row.assembly_metrics.peak_rss_mb)}
        </td>
        <td className="py-2 pr-3 tabular-nums" style={{ color: "var(--c-78)" }}>
          {row.duration_ms !== null ? fmtMs(row.duration_ms) : "—"}
        </td>
        <td className="py-2 pr-3" style={{ color: "var(--c-50)" }}>
          {row.assembly_metrics.stages.length} {heaviestStage ? `· heaviest: ${heaviestStage.stage}` : ""}
        </td>
      </tr>
      {expanded && (
        <tr style={{ borderBottom: "1px solid oklch(0 0 0 / 0.10)" }}>
          <td colSpan={6} className="py-2 pr-3" style={{ background: "oklch(0 0 0 / 0.02)" }}>
            <div className="space-y-1 px-2">
              {row.assembly_metrics.stages.map((s, i) => (
                <div key={`${s.stage}-${i}`} className="flex items-center gap-3">
                  <span className="shrink-0" style={{ minWidth: 140, color: "var(--c-78)" }}>{s.stage}</span>
                  <div className="flex-1 h-4 rounded overflow-hidden relative" style={{ background: "oklch(0 0 0 / 0.05)" }}>
                    <div
                      className="h-full"
                      style={{
                        width: `${Math.min(100, (s.rss_mb / ceiling) * 100)}%`,
                        background: rssBarColor(s.rss_mb, ceiling),
                      }}
                    />
                    <span className="absolute inset-0 flex items-center px-2 tabular-nums" style={{ color: "var(--c-90)", fontSize: 10 }}>
                      RSS {fmtMb(s.rss_mb)} · heap {fmtMb(s.heap_mb)} · {fmtMs(s.t_ms)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: "oklch(0.97 0 0 / 0.8)" }}>
      <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-40)" }}>{label}</p>
      <p className="text-base font-semibold" style={{ color: "var(--c-90)" }}>{value}</p>
      {hint && <p className="text-xs" style={{ color: "var(--c-50)" }}>{hint}</p>}
    </div>
  );
}
