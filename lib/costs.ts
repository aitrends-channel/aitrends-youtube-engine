import { supabase } from "@/lib/supabase/client";
import { isDirectRouting, isPoyoRouting, type AnthropicRouting } from "@/lib/claude/routing";
import { chargeForCostEntry } from "@/lib/heclus-charge";
import { releaseHeclusCredits } from "@/lib/heclus-credits";

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
  // PoYo's own credit. A separate unit from kie_credits even though both
  // currently price at $0.005, because they are two vendors' currencies and
  // either can reprice without the other.
  | "poyo_credits"
  // One clip. Heclus buys these in $6/300 packs, so a row here is $0.02.
  | "genaipro_clips"
  | "elevenlabs_chars"
  | "supadata_transcripts";

export interface CostEntry {
  projectId: string;
  userId: string;
  step: CostStep;
  provider: "anthropic" | "kie" | "poyo" | "genaipro" | "elevenlabs" | "supadata";
  model?: string | null;
  units: number;
  unitKind: CostUnitKind;
  /** Which beat the cost belongs to, when it is per-beat work. Recorded on the
   *  credit ledger row so a charge can be traced to the clip that caused it. */
  beatNumber?: number | null;
  /** Which beats one call covered, where the work is per-chunk rather than
   *  per-beat: a prompt-writing call writes five beats and belongs to none of
   *  them. Recorded in the ledger note as "beats 7-11", which is what lets the
   *  usage log show the prompts THAT charge produced rather than every prompt
   *  in the project. */
  beatsCovered?: number[] | null;
  /** An open reservation taken before the work started. When present the
   *  charge settles it rather than reserving again, which is the difference
   *  between money held in advance and money taken afterwards. */
  reservationId?: string | null;
  /** The caller settled a hold for this work itself. The row is recorded for
   *  reporting and the charge path leaves it alone, which is how one hold can
   *  answer for the four rows a single Claude call produces. */
  alreadyHeld?: boolean;
  /** Generation duration in seconds. Used for video_gen kie_credits
   *  rows so the picker can compute units/durationSec as a per-second
   *  cost. Omit (or pass null) for steps where seconds aren't the
   *  natural unit — e.g. frame-counted Sora, or any non-video step. */
  durationSec?: number | null;
  /**
   * What makes this charge the same charge on a second attempt.
   *
   * A provider task id is the natural one: the same task is the same charge, and
   * a genuine retry gets a new task id. Passing it turns a re-charge loop into a
   * no-op instead of a debit. Between 29 June and 6 July one such loop wrote
   * 97,000 rows at a flat 324 an hour, and only the wallet not existing yet kept
   * it from costing about $478.
   *
   * Omit it for synchronous work, where every call is a real new charge. The
   * column then defaults to a random value and nothing is suppressed.
   */
  eventKey?: string | null;
  /** The resolution the generation was billed at, exactly as the picker labels
   *  it ("1K", "1080p", "pro"). What makes the rollup able to price a 4K run at
   *  4K rather than at whatever the cheapest resolution of that model cost.
   *  Omit only when the model has no resolution knob. */
  resolution?: string | null;
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
    const row: Record<string, unknown> = {
      project_id: entry.projectId,
      user_id: entry.userId,
      step: entry.step,
      provider: entry.provider,
      model: entry.model ?? null,
      units: entry.units,
      unit_kind: entry.unitKind,
      duration_sec: entry.durationSec ?? null,
      resolution: entry.resolution ?? null,
      elapsed_ms: entry.elapsedMs ?? null,
    };
    // One key per event, not per row. The step and unit kind are part of it so
    // the four token rows of a single Claude call stay distinct under one task.
    if (entry.eventKey) row.event_key = `${entry.step}:${entry.unitKind}:${entry.eventKey}`;

    let { data, error } = await supabase
      .from("project_costs")
      .upsert(row, { onConflict: "event_key", ignoreDuplicates: true })
      .select("id");

