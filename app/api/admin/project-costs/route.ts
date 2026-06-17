import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

// Display column → set of step values that roll up into it.
// Mirrors the column order shown in the admin Cost table (Title is
// derived from project.selected_topic and not represented here).
const COLUMN_STEPS: Record<string, string[]> = {
  channel_analysis: ["channel_analysis"],
  topic:            ["topic"],
  script:           ["script"],
  visuals:          ["visuals"],
  prompts:          ["prompts_image", "prompts_video"],
  voiceover:        ["tts"],
  generate:         ["image_gen", "video_gen"],
  assemble:         ["assemble"],
  thumbnail:        ["thumbnail_concept", "thumbnail_image"],
};

type DisplayColumn = keyof typeof COLUMN_STEPS;

interface CostBreakdownEntry {
  provider: string;
  model: string | null;
  unitKind: string;
  units: number;
}

interface ColumnSummary {
  // Primary metric to show in the cell (e.g. total Claude tokens,
  // total KIE credits, total ElevenLabs chars). When a column has
  // multiple provider/unit combos we surface them as separate
  // entries so the UI can render multiple compact summaries.
  totals: Record<string, number>; // keyed by unit_kind
  breakdown: CostBreakdownEntry[];
}

type ProjectCostsRollup = Record<DisplayColumn, ColumnSummary>;

function emptyRollup(): ProjectCostsRollup {
  const out = {} as ProjectCostsRollup;
  for (const col of Object.keys(COLUMN_STEPS) as DisplayColumn[]) {
    out[col] = { totals: {}, breakdown: [] };
  }
  return out;
}

/**
 * Returns per-project aggregated cost rows for the admin Cost table.
 *
 * Response shape:
 *   {
 *     projects: [
 *       {
 *         projectId: "uuid",
 *         columns: {
 *           channel_analysis: { totals: { claude_tokens_in: 8400, ... }, breakdown: [...] },
 *           topic:            { ... },
 *           ...
 *         }
 *       },
 *       ...
 *     ]
 *   }
 *
 * The admin page already loads project metadata via /api/admin/stats
 * (title, user, createdAt, etc.); this endpoint stays focused on
 * costs and joins are done client-side.
 *
 * Optional ?projectId=X scopes to a single project (used for a
 * future per-project drilldown — not needed by the Cost tab yet,
 * but harmless to support now).
 */
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const projectIdFilter = searchParams.get("projectId");

  // Page through every row — Supabase JS caps a single response at
  // 1000 rows by default, and project_costs grows quickly (each
  // beat's image_gen + video_gen + voiceover write at least one row
  // each, plus per-step Claude rows). Without paging, rows past the
  // cap silently disappear from the rollup — the bug that made the
  // Thumbnail column show "—" on projects that legitimately had
  // thumbnail_concept + thumbnail_image rows in the DB.
  const PAGE_SIZE = 1000;
  const allRows: Array<{
    project_id: string;
    step: string;
    provider: string;
    model: string | null;
    units: number;
    unit_kind: string;
  }> = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = supabase
      .from("project_costs")
      .select("project_id, step, provider, model, units, unit_kind")
      .range(offset, offset + PAGE_SIZE - 1);
    if (projectIdFilter) {
      query = query.eq("project_id", projectIdFilter);
    }
    const { data: page, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!page || page.length === 0) break;
    allRows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  const data = allRows;

  // Pre-compute reverse lookup: step → display column.
  const stepToColumn: Record<string, DisplayColumn> = {};
  for (const col of Object.keys(COLUMN_STEPS) as DisplayColumn[]) {
    for (const s of COLUMN_STEPS[col]) stepToColumn[s] = col;
  }

  // Roll up rows into per-project, per-column summaries.
  const byProject = new Map<string, ProjectCostsRollup>();
  for (const row of (data ?? []) as Array<{
    project_id: string;
    step: string;
    provider: string;
    model: string | null;
    units: number;
    unit_kind: string;
  }>) {
    const col = stepToColumn[row.step];
    if (!col) continue; // unknown step — ignored rather than failing
    let rollup = byProject.get(row.project_id);
    if (!rollup) {
      rollup = emptyRollup();
      byProject.set(row.project_id, rollup);
    }
    const summary = rollup[col];
    summary.totals[row.unit_kind] = (summary.totals[row.unit_kind] ?? 0) + Number(row.units);
    // Merge breakdown by (provider, model, unit_kind) so the UI
    // can show e.g. "Claude Opus: 9.2k in + 3.2k out + 1.1k cache_read"
    // without us bloating the response with one entry per row.
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
  }

  const projects = Array.from(byProject.entries()).map(([projectId, columns]) => ({
    projectId,
    columns,
  }));

  return NextResponse.json({ projects });
}
