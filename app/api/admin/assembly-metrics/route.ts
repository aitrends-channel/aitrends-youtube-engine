import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

// Surfaces the per-stage memory + timing data the video-worker writes
// into projects.assembly_metrics on every terminal transition (done,
// stopped, failed). Used by the admin Memory tab to tell where memory
// peaked and how long each stage took across recent runs — replaces
// the old "tail the worker logs and guess" workflow.

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

export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
  const statusFilter = url.searchParams.get("status"); // "done" | "failed" | "stopped" | null

  let query = supabase
    .from("projects")
    .select("id, channel_name, assembly_status, assembly_started_at, assembly_finished_at, assembly_metrics")
    .not("assembly_metrics", "is", null)
    .order("assembly_finished_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (statusFilter && ["done", "failed", "stopped"].includes(statusFilter)) {
    query = query.eq("assembly_status", statusFilter);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows: MetricRow[] = (data ?? [])
    .map((r) => {
      const metrics = r.assembly_metrics as AssemblyMetrics | null;
      if (!metrics || typeof metrics.peak_rss_mb !== "number") return null;
      const started = r.assembly_started_at ? new Date(r.assembly_started_at).getTime() : null;
      const finished = r.assembly_finished_at ? new Date(r.assembly_finished_at).getTime() : null;
      const duration_ms = started !== null && finished !== null ? finished - started : null;
      return {
        id: r.id as string,
        channel_name: (r.channel_name as string | null) ?? null,
        assembly_status: (r.assembly_status as string | null) ?? null,
        assembly_started_at: (r.assembly_started_at as string | null) ?? null,
        assembly_finished_at: (r.assembly_finished_at as string | null) ?? null,
        assembly_metrics: metrics,
        duration_ms,
      } satisfies MetricRow;
    })
    .filter((r): r is MetricRow => r !== null);

  // Aggregate per-stage so the admin can see at a glance which stage
  // dominates memory + time across the whole sample window. avg/max
  // are computed only over rows that have the stage recorded —
  // historical rows from before a stage was added don't pull the
  // averages toward zero.
  const stageMap = new Map<string, { rss: number[]; t: number[] }>();
  let peakRssMax = 0;
  let peakRssSum = 0;
  for (const r of rows) {
    if (r.assembly_metrics.peak_rss_mb > peakRssMax) peakRssMax = r.assembly_metrics.peak_rss_mb;
    peakRssSum += r.assembly_metrics.peak_rss_mb;
    for (const s of r.assembly_metrics.stages) {
      const bucket = stageMap.get(s.stage) ?? { rss: [], t: [] };
      bucket.rss.push(s.rss_mb);
      bucket.t.push(s.t_ms);
      stageMap.set(s.stage, bucket);
    }
  }
  const stageAgg: StageAgg[] = [...stageMap.entries()].map(([stage, { rss, t }]) => ({
    stage,
    avg_rss_mb: Math.round(rss.reduce((a, b) => a + b, 0) / rss.length),
    max_rss_mb: Math.max(...rss),
    avg_t_ms: Math.round(t.reduce((a, b) => a + b, 0) / t.length),
    count: rss.length,
  }));
  // Sort by avg RSS descending so the heaviest stage is first.
  stageAgg.sort((a, b) => b.avg_rss_mb - a.avg_rss_mb);

  return NextResponse.json({
    rows,
    summary: {
      sampleSize: rows.length,
      peakRssMaxMb: peakRssMax,
      peakRssAvgMb: rows.length ? Math.round(peakRssSum / rows.length) : 0,
    },
    stageAgg,
  });
}
