import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

// What one project's assembles cost us to run.
//
// Fetched when a row is opened rather than joined into the projects list: most
// projects are never opened, and this is a per-render table that a busy account
// writes to on every reassemble.

export interface RenderUsageRow {
  id: number;
  resolution: string | null;
  outputSeconds: number | null;
  wallMs: number;
  cpuSeconds: number;
  peakRssMb: number | null;
  encodes: number;
  unsampledEncodes: number;
  usdCost: number | null;
  succeeded: boolean;
  createdAt: string;
}

export async function GET(_req: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { projectId } = await ctx.params;

  const { data, error } = await supabase
    .from("render_usage")
    .select("id, resolution, output_seconds, wall_ms, cpu_seconds, peak_rss_mb, encodes, unsampled_encodes, usd_cost, succeeded, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(20);

  // An unapplied migration 145 is the expected failure here, and it must read
  // as "nothing measured yet" rather than breaking the drawer around it.
  if (error) {
    console.warn("[admin/render-usage] read failed:", error.message);
    return NextResponse.json({ rows: [], unavailable: true });
  }

  const rows: RenderUsageRow[] = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    resolution: (r.resolution as string | null) ?? null,
    // NUMERIC arrives as a string over PostgREST.
    outputSeconds: r.output_seconds === null ? null : Number(r.output_seconds),
    wallMs: Number(r.wall_ms),
    cpuSeconds: Number(r.cpu_seconds),
    peakRssMb: r.peak_rss_mb === null ? null : Number(r.peak_rss_mb),
    encodes: Number(r.encodes),
    unsampledEncodes: Number(r.unsampled_encodes),
    usdCost: r.usd_cost === null ? null : Number(r.usd_cost),
    succeeded: !!r.succeeded,
    createdAt: String(r.created_at),
  }));

  return NextResponse.json({ rows, unavailable: false });
}
