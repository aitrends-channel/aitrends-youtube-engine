import { supabase } from "@/lib/supabase/client";
import { isDirectRouting, type AnthropicRouting } from "@/lib/claude/routing";

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
  // One clip. Heclus buys these in $6/300 packs, so a row here is $0.02.
  | "genaipro_clips"
  | "elevenlabs_chars"
  | "supadata_transcripts";

export interface CostEntry {
  projectId: string;
  userId: string;
  step: CostStep;
  provider: "anthropic" | "kie" | "genaipro" | "elevenlabs" | "supadata";
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

/** Map the cost ledger step to the model_cost_and_speed model_type
 *  axis. Only image_gen / video_gen have rows in the snapshot table;
 *  other steps don't go through the KIE model picker. */
function stepToModelType(step: CostStep): "image" | "video" | null {
  if (step === "image_gen") return "image";
  if (step === "video_gen") return "video";
  return null;
}

/**
 * Returns the cheapest observed KIE credits per generation per image
 * model, sourced from the daily-refreshed model_cost_and_speed
 * snapshot. The cron at /api/cron/refresh-model-cost-and-speed
 * recomputes this from project_costs once a day.
 *
 * Fail-soft: returns {} on any error so the picker still renders.
 */
export async function getMinKieCreditsByModel(step: CostStep): Promise<Record<string, number>> {
  const modelType = stepToModelType(step);
  if (modelType !== "image") return {};
  try {
    const { data, error } = await supabase
      .from("model_cost_and_speed")
      .select("model_name, cost_per_unit_credits")
      .eq("model_type", "image")
      .not("cost_per_unit_credits", "is", null);

    if (error) {
      console.warn(`[costs] min-credits query failed step=${step}:`, error.message);
      return {};
    }

    const out: Record<string, number> = {};
    for (const row of data ?? []) {
      const r = row as { model_name: string; cost_per_unit_credits: number | null };
      if (typeof r.cost_per_unit_credits === "number" && r.cost_per_unit_credits > 0) {
        out[r.model_name] = r.cost_per_unit_credits;
      }
    }
    return out;
  } catch (e) {
    console.warn(`[costs] min-credits threw step=${step}:`, e instanceof Error ? e.message : e);
    return {};
  }
}

/**
 * Returns the cheapest observed KIE credits-per-second per video
 * model, sourced from the daily-refreshed model_cost_and_speed
 * snapshot. Models without a usable observation are absent from the
 * map (callers should treat as "no data yet").
 *
 * Fail-soft: returns {} on any error so the picker still renders.
 */
export async function getMinCostPerSecByModel(step: CostStep): Promise<Record<string, number>> {
  const modelType = stepToModelType(step);
  if (modelType !== "video") return {};
  try {
    const { data, error } = await supabase
      .from("model_cost_and_speed")
      .select("model_name, cost_per_second_credits")
      .eq("model_type", "video")
      .not("cost_per_second_credits", "is", null);

    if (error) {
      console.warn(`[costs] cost-per-sec query failed step=${step}:`, error.message);
      return {};
    }

    const out: Record<string, number> = {};
    for (const row of data ?? []) {
      const r = row as { model_name: string; cost_per_second_credits: number | null };
      if (typeof r.cost_per_second_credits === "number" && r.cost_per_second_credits > 0) {
        out[r.model_name] = r.cost_per_second_credits;
      }
    }
    return out;
  } catch (e) {
    console.warn(`[costs] cost-per-sec threw step=${step}:`, e instanceof Error ? e.message : e);
    return {};
  }
}

/**
 * Returns the observed average wall-clock generation time per model
 * (ms) for the given step, sourced from the daily-refreshed
 * model_cost_and_speed snapshot. Powers the picker's "Fastest" tab —
 * lower is faster.
 *
 * Fail-soft: returns {} on any error so the picker still renders.
 */
export async function getAvgElapsedByModel(step: CostStep): Promise<Record<string, number>> {
  const modelType = stepToModelType(step);
  if (modelType === null) return {};
  try {
    const { data, error } = await supabase
      .from("model_cost_and_speed")
      .select("model_name, speed_ms")
      .eq("model_type", modelType)
      .not("speed_ms", "is", null);

    if (error) {
      console.warn(`[costs] avg-elapsed query failed step=${step}:`, error.message);
      return {};
    }

    const out: Record<string, number> = {};
    for (const row of data ?? []) {
      const r = row as { model_name: string; speed_ms: number | null };
      if (typeof r.speed_ms === "number" && r.speed_ms > 0) {
        out[r.model_name] = r.speed_ms;
      }
    }
    return out;
  } catch (e) {
    console.warn(`[costs] avg-elapsed threw step=${step}:`, e instanceof Error ? e.message : e);
    return {};
  }
}

type ModelType = "image" | "video";

interface ModelAggregate {
  modelName: string;
  modelType: ModelType;
  costPerUnitCredits: number | null;   // image only
  costPerSecondCredits: number | null; // video only
  speedMs: number | null;
  sampleCount: number;
}

/**
 * Recompute the model_cost_and_speed snapshot from project_costs and
 * upsert one row per (model, type). Invoked daily by the Vercel cron
 * at /api/cron/refresh-model-cost-and-speed.
 *
 * Aggregation matches the three live readers further up in this file
 * — min credits for image, min credits/sec for video, avg elapsed_ms
 * for speed — so switching the picker to read this table is a no-op
 * in observable behavior, just faster.
 *
 * usd_per_credit is preserved per row: we read the existing value
 * first and write it back unchanged on upsert. The USD columns are
 * derived = credits * usd_per_credit, and stay null when the rate
 * hasn't been set yet for that model.
 */
export async function refreshModelCostAndSpeed(): Promise<{
  upserted: number;
  skipped: number;
}> {
  const { data, error } = await supabase
    .from("project_costs")
    .select("step, model, units, duration_sec, elapsed_ms")
    .in("step", ["image_gen", "video_gen"])
    .eq("provider", "kie")
    .eq("unit_kind", "kie_credits")
    .not("model", "is", null);

  if (error) {
    throw new Error(`[refresh-model-cost] read project_costs failed: ${error.message}`);
  }

  const aggregates = new Map<string, ModelAggregate>();
  const speedSums = new Map<string, { sum: number; count: number }>();

  for (const row of data ?? []) {
    const r = row as {
      step: string;
      model: string | null;
      units: number | null;
      duration_sec: number | null;
      elapsed_ms: number | null;
    };
    if (!r.model || typeof r.units !== "number" || r.units <= 0) continue;
    const modelType: ModelType = r.step === "video_gen" ? "video" : "image";
    const key = `${r.model}|${modelType}`;

    let agg = aggregates.get(key);
    if (!agg) {
      agg = {
        modelName: r.model,
        modelType,
        costPerUnitCredits: null,
        costPerSecondCredits: null,
        speedMs: null,
        sampleCount: 0,
      };
      aggregates.set(key, agg);
    }
    agg.sampleCount += 1;

    if (modelType === "image") {
      if (agg.costPerUnitCredits === null || r.units < agg.costPerUnitCredits) {
        agg.costPerUnitCredits = r.units;
      }
    } else {
      if (typeof r.duration_sec === "number" && r.duration_sec > 0) {
        const perSec = r.units / r.duration_sec;
        if (agg.costPerSecondCredits === null || perSec < agg.costPerSecondCredits) {
          agg.costPerSecondCredits = perSec;
        }
      }
    }

    if (typeof r.elapsed_ms === "number" && r.elapsed_ms > 0) {
      const s = speedSums.get(key) ?? { sum: 0, count: 0 };
      s.sum += r.elapsed_ms;
      s.count += 1;
      speedSums.set(key, s);
    }
  }

  for (const [key, agg] of aggregates) {
    const s = speedSums.get(key);
    if (s && s.count > 0) agg.speedMs = s.sum / s.count;
  }

  // Pull existing usd_per_credit values so the refresh doesn't clobber
  // admin-set rates. New models simply land with usd_per_credit=null
  // and USD columns null until someone sets a rate.
  const { data: existing, error: existingErr } = await supabase
    .from("model_cost_and_speed")
    .select("model_name, model_type, usd_per_credit");
  if (existingErr) {
    throw new Error(`[refresh-model-cost] read existing failed: ${existingErr.message}`);
  }
  const rateByKey = new Map<string, number | null>();
  for (const row of existing ?? []) {
    const r = row as { model_name: string; model_type: string; usd_per_credit: number | null };
    rateByKey.set(`${r.model_name}|${r.model_type}`, r.usd_per_credit ?? null);
  }

  const now = new Date().toISOString();
  const payload = Array.from(aggregates.values()).map((agg) => {
    const key = `${agg.modelName}|${agg.modelType}`;
    const rate = rateByKey.get(key) ?? null;
    const unitUsd = agg.costPerUnitCredits !== null && rate !== null ? agg.costPerUnitCredits * rate : null;
    const secUsd  = agg.costPerSecondCredits !== null && rate !== null ? agg.costPerSecondCredits * rate : null;
    return {
      model_name: agg.modelName,
      model_type: agg.modelType,
      cost_per_unit_credits: agg.costPerUnitCredits,
      cost_per_unit_usd: unitUsd,
      cost_per_second_credits: agg.costPerSecondCredits,
      cost_per_second_usd: secUsd,
      usd_per_credit: rate,
      speed_ms: agg.speedMs,
      sample_count: agg.sampleCount,
      updated_at: now,
    };
  });

  if (payload.length === 0) return { upserted: 0, skipped: 0 };

  const { error: upsertErr } = await supabase
    .from("model_cost_and_speed")
    .upsert(payload, { onConflict: "model_name,model_type" });
  if (upsertErr) {
    throw new Error(`[refresh-model-cost] upsert failed: ${upsertErr.message}`);
  }
  return { upserted: payload.length, skipped: 0 };
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
 *  - heclus_direct / client_direct → bills in tokens, log claude_tokens_*
 *    rows via logClaudeUsage. Same behavior the old direct path had. The
 *    ledger records consumption per project regardless of who is billed —
 *    it already mixes the two, since client_kie credits are the client's.
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
  if (isDirectRouting(args.routing)) {
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
