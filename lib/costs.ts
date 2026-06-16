import { supabase } from "@/lib/supabase/client";
import type { AnthropicRouting } from "@/lib/claude/routing";

/**
 * Workflow step that the cost belongs to. Mapped to display columns
 * in the admin Cost table:
 *
 *   channel_analysis  → "Channel Analysis"
 *   topic             → "Topic"
 *   script            → "Script"
 *   visuals           → "Visuals"
 *   prompts_image     → "Prompts" (combined with prompts_video)
 *   prompts_video     → "Prompts"
 *   tts               → "Voiceover"
 *   image_gen         → "Generate" (combined with video_gen)
 *   video_gen         → "Generate"
 *   assemble          → "Assemble"
 *   thumbnail_concept → "Thumbnail" (combined with thumbnail_image)
 *   thumbnail_image   → "Thumbnail"
 */
export type CostStep =
  | "channel_analysis"
  | "topic"
  | "script"
  | "visuals"
  | "prompts_image"
  | "prompts_video"
  | "tts"
  | "image_gen"
  | "video_gen"
  | "assemble"
  | "thumbnail_concept"
  | "thumbnail_image";

/**
 * The natural unit each provider returns in its response. We store
 * the raw counts (no USD conversion) so the dashboard reports actual
 * consumption per provider and rate drift never lies to us.
 */
export type CostUnitKind =
  | "claude_tokens_in"
  | "claude_tokens_out"
  | "claude_tokens_cache_read"
  | "claude_tokens_cache_creation"
  | "kie_credits"
  | "elevenlabs_chars"
  | "supadata_transcripts";

export interface CostEntry {
  projectId: string;
  userId: string;
  step: CostStep;
  provider: "anthropic" | "kie" | "elevenlabs" | "supadata";
  model?: string | null;
  units: number;
  unitKind: CostUnitKind;
  /** Generation duration in seconds. Used for video_gen kie_credits
   *  rows so the picker can compute units/durationSec as a per-second
   *  cost. Omit (or pass null) for steps where seconds aren't the
   *  natural unit — e.g. frame-counted Sora, or any non-video step. */
  durationSec?: number | null;
  /** Wall-clock milliseconds from submit to result-ready. Used by
   *  the model picker's "Fastest" tab to rank models by observed
   *  speed. Set on image_gen kie_credits rows; safe to omit on rows
   *  where speed isn't a useful metric. */
  elapsedMs?: number | null;
}

/**
 * Insert a cost row. Fail-soft: if the write fails for any reason
 * (migration not yet applied, network blip, anything else) we log a
 * warning and move on rather than crashing the generation that
 * triggered the cost. The cost ledger is for reporting, not gating —
 * a missing row is acceptable; a thrown error in the middle of a
 * paid generation is not.
 *
 * Skips zero-unit writes to keep the table from filling with
 * meaningless rows (e.g. Claude responses with zero output tokens
 * on a cache-hit-only call).
 */
