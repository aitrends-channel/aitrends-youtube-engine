import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

// One user's share of what the render fleet has cost us.
//
// The share is the point: a CPU figure on its own says nothing without knowing
// whether it is most of the fleet or a rounding error, and that is the question
// an operator is actually asking when they open a user.

// Memory is reported as GB-hours, not as a peak. Peaks do not add up: holding
// 2 GB for ten minutes and 2 GB for an hour are not the same consumption, and
// summing two peaks describes a machine that never existed. Occupancy does add
// up, and it is what an instance is billed on.
function gbHours(peakRssMb: number | null, wallMs: number): number {
  if (!peakRssMb || !(wallMs > 0)) return 0;
  return (peakRssMb / 1024) * (wallMs / 3_600_000);
}

// Bounded so a growing table cannot turn an admin drawer into a full scan. One
// row per assemble means this covers a long time at current volumes, and
// `partial` says so when it does not.
const SCAN_LIMIT = 10_000;

export interface UserUsage {
  found: boolean;
  unavailable: boolean;
  partial: boolean;
  renders: number;
  cpuSeconds: number;
  gbHours: number;
  peakRssMb: number | null;
  usdCost: number | null;
  totals: { renders: number; cpuSeconds: number; gbHours: number; usdCost: number | null };
  cpuShare: number | null;
  memShare: number | null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ email: string }> }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { email: raw } = await ctx.params;
  const email = decodeURIComponent(raw).trim().toLowerCase();

  const empty = (over: Partial<UserUsage> = {}): UserUsage => ({
    found: false, unavailable: false, partial: false,
    renders: 0, cpuSeconds: 0, gbHours: 0, peakRssMb: null, usdCost: null,
    totals: { renders: 0, cpuSeconds: 0, gbHours: 0, usdCost: null },
    cpuShare: null, memShare: null,
    ...over,
  });

  // render_usage keys on user_id and the users table carries only the email, so
  // the id has to be resolved. Same listUsers page size the rest of the admin
  // surface uses.
  const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) return NextResponse.json(empty());
  const userId = users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;

  const { data, error } = await supabase
    .from("render_usage")
    .select("user_id, cpu_seconds, peak_rss_mb, wall_ms, usd_cost")
    .order("created_at", { ascending: false })
    .limit(SCAN_LIMIT);

  // An unapplied migration 145 must read as "nothing measured", not as an error
  // that breaks the drawer around it.
  if (error) return NextResponse.json(empty({ unavailable: true }));

  const rows = (data ?? []) as {
    user_id: string; cpu_seconds: number | string;
    peak_rss_mb: number | string | null; wall_ms: number | string; usd_cost: number | string | null;
  }[];

  let renders = 0, cpuSeconds = 0, gb = 0, peak = 0, usd = 0, usdSeen = false;
  let tRenders = 0, tCpu = 0, tGb = 0, tUsd = 0, tUsdSeen = false;

  for (const r of rows) {
    // NUMERIC arrives as a string over PostgREST.
    const cpu = Number(r.cpu_seconds) || 0;
    const rss = r.peak_rss_mb === null ? null : Number(r.peak_rss_mb);
    const wall = Number(r.wall_ms) || 0;
    const cost = r.usd_cost === null ? null : Number(r.usd_cost);
    const g = gbHours(rss, wall);

    tRenders += 1; tCpu += cpu; tGb += g;
    if (cost !== null) { tUsd += cost; tUsdSeen = true; }

    if (userId && r.user_id === userId) {
      renders += 1; cpuSeconds += cpu; gb += g;
      if (rss !== null && rss > peak) peak = rss;
      if (cost !== null) { usd += cost; usdSeen = true; }
    }
  }

  const body: UserUsage = {
    found: !!userId,
    unavailable: false,
    partial: rows.length >= SCAN_LIMIT,
    renders,
    cpuSeconds,
    gbHours: gb,
    peakRssMb: peak > 0 ? peak : null,
    usdCost: usdSeen ? usd : null,
    totals: { renders: tRenders, cpuSeconds: tCpu, gbHours: tGb, usdCost: tUsdSeen ? tUsd : null },
    // Null rather than zero when there is no fleet total to divide by: "0% of
    // nothing" is a claim, and an absent share is the truth.
    cpuShare: tCpu > 0 ? cpuSeconds / tCpu : null,
    memShare: tGb > 0 ? gb / tGb : null,
  };
  return NextResponse.json(body);
}
