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
      });
    if (error) {
      console.warn(`[costs] insert failed step=${entry.step} provider=${entry.provider} unit_kind=${entry.unitKind}:`, error.message);
    }
  } catch (e) {
    console.warn(`[costs] insert threw step=${entry.step}:`, e instanceof Error ? e.message : e);
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