    // Migration 143 may not be applied yet. This is the meter, so it must not
    // stop recording: without the retry every cost row would be lost until the
    // column existed, while the charge below still went through. Falls back to a
    // plain insert, which means no idempotency rather than no ledger.
    if (error && /event_key/i.test(error.message)) {
      delete row.event_key;
      const plain = await supabase.from("project_costs").insert(row).select("id");
      data = plain.data;
      error = plain.error;
    }

    if (error) {
      console.warn(`[costs] insert failed step=${entry.step} provider=${entry.provider} unit_kind=${entry.unitKind}:`, error.message);
    } else if (entry.eventKey && row.event_key && (data ?? []).length === 0) {
      // Already metered. Charging again would debit twice for one piece of
      // provider work, which is the loop this key exists to stop, so the charge
      // below is skipped rather than merely logged.
      console.warn(`[costs] already metered, not charging again: step=${entry.step} key=${entry.eventKey}`);
      // Whoever metered this first also charged for it, so this caller's hold
      // has nothing left to pay for and must not be left open. Releasing a
      // reservation that the first caller already settled is a no-op, so this
      // is safe whichever path arrives second, and it is the difference between
      // credits coming back now and coming back when the sweeper next runs.
      if (entry.reservationId) {
        await releaseHeclusCredits(entry.reservationId, "already metered by another finisher");
      }
      return;
    }
  } catch (e) {
    console.warn(`[costs] insert threw step=${entry.step}:`, e instanceof Error ? e.message : e);
  }

  // Bill it, if this user's work runs on Heclus's keys.
  //
  // Hung off the meter rather than off each route on purpose: every provider
  // unit the product knows about already passes through here, including the
  // one-click orchestrator and the webhook completions, so there is no path
  // that can generate on Heclus's account without a ledger row. A BYO user, a
  // free-lane unit, and an unpriced unit all charge nothing.
  //
  // Awaited but never allowed to throw: the meter has already recorded the
  // work, and a failed debit must not take the generation down with it. The
  // charge module logs its own failures.
  await chargeForCostEntry(entry).catch(() => undefined);
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
 * Observed prices for one provider, by model and then by resolution.
 *
 * The empty-string key is the blended figure across every resolution, which is
 * the only thing this table held before migration 139 and still the right
 * answer for a model with no resolution knob. A named key ("1K", "1080p") is a
 * figure measured at that resolution and nothing else.
 *
 * Read it through observedFor rather than indexing it directly, so a model with
 * no history at the chosen resolution falls back the same way everywhere.
 */
export type ObservedByModel = Record<string, Record<string, number>>;

/** Which vendor's observations to read. The two credit currencies both price at
 *  $0.005 today but they are separate units, and both catalogs carry models with
 *  the same id, so a figure is only meaningful with a provider attached. */
export type ObservedProvider = "kie" | "poyo";

/**
 * True when the error is migration 142 not being applied yet.
 *
 * Worth telling apart from a real failure. Filtering on a column that does not
 * exist fails the whole query, and these getters fail soft by returning {},
 * which the picker renders as "no price" and the estimate reads as "unknown".
 * So deploying ahead of the migration would quietly unprice every model. On
 * that one error the KIE read retries without the filter, since every row
 * predating the column is a KIE row.
 */
function isMissingProviderColumn(message: string): boolean {
  return /column .*provider.* does not exist/i.test(message);
}

/**
 * The observed price for one model at one resolution.
 *
 * Prefers the measured figure for that exact resolution. Falls back to the
 * blended figure, which the caller is then expected to scale — see
 * lib/pricing/resolution.ts. Returns undefined when the model has no history at
 * all, which means "we do not know" and must not be read as free.
 */
export function observedFor(
  map: ObservedByModel,
  modelId: string,
  resolution?: string | null,
): { value: number; exact: boolean } | undefined {
  const byResolution = map[modelId];
  if (!byResolution) return undefined;
  const label = (resolution ?? "").trim();
  if (label && typeof byResolution[label] === "number") {
    return { value: byResolution[label], exact: true };
  }
  if (typeof byResolution[""] === "number") return { value: byResolution[""], exact: false };
  return undefined;
}

