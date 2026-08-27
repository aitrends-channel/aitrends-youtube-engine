import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { creditsForUnits, getCreditRates } from "@/lib/pricing";
import type { CostUnitKind } from "@/lib/costs";
import { getFundingMode } from "@/lib/funding";
import { billingPlanOf } from "@/lib/plans-gating";
import { isHeclusCreditsPlan } from "@/lib/plan-tier";

export const dynamic = "force-dynamic";

// Display column → set of step values that roll up into it. Mirrors
// the admin /api/admin/project-costs endpoint exactly so the rendered
// matrix has the same shape whether an admin or the project owner is
// viewing it.
const COLUMN_STEPS = {
  channel_analysis: ["channel_analysis"],
  topic:            ["topic"],
  script:           ["script"],
  visuals:          ["visuals"],
  prompts:          ["prompts_image", "prompts_video"],
  voiceover:        ["tts"],
  generate:         ["image_gen", "video_gen"],
  assemble:         ["assemble"],
  thumbnail:        ["thumbnail_concept", "thumbnail_image"],
} as const;

type DisplayColumn = keyof typeof COLUMN_STEPS;

interface CostBreakdownEntry {
  provider: string;
  model: string | null;
  unitKind: string;
  units: number;
}

interface ColumnSummary {
  totals: Record<string, number>;
  breakdown: CostBreakdownEntry[];
  /** What this step cost in Heclus Credits, converted from the same rows with
   *  the same function that charged them, so the chip cannot disagree with the
   *  ledger. Provider units are the wrong unit to show someone who never sees a
   *  provider bill. */
  heclusCredits: number;
}

type ProjectCostsRollup = Record<DisplayColumn, ColumnSummary>;

function emptyRollup(): ProjectCostsRollup {
  const out = {} as ProjectCostsRollup;
  for (const col of Object.keys(COLUMN_STEPS) as DisplayColumn[]) {
    out[col] = { totals: {}, breakdown: [], heclusCredits: 0 };
  }
  return out;
}

/**
 * Per-project aggregated cost rows for the project owner.
 *
 * Same response shape as /api/admin/project-costs?projectId=X so the
 * front-end can render the identical provider × step matrix. The
 * ownership check (.eq user_id) makes RLS unnecessary for this read
 * path — a user querying someone else's project gets a 404.
 */
export async function GET(
  _req: Request,
  { params }: { params: { projectId: string } },
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  // Ownership gate: the cost rows themselves are keyed by project_id
  // only, so we verify the project belongs to this user first. A miss
  // here is treated as 404 rather than 403 so we don't leak whether
  // the project exists at all.
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (projErr) {
    return NextResponse.json({ error: projErr.message }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Page through every row — Supabase JS caps a single response at
  // 1000 rows by default. A single project with many beats (image +
  // video + voiceover writes per beat, plus Claude rows for each
  // step) can exceed that, silently dropping rows from the rollup.
  // Mirrors the same fix in /api/admin/project-costs.
  const PAGE_SIZE = 1000;
  const data: Array<{
    step: string;
    provider: string;
    model: string | null;
    units: number;
    unit_kind: string;
  }> = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("project_costs")
      .select("step, provider, model, units, unit_kind")
      .eq("project_id", projectId)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!page || page.length === 0) break;
    data.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const stepToColumn: Record<string, DisplayColumn> = {};
  for (const col of Object.keys(COLUMN_STEPS) as DisplayColumn[]) {
    for (const s of COLUMN_STEPS[col]) stepToColumn[s] = col;
  }

  const rates = await getCreditRates();
  const columns = emptyRollup();
  for (const row of (data ?? []) as Array<{
    step: string;
    provider: string;
    model: string | null;
    units: number;
    unit_kind: string;
  }>) {
    const col = stepToColumn[row.step];
    if (!col) continue;
    const summary = columns[col];
    summary.totals[row.unit_kind] = (summary.totals[row.unit_kind] ?? 0) + Number(row.units);
    const existing = summary.breakdown.find(
      (b) => b.provider === row.provider && b.model === row.model && b.unitKind === row.unit_kind,
    );
    if (existing) {
      existing.units += Number(row.units);
    } else {
      summary.breakdown.push({
        provider: row.provider,
        model: row.model,
        unitKind: row.unit_kind,
        units: Number(row.units),
      });
    }
    summary.heclusCredits += creditsForUnits(
      row.unit_kind as CostUnitKind,
      Number(row.units),
      rates,
      { model: row.model, provider: row.provider },
    );
  }

  const inCredits =
    isHeclusCreditsPlan(billingPlanOf(user)) || (await getFundingMode(user)) === "wallet";

  return NextResponse.json({ projectId, columns, inCredits });
}