export async function logProjectCost(entry: CostEntry): Promise<void> {
  if (!entry.units || entry.units <= 0) return;
  if (!entry.projectId || !entry.userId) return;
  try {
    const { error } = await supabase
      .from("project_costs")
      .insert({
        project_id: entry.projectId,
        user_id: entry.userId,
        step: entry.step,
        provider: entry.provider,
        model: entry.model ?? null,
        units: entry.units,
        unit_kind: entry.unitKind,
        duration_sec: entry.durationSec ?? null,
        elapsed_ms: entry.elapsedMs ?? null,
      });
    if (error) {
      console.warn(`[costs] insert failed step=${entry.step} provider=${entry.provider} unit_kind=${entry.unitKind}:`, error.message);
    }
  } catch (e) {
    console.warn(`[costs] insert threw step=${entry.step}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Returns observed minimum total KIE credits charged per model for
 * the given step. Used by the image model picker — images don't have
 * a per-second notion, so we just want the cheapest observed single-
 * generation charge per model.
 *
 * Aggregates across all users. Fail-soft: returns {} on any error so
 * the picker still renders.
 */
export async function getMinKieCreditsByModel(step: CostStep): Promise<Record<string, number>> {
  try {
    const { data, error } = await supabase
      .from("project_costs")
      .select("model, units")
      .eq("step", step)
      .eq("provider", "kie")
      .eq("unit_kind", "kie_credits")
      .not("model", "is", null);

    if (error) {
      console.warn(`[costs] min-credits query failed step=${step}:`, error.message);
      return {};
    }

    const mins: Record<string, number> = {};
    for (const row of data ?? []) {
      const model = (row as { model: string | null }).model;
      const units = (row as { units: number }).units;
      if (!model || typeof units !== "number" || units <= 0) continue;
      if (mins[model] === undefined || units < mins[model]) mins[model] = units;
    }
    return mins;
  } catch (e) {
    console.warn(`[costs] min-credits threw step=${step}:`, e instanceof Error ? e.message : e);
    return {};
  }
}

/**
 * Returns the observed minimum KIE credits-per-second charged per
 * model. For each row we compute units / duration_sec and take the
 * minimum across all rows for that model. Used by the video model
 * picker to show "N cr/s" next to each model.
 *
 * Aggregates across all users — KIE bills consistently, so a larger
 * sample size gives a better-grounded minimum. Rows without a
 * duration_sec (historical pre-migration rows, plus frame-counted
 * models like Sora) are ignored — including them as null would
 * either skew the min or produce NaN.
 *
 * Returns a map keyed by KIE model id. Models with no usable rows
 * are absent from the map (callers should treat as "no data yet").
 *
 * Fail-soft: a query error returns an empty map and logs a warning,
 * because the picker should still render even if the ledger is
 * unreachable.
 */
export async function getMinCostPerSecByModel(step: CostStep): Promise<Record<string, number>> {
  try {
    const { data, error } = await supabase
      .from("project_costs")
      .select("model, units, duration_sec")
      .eq("step", step)
      .eq("provider", "kie")
      .eq("unit_kind", "kie_credits")
      .not("model", "is", null)
      .not("duration_sec", "is", null)
      .gt("duration_sec", 0);

    if (error) {
      console.warn(`[costs] cost-per-sec query failed step=${step}:`, error.message);
      return {};
    }

    const mins: Record<string, number> = {};
    for (const row of data ?? []) {
      const model = (row as { model: string | null }).model;
      const units = (row as { units: number }).units;
      const durationSec = (row as { duration_sec: number }).duration_sec;
      if (!model || typeof units !== "number" || units <= 0) continue;
      if (typeof durationSec !== "number" || durationSec <= 0) continue;
      const perSec = units / durationSec;
      if (mins[model] === undefined || perSec < mins[model]) mins[model] = perSec;
    }
    return mins;
  } catch (e) {
    console.warn(`[costs] cost-per-sec threw step=${step}:`, e instanceof Error ? e.message : e);
    return {};
  }
}

/**
 * Returns the observed average wall-clock generation time per model
 * (in milliseconds) for the given step. Used by the model picker's
 * "Fastest" tab — lower is faster.
 *
 * Average (not min) because a single anomalously fast run (cache
 * hit, empty KIE queue) would rank a usually-slow model ahead of
 * a usually-fast one if we used min. Average smooths that out as
 * samples accumulate.
 *
 * Aggregates across all users. Rows without elapsed_ms (historical
 * pre-migration rows + steps that don't measure speed) are ignored.
 *
 * Fail-soft: returns {} on any error so the picker still renders.
 */
export async function getAvgElapsedByModel(step: CostStep): Promise<Record<string, number>> {
  try {
    const { data, error } = await supabase
      .from("project_costs")
      .select("model, elapsed_ms")
      .eq("step", step)
      .eq("provider", "kie")
      .eq("unit_kind", "kie_credits")
      .not("model", "is", null)
      .not("elapsed_ms", "is", null)
      .gt("elapsed_ms", 0);

    if (error) {
      console.warn(`[costs] avg-elapsed query failed step=${step}:`, error.message);
      return {};
    }

    // Two-pass: sum + count → average. Doing this client-side rather
    // than via a Postgres GROUP BY because the supabase-js builder
    // doesn't expose aggregate functions cleanly, and the row volume
    // for image_gen / video_gen is small enough that an in-memory
    // aggregation is fine.
    const sums: Record<string, number> = {};
    const counts: Record<string, number> = {};
    for (const row of data ?? []) {
      const model = (row as { model: string | null }).model;
      const elapsed = (row as { elapsed_ms: number }).elapsed_ms;
      if (!model || typeof elapsed !== "number" || elapsed <= 0) continue;
      sums[model] = (sums[model] ?? 0) + elapsed;
      counts[model] = (counts[model] ?? 0) + 1;
    }
    const avgs: Record<string, number> = {};
    for (const [model, sum] of Object.entries(sums)) {
      const c = counts[model];
      if (!c) continue;
      avgs[model] = sum / c;
    }
    return avgs;
  } catch (e) {
    console.warn(`[costs] avg-elapsed threw step=${step}:`, e instanceof Error ? e.message : e);
    return {};
  }
}

/**
 * Convenience wrapper: log every relevant field from an Anthropic
 * response.usage object as separate cost rows. Anthropic responses
 * always carry the four token counters; this just demultiplexes them
 * into our unit-kind taxonomy.
 *
 * Pass when you have the full response object handy — saves the
 * caller from writing the same four logProjectCost calls everywhere.
 */
export async function logClaudeUsage(args: {
  projectId: string;
  userId: string;
  step: CostStep;
  model: string;
  // Loose shape — Anthropic SDK returns these as number | null. Some
  // fields are also absent on older API versions. We accept undefined
  // | null on every counter and coalesce to 0 inside logProjectCost
  // (which itself skips zero writes).
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null | undefined;
}): Promise<void> {
  const u = args.usage;
  if (!u) return;
  const base = { projectId: args.projectId, userId: args.userId, step: args.step, provider: "anthropic" as const, model: args.model };
  await Promise.all([
    logProjectCost({ ...base, units: u.input_tokens                ?? 0, unitKind: "claude_tokens_in" }),
    logProjectCost({ ...base, units: u.output_tokens               ?? 0, unitKind: "claude_tokens_out" }),
    logProjectCost({ ...base, units: u.cache_read_input_tokens     ?? 0, unitKind: "claude_tokens_cache_read" }),
    logProjectCost({ ...base, units: u.cache_creation_input_tokens ?? 0, unitKind: "claude_tokens_cache_creation" }),
  ]);
}

/**
 * Route-aware Anthropic cost logger. Dispatches to the correct
 * ledger based on routing:
 *
 *  - heclus_direct → bills in tokens, log claude_tokens_* rows
 *    via logClaudeUsage. Same behavior the old direct path had.
 *
 *  - client_kie / heclus_kie → bills in KIE credits. Token counters
 *    on the Anthropic response are still accurate, but they aren't
 *    what we're paying for — KIE charges credits per call and the
 *    cost view should reflect that. Log a single kie_credits row
 *    if the credits ref was populated; otherwise no row (better
 *    than logging an estimate that diverges from KIE's billing).
 *
 * Always pass routing + creditsConsumed from the AnthropicClientHandle
 * — the helper handles the branch internally so call sites don't have
 * to. Fail-soft on writes via logProjectCost.
 */
export async function logAnthropicCost(args: {
  projectId: string;
  userId: string;
  step: CostStep;
  model: string;
  routing: AnthropicRouting;
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null | undefined;
  kieCreditsConsumed: number | null;
}): Promise<void> {
  if (args.routing === "heclus_direct") {
    await logClaudeUsage({
      projectId: args.projectId,
      userId: args.userId,
      step: args.step,
      model: args.model,
      usage: args.usage,
    });
    return;
  }
  // KIE-mediated. Only log if we actually saw a credit value on the
  // response — silently skip otherwise. A missing kie_credits row
  // is better than a fake one; the row will reappear naturally once
  // we know where KIE puts credits for this endpoint.
  if (args.kieCreditsConsumed && args.kieCreditsConsumed > 0) {
    await logProjectCost({
      projectId: args.projectId,
      userId: args.userId,
      step: args.step,
      provider: "kie",
      model: args.model,
      units: args.kieCreditsConsumed,
      unitKind: "kie_credits",
    });
  }
}
