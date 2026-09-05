import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { creditsForUnits, getCreditRates } from "@/lib/pricing";
import type { CostUnitKind } from "@/lib/costs";
import { getFundingMode } from "@/lib/funding";
import { billingPlanOf } from "@/lib/plans-gating";
import { isHeclusCreditsPlan } from "@/lib/plan-tier";
import { isAdminUser } from "@/lib/admin";

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
  /** "running" is work that has started and not yet been metered. Those rows
   *  are built from the beats, not from the ledger: nothing has been charged
   *  for them yet, which is exactly what the row is there to say. */
  status?: "done" | "running";
  /** How many beats one running row stands for. */
  beats?: number;
}

/**
 * One metered event, for the accounts that have no ledger.
 *
 * An old-plan account spends on its own keys, so credit_ledger has nothing for
 * it and the usage log a credit account reads was simply not available. The
 * meter records the same work either way, so this is that: one row per thing
 * the project actually did.
 *
 * No beat number, because project_costs does not carry one. The log names what
 * ran and what it used; a per-beat result can only be shown for the steps that
 * produce one thing for the whole project.
 */
export interface CostEventEntry {
  column: string | null;
  step: string | null;
  provider: string | null;
  model: string | null;
  unitKind: string;
  units: number;
  at: string;
  status?: "done" | "running";
  beats?: number;
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
    created_at: string;
    event_key: string | null;
  }> = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("project_costs")
      .select("step, provider, model, units, unit_kind, created_at, event_key")
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

  // The meter as a list, newest first.
  //
  // Sent to everyone rather than only to the accounts that render it: an admin
  // switching to the old-plan view is reading their own project, and a payload
  // that depended on their funding mode would show them an empty log for a
  // project full of work. Capped, because the page reads a few screens of it
  // and a long project has hundreds of rows.
  const EVENT_LIMIT = 500;

  // One Claude call meters up to four rows: input, output, cache read and cache
  // write. Listed raw they are four lines for one thing, with four numbers that
  // mean nothing apart, so they are summed back into the call.
  //
  // Grouped by step and model inside a short window rather than by the event
  // key, because these rows carry no shared key: each is written with an id of
  // its own. The window is what a single call looks like in the table, the four
  // rows landing within a few tens of milliseconds of each other. A step that
  // fans out over parallel chunks reads as one entry per burst, which is closer
  // to what happened than four rows per chunk.
  const TOKEN_WINDOW_MS = 2_000;
  const openCall = new Map<string, CostEventEntry>();
  const ordered: CostEventEntry[] = [];
  const byTimeAsc = [...(data ?? [])].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  for (const row of byTimeAsc) {
    if (row.provider === "supadata") continue;
    const entry: CostEventEntry = {
      column: stepToColumn[row.step] ?? null,
      step: row.step || null,
      provider: row.provider,
      model: row.model,
      unitKind: row.unit_kind,
      units: Number(row.units),
      at: row.created_at,
    };
    if (!row.unit_kind.startsWith("claude_tokens")) {
      ordered.push(entry);
      continue;
    }
    entry.unitKind = "claude_tokens";
    const key = `${row.step}|${row.model ?? ""}`;
    const open = openCall.get(key);
    const gap = open ? Date.parse(entry.at) - Date.parse(open.at) : Infinity;
    if (open && gap >= 0 && gap <= TOKEN_WINDOW_MS) {
      open.units += entry.units;
      open.at = entry.at;
      open.model ??= entry.model;
      continue;
    }
    openCall.set(key, entry);
    ordered.push(entry);
  }
  const events: CostEventEntry[] = ordered
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, EVENT_LIMIT);

  // Work that has started and has not been metered yet.
  //
  // A generation is recorded when it finishes, so a run in progress left both
  // logs looking as though nothing was happening: the row appeared minutes
  // later, all at once, at the moment it stopped being interesting. The beats
  // know what is in flight, so that is where these come from.
  //
  // Grouped by step and provider rather than one row per beat: a forty beat
  // run would otherwise bury everything already done behind forty identical
  // pending lines. No amount and no time, because neither is known yet, and a
  // guess at either would be the one thing a log must not do.
  const IMAGE_RUNNING = new Set(["generating", "queued"]);
  const VIDEO_RUNNING = new Set(["queued", "submitting", "rendering"]);
  const VOICE_RUNNING = new Set(["generating", "queued"]);
  const { data: beatRows } = await supabase
    .from("project_beats")
    .select("image_status, image_operator, image_model_id, video_status, video_operator, video_model_id, voiceover_status")
    .eq("project_id", projectId);

  const runningKey = (step: string, provider: string) => `${step}|${provider}`;
  const running = new Map<string, { step: string; provider: string; model: string | null; beats: number }>();
  const noteRunning = (step: string, provider: string, model: string | null) => {
    const key = runningKey(step, provider);
    const seen = running.get(key);
    if (seen) { seen.beats += 1; seen.model ??= model; return; }
    running.set(key, { step, provider, model, beats: 1 });
  };
  for (const b of ((beatRows ?? []) as Array<{
    image_status: string | null; image_operator: string | null; image_model_id: string | null;
    video_status: string | null; video_operator: string | null; video_model_id: string | null;
    voiceover_status: string | null;
  }>)) {
    if (b.image_status && IMAGE_RUNNING.has(b.image_status)) {
      noteRunning("image_gen", b.image_operator ?? "kie", b.image_model_id);
    }
    if (b.video_status && VIDEO_RUNNING.has(b.video_status)) {
      noteRunning("video_gen", b.video_operator ?? "kie", b.video_model_id);
    }
    if (b.voiceover_status && VOICE_RUNNING.has(b.voiceover_status)) {
      noteRunning("tts", "elevenlabs", null);
    }
  }

  // At the front of both lists. They are the only rows describing now.
  for (const r of [...running.values()].reverse()) {
    events.unshift({
      column: stepToColumn[r.step] ?? null,
      step: r.step,
      provider: r.provider,
      model: r.model,
      unitKind: r.step === "tts" ? "elevenlabs_chars" : "kie_credits",
      units: 0,
      at: new Date().toISOString(),
      status: "running",
      beats: r.beats,
    });
    log.unshift({
      column: stepToColumn[r.step] ?? null,
      step: r.step,
      beatNumber: null,
      beatsFrom: null,
      beatsTo: null,
      provider: r.provider,
      model: r.model,
      type: "charged",
      credits: 0,
      at: new Date().toISOString(),
      status: "running",
      beats: r.beats,
    });
  }

  const inCredits =
    isHeclusCreditsPlan(billingPlanOf(user)) || (await getFundingMode(user)) === "wallet";

  // Whether the account whose log this is may see the internal columns.
  //
  // Decided here rather than in the browser, because getRequiredUser resolves
  // impersonation and the browser's session does not: an admin acting as a
  // customer was reading the customer's rows with their own admin columns on,
  // which is both the wrong view of what the customer sees and the model name
  // on a page it does not belong on.
  return NextResponse.json({ projectId, columns, inCredits, log, events, isAdmin: isAdminUser(user) });
}
