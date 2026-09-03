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

/** One movement of credits on this project, for the usage log. */
export interface CreditLogEntry {
  /** The display column it rolls up into, or null when the note named a step
   *  this endpoint has no column for. */
  column: string | null;
  /** The raw step from the note. The log names this rather than the column it
   *  rolls into: "Generate" covers both an image and a clip, which are
   *  different work at different prices, and a person reading a charge wants
   *  to know which one they paid for. */
  step: string | null;
  /** Which beat, where the charge belongs to one. */
  beatNumber: number | null;
  /** The beats one call covered, where the work was per-chunk: prompt writing
   *  bills per call and a call writes several beats. Written into the note at
   *  charge time; null on rows charged before that was recorded. */
  beatsFrom: number | null;
  beatsTo: number | null;
  provider: string | null;
  /** The model that served this step, where one is known. Rendered for admins
   *  only, but sent to everyone: it is not secret, and gating the payload as
   *  well as the column would be two places to keep in step. */
  model: string | null;
  type: "charged" | "refunded";
  /** Always positive. The direction is in `type`, not the sign. */
  credits: number;
  at: string;
}

interface CostBreakdownEntry {
  provider: string;
  model: string | null;
  unitKind: string;
  units: number;
}

interface ColumnSummary {
  totals: Record<string, number>;
  breakdown: CostBreakdownEntry[];
  /** What the work was worth in credits, converted from the metered units.
   *  Not what the customer paid: a settle is capped at the hold, so an
   *  under-estimate is absorbed by Heclus rather than billed on. Kept for the
   *  admin cost views, which want the real cost of the work. */
  heclusCredits: number;
  /** What the customer was actually charged, summed from the ledger. This is
   *  the figure a customer surface must show. The two diverged by 766 credits
   *  on one prompts run, and displaying the worth made the step look like it
   *  had spent more than the account held. */
  heclusCreditsCharged: number;
}

type ProjectCostsRollup = Record<DisplayColumn, ColumnSummary>;

function emptyRollup(): ProjectCostsRollup {
  const out = {} as ProjectCostsRollup;
  for (const col of Object.keys(COLUMN_STEPS) as DisplayColumn[]) {
    out[col] = { totals: {}, breakdown: [], heclusCredits: 0, heclusCreditsCharged: 0 };
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

  // Which model served each step.
  //
  // credit_ledger records the provider but not the model, and project_costs
  // records the model but carries no beat number, so the two cannot be joined
  // row to row. Per step is the join that does hold: a project runs one image
  // model, one voice and one Claude model per step. Changing model mid-run
  // would label the later charges with the earlier name.
  //
  // Supadata is skipped: it bills the product owner rather than the user, and
  // would otherwise take the name of the step it rode along with.
  const modelByStep: Record<string, string> = {};
  for (const row of (data ?? []) as Array<{ step: string; provider: string; model: string | null }>) {
    if (!row.model || row.provider === "supadata") continue;
    modelByStep[row.step] ??= row.model;
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

  // Charged, from the ledger, rather than re-derived.
  //
  // credit_ledger has no step column; the note is written in one place as
  // `${step} · …`, so the prefix is the step. Fragile in the way any parse is,
  // and the alternative was a second number for the same thing, which is what
  // produced a chip claiming 907 credits on a step that billed 141.
  const { data: ledger } = await supabase
    .from("credit_ledger")
    .select("kind, credits, note, created_at, beat_number, provider")
    .eq("user_id", user.id)
    .eq("project_id", projectId)
    .in("kind", ["spend", "refund"])
    .order("created_at", { ascending: false });

  // The same rows again as a list. The page shows what was taken and what came
  // back, rather than a matrix of provider units nobody is billed in.
  const log: CreditLogEntry[] = [];

  for (const row of (ledger ?? []) as
    { kind: string; credits: number | string; note: string | null; created_at: string;
      beat_number: number | null; provider: string | null }[]) {
    const note = row.note ?? "";
    const step = note.split(" · ")[0]?.trim();
    // "prompts_video · beats 7-11 · 0.05 kie_credits"
    const span = /(?:^|·)\s*beats\s+(\d+)-(\d+)/i.exec(note);
    const col = step ? stepToColumn[step] : undefined;
    const credits = Number(row.credits);
    log.push({
      // An unmapped step still belongs in the log. Dropping it would make the
      // list disagree with the balance, and a missing name is easier to add
      // later than a missing charge is to explain.
      column: col ?? null,
      step: step || null,
      beatNumber: row.beat_number,
      beatsFrom: span ? Number(span[1]) : null,
      beatsTo: span ? Number(span[2]) : null,
      provider: row.provider,
      model: step ? modelByStep[step] ?? null : null,
      type: credits < 0 ? "charged" : "refunded",
      credits: Math.abs(credits),
      at: row.created_at,
    });
    if (!col) continue;
    // Signed in the ledger: spend is negative, refund positive. Charged is what
    // is left after refunds, so the sum is negated once.
    columns[col].heclusCreditsCharged -= Number(row.credits);
  }

  const inCredits =
    isHeclusCreditsPlan(billingPlanOf(user)) || (await getFundingMode(user)) === "wallet";

  return NextResponse.json({ projectId, columns, inCredits, log });
}