function groupByModel<T extends { model_name: string; resolution: string | null }>(
  rows: T[],
  pick: (row: T) => number | null | undefined,
): ObservedByModel {
  const out: ObservedByModel = {};
  for (const row of rows) {
    const value = pick(row);
    if (typeof value !== "number" || !(value > 0)) continue;
    (out[row.model_name] ??= {})[row.resolution ?? ""] = value;
  }
  return out;
}

/**
 * Returns the cheapest observed KIE credits per generation per image
 * model, sourced from the daily-refreshed model_cost_and_speed
 * snapshot. The cron at /api/cron/refresh-model-cost-and-speed
 * recomputes this from project_costs once a day.
 *
 * Fail-soft: returns {} on any error so the picker still renders.
 */
export async function getMinKieCreditsByModel(
  step: CostStep,
  provider: ObservedProvider = "kie",
): Promise<ObservedByModel> {
  const modelType = stepToModelType(step);
  if (modelType !== "image") return {};
  try {
    const { data, error } = await supabase
      .from("model_cost_and_speed")
      .select("model_name, resolution, cost_per_unit_credits")
      .eq("model_type", "image")
      .eq("provider", provider)
      .not("cost_per_unit_credits", "is", null);

    if (error && isMissingProviderColumn(error.message) && provider === "kie") {
      const legacy = await supabase
        .from("model_cost_and_speed")
        .select("model_name, resolution, cost_per_unit_credits")
        .eq("model_type", "image")
        .not("cost_per_unit_credits", "is", null);
      if (legacy.error) return {};
      return groupByModel(
        (legacy.data ?? []) as Array<{
          model_name: string; resolution: string | null; cost_per_unit_credits: number | null;
        }>,
        (r) => r.cost_per_unit_credits,
      );
    }
    if (error) {
      console.warn(`[costs] min-credits query failed step=${step}:`, error.message);
      return {};
    }

    return groupByModel(
      (data ?? []) as Array<{
        model_name: string; resolution: string | null; cost_per_unit_credits: number | null;
      }>,
      (r) => r.cost_per_unit_credits,
    );
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
export async function getMinCostPerSecByModel(
  step: CostStep,
  provider: ObservedProvider = "kie",
): Promise<ObservedByModel> {
  const modelType = stepToModelType(step);
  if (modelType !== "video") return {};
  try {
    const { data, error } = await supabase
      .from("model_cost_and_speed")
      .select("model_name, resolution, cost_per_second_credits")
      .eq("model_type", "video")
      .eq("provider", provider)
      .not("cost_per_second_credits", "is", null);

    if (error && isMissingProviderColumn(error.message) && provider === "kie") {
      const legacy = await supabase
        .from("model_cost_and_speed")
        .select("model_name, resolution, cost_per_second_credits")
        .eq("model_type", "video")
        .not("cost_per_second_credits", "is", null);
      if (legacy.error) return {};
      return groupByModel(
        (legacy.data ?? []) as Array<{
          model_name: string; resolution: string | null; cost_per_second_credits: number | null;
        }>,
        (r) => r.cost_per_second_credits,
      );
    }
    if (error) {
      console.warn(`[costs] cost-per-sec query failed step=${step}:`, error.message);
      return {};
    }

    return groupByModel(
      (data ?? []) as Array<{
        model_name: string; resolution: string | null; cost_per_second_credits: number | null;
      }>,
      (r) => r.cost_per_second_credits,
    );
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
export async function getAvgElapsedByModel(
  step: CostStep,
  provider: ObservedProvider = "kie",
): Promise<Record<string, number>> {
  const modelType = stepToModelType(step);
  if (modelType === null) return {};
  try {
    const { data, error } = await supabase
      .from("model_cost_and_speed")
      .select("model_name, speed_ms")
      .eq("model_type", modelType)
      .eq("provider", provider)
      // The blended row. Speed is ranked per model in the picker, not per
      // resolution, and without this filter a model with three resolution rows
      // would resolve to whichever one came back last.
      .eq("resolution", "")
      .not("speed_ms", "is", null);

    if (error && isMissingProviderColumn(error.message) && provider === "kie") {
      const legacy = await supabase
        .from("model_cost_and_speed")
        .select("model_name, speed_ms")
        .eq("model_type", modelType)
        .eq("resolution", "")
        .not("speed_ms", "is", null);
      if (legacy.error) return {};
      const out: Record<string, number> = {};
      for (const row of legacy.data ?? []) {
        const r = row as { model_name: string; speed_ms: number | null };
        if (typeof r.speed_ms === "number" && r.speed_ms > 0) out[r.model_name] = r.speed_ms;
      }
      return out;
    }
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

/** How far back the rollup looks. Matches the rate reconciliation and the token
 *  floors, so the three do not disagree about what "recent" means. An all-time
 *  minimum reached back to prices that are no longer charged. */
const ROLLUP_DAYS = 90;

interface ModelAggregate {
  modelName: string;
  modelType: ModelType;
  /** The vendor that billed. Part of the key: both catalogs carry a z-image. */
  provider: string;
  /** "" for the blended row, otherwise the resolution it was measured at. */
  resolution: string;
  costPerUnitCredits: number | null;   // image only
  costPerSecondCredits: number | null; // video only
  speedMs: number | null;
  sampleCount: number;
}

/**
 * Recompute the model_cost_and_speed snapshot from project_costs and
 * upsert one row per (model, type, resolution). Invoked daily by the Vercel
 * cron at /api/cron/refresh-model-cost-and-speed.
 *
 * Aggregation matches the three live readers further up in this file
 * — min credits for image, min credits/sec for video, avg elapsed_ms
 * for speed — so switching the picker to read this table is a no-op
 * in observable behavior, just faster.
 *
 * Every observation lands twice: once under its own resolution and once under
 * "" for the blended row. The blended row is what the picker chips and every
 * resolution-blind caller read before, and what the estimate falls back to for
 * a resolution nothing has been run at yet. Keeping both means the new
 * per-resolution figures can be trusted as soon as they exist without a model
 * losing its price the day the column was added.
 *
 * Both providers, kept apart by the provider column migration 142 added. They
 * bill in different currencies and both catalogs carry models with the same id
 * (z-image, seedream-4), so a MIN across them under one name would be
 * meaningless. Before that column existed PoYo had no observed prices at all:
 * its images fell back to a published catalog that goes stale, and its video
 * read KIE's figure for the same relayed model, in an unknown direction. The
 * first measurement put PoYo's grok-imagine at 5 credits a second against a
 * KIE range of 1.6 to 5.0 for the same clip length, so the substitution was not
 * conservative, it was a guess.
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
  // One pass in Postgres rather than 102 round trips here. The TypeScript
  // version paged project_costs 1,000 rows at a time to compute a minimum,
  // which was 30 seconds at 101,000 rows and grew with the table against a
  // 300-second ceiling. model_cost_rollup (migration 143) does the same
  // aggregation in SQL, bounded to a window.
  //
  // The window is the other half of the fix. "Cheapest ever observed" reached
  // back to prices no longer charged, and 90 days is what the rate
  // reconciliation and the token floors already use.
  const { data: rolled, error: rollErr } = await supabase
    .rpc("model_cost_rollup", { p_days: ROLLUP_DAYS });
  if (rollErr) {
    throw new Error(`[refresh-model-cost] model_cost_rollup failed: ${rollErr.message}`);
  }

  const aggregates = new Map<string, ModelAggregate>();
  for (const row of (rolled ?? []) as Array<Record<string, unknown>>) {
    const modelName = String(row.model_name ?? "");
    const modelType = String(row.model_type ?? "") as ModelType;
    const provider = String(row.provider ?? "kie");
    const resolution = String(row.resolution ?? "");
    if (!modelName || (modelType !== "image" && modelType !== "video")) continue;
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    aggregates.set(`${modelName}|${modelType}|${provider}|${resolution}`, {
      modelName,
      modelType,
      provider,
      resolution,
      costPerUnitCredits: num(row.cost_per_unit_credits),
      costPerSecondCredits: num(row.cost_per_second_credits),
      speedMs: num(row.speed_ms),
      sampleCount: Number(row.sample_count ?? 0),
    });
  }

  // Pull existing usd_per_credit values so the refresh doesn't clobber
  // admin-set rates. New models simply land with usd_per_credit=null
  // and USD columns null until someone sets a rate.
  const { data: existing, error: existingErr } = await supabase
    .from("model_cost_and_speed")
    .select("model_name, model_type, provider, resolution, usd_per_credit");
  if (existingErr) {
    throw new Error(`[refresh-model-cost] read existing failed: ${existingErr.message}`);
  }
  // Keyed without resolution: usd_per_credit converts a vendor credit to
  // dollars, which is a property of the vendor and the model, not of how many
  // pixels were asked for. Every resolution row of a model shares it, and the
  // blended row is where an admin sets it.
  const rateByKey = new Map<string, number | null>();
  for (const row of existing ?? []) {
    const r = row as {
      model_name: string; model_type: string; provider: string | null;
      resolution: string | null; usd_per_credit: number | null;
    };
    const key = `${r.model_name}|${r.model_type}|${r.provider ?? "kie"}`;
    const blended = (r.resolution ?? "") === "";
    if (blended || (!rateByKey.get(key) && r.usd_per_credit !== null)) {
      rateByKey.set(key, r.usd_per_credit ?? null);
    }
  }

  const now = new Date().toISOString();
  const payload = Array.from(aggregates.values()).map((agg) => {
    const key = `${agg.modelName}|${agg.modelType}|${agg.provider}`;
    const rate = rateByKey.get(key) ?? null;
    const unitUsd = agg.costPerUnitCredits !== null && rate !== null ? agg.costPerUnitCredits * rate : null;
    const secUsd  = agg.costPerSecondCredits !== null && rate !== null ? agg.costPerSecondCredits * rate : null;
    return {
      model_name: agg.modelName,
      model_type: agg.modelType,
      provider: agg.provider,
      resolution: agg.resolution,
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
    .upsert(payload, { onConflict: "model_name,model_type,provider,resolution" });
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
  /** Which provider served the call. Defaults to Anthropic; PoYo serves the
   *  same token-billed shape and must be distinguishable in the ledger, or the
   *  margin report values PoYo tokens at Anthropic's list price. */
  provider?: "anthropic" | "poyo";
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
  /** The caller settled a hold covering this call. */
  alreadyHeld?: boolean;
  /** The beats this one call wrote for, where it wrote for several. */
  beatsCovered?: number[] | null;
}): Promise<void> {
  const u = args.usage;
  if (!u) return;
  const base = {
    projectId: args.projectId,
    userId: args.userId,
    step: args.step,
    provider: args.provider ?? ("anthropic" as const),
    model: args.model,
    alreadyHeld: args.alreadyHeld,
    beatsCovered: args.beatsCovered,
  };
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
  /** The caller settled a hold covering this call. */
  alreadyHeld?: boolean;
  /** The beats this one call wrote for, where it wrote for several. */
  beatsCovered?: number[] | null;
}): Promise<void> {
  if (isDirectRouting(args.routing)) {
    await logClaudeUsage({
      provider: isPoyoRouting(args.routing) ? "poyo" : "anthropic",
      projectId: args.projectId,
      userId: args.userId,
      step: args.step,
      model: args.model,
      usage: args.usage,
      alreadyHeld: args.alreadyHeld,
      beatsCovered: args.beatsCovered,
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
      beatsCovered: args.beatsCovered,
    });
  }
}
