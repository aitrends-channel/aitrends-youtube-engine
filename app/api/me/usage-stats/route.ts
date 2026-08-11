import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// Consumption the signed-in user actually spent, aggregated from the
// project_costs ledger. Same source the per-project cost view reads, but
// scoped to the account and rolled up over time instead of per project, so
// the dashboard's "API keys & usage" tab can answer "what have I burned
// lately" without opening a video.
//
// Raw provider units, no USD. The ledger deliberately stores natural units
// (KIE credits, ElevenLabs characters, Claude tokens) so a rate change
// upstream can't make historical numbers lie.
//
// The aggregation itself lives in the user_usage_stats function (migration
// 120): the ledger holds one row per upstream call, so an active account runs
// to tens of thousands of rows and reading them through PostgREST would take
// ~90 paged requests to produce four numbers. This route only shapes what
// comes back — zero-filling the days nobody generated anything and putting
// the steps in workflow order.

const DAYS = 30;

const STEP_ORDER = [
  "channel_analysis",
  "topic",
  "script",
  "visuals",
  "prompts",
  "voiceover",
  "generate",
  "assemble",
  "thumbnail",
] as const;

export type UsageStep = (typeof STEP_ORDER)[number];

export interface UsageUnits {
  kieCredits: number;
  elevenlabsChars: number;
  claudeTokens: number;
}

export interface UsageWindow extends UsageUnits {
  /** Distinct videos that consumed anything in the window. */
  videos: number;
  /** Distinct videos that reached image or video generation. */
  generated: number;
  steps: (UsageUnits & { step: UsageStep })[];
}

export interface MeUsageStats {
  d30: UsageWindow;
  all: UsageWindow;
  /** Oldest-first, zero-filled, one entry per day for the last 30 days. */
  daily: (UsageUnits & { date: string })[];
  /** ISO timestamp of the account's first ledger row, null when it has none. */
  since: string | null;
}

interface RpcWindow extends UsageUnits {
  videos: number;
  generated: number;
  steps: (UsageUnits & { step: string })[];
}

interface RpcResult {
  window: RpcWindow;
  all: RpcWindow;
  daily: (UsageUnits & { date: string })[];
  since: string | null;
}

function emptyUnits(): UsageUnits {
  return { kieCredits: 0, elevenlabsChars: 0, claudeTokens: 0 };
}

const STEP_RANK = new Map<string, number>(STEP_ORDER.map((s, i) => [s, i]));

// The function groups by step but doesn't order, and a step whose every unit
// came from a provider we don't display would arrive as a row of zeros.
function orderSteps(steps: RpcWindow["steps"]): UsageWindow["steps"] {
  return steps
    .filter((s) => STEP_RANK.has(s.step))
    .filter((s) => s.kieCredits > 0 || s.elevenlabsChars > 0 || s.claudeTokens > 0)
    .sort((a, b) => STEP_RANK.get(a.step)! - STEP_RANK.get(b.step)!)
    .map((s) => ({ ...s, step: s.step as UsageStep }));
}

function shape(w: RpcWindow | undefined): UsageWindow {
  return {
    ...emptyUnits(),
    ...(w ?? {}),
    videos: w?.videos ?? 0,
    generated: w?.generated ?? 0,
    steps: orderSteps(w?.steps ?? []),
  };
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { data, error } = await supabase.rpc("user_usage_stats", {
    uid: user.id,
    window_days: DAYS,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const result = (data ?? {}) as Partial<RpcResult>;

  // Day keys in UTC, matching the function's own bucketing. A local-time
  // split would leave the series off by a day for anyone west of UTC.
  const today = new Date();
  const byDay = new Map((result.daily ?? []).map((d) => [d.date, d]));
  const daily: MeUsageStats["daily"] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const date = new Date(today.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    daily.push({ ...emptyUnits(), ...(byDay.get(date) ?? {}), date });
  }

  return NextResponse.json({
    d30: shape(result.window),
    all: shape(result.all),
    daily,
    since: result.since ?? null,
  } satisfies MeUsageStats);
}
