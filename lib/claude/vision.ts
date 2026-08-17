import { supabase } from "@/lib/supabase/client";
import { CLAUDE_MODELS, type ClaudeModelOption } from "@/lib/claude/models";

// Config for the steps that send images: visual analysis and prompts-from-image.
// Editable in the admin dashboard under Config → Anthropic → Per step, on the
// Visual analysis card (product_config.vision_model /
// product_config.visual_analysis_max_images, migration 127).

/** What the engine ran on before this setting existed. */
export const VISION_MODEL_FALLBACK = "claude-opus-4-7";

/** Frames per image list. Was a hardcoded 20 in the route and 12 in the
 *  one-click orchestrator; 10 is the shipped default for both. */
export const VISUAL_ANALYSIS_MAX_IMAGES_FALLBACK = 10;

/** Guardrails on the admin input. Below 3 there isn't enough material to read a
 *  channel's style from; above 20 the input tokens outrun what the step is
 *  worth, and the screenshots route only captures 20 anyway. */
export const MIN_VISUAL_ANALYSIS_IMAGES = 3;
export const MAX_VISUAL_ANALYSIS_IMAGES = 20;

/**
 * Models offered for the vision steps: the two ends of the trade, and nothing
 * in between. Both sit on the 2576px high-resolution tier and share a
 * tokenizer, so switching doesn't move token counts — only the rate.
 *
 *   Opus 4.7    $5/$25 per Mtok, what the engine shipped on
 *   Sonnet 5    $3/$15, and $2/$10 until 2026-08-31
 *
 * Deliberately excluded: Opus 5 and 4.8 price identically to 4.7, so they add
 * a choice without a decision. Sonnet 4.6 caps at 1568px for Sonnet 5's list
 * price, strictly worse. Haiku 4.5 is the catalogue's loosest tool_choice
 * follower, and visual analysis forces save_visual_analysis — the wrong place
 * to save money.
 */
export const VISION_MODEL_IDS = [
  "claude-opus-4-7",
  "claude-sonnet-5",
] as const;

export function isSelectableVisionModel(id: unknown): id is string {
  return typeof id === "string" && (VISION_MODEL_IDS as readonly string[]).includes(id);
}

export function visionModels(): ClaudeModelOption[] {
  return VISION_MODEL_IDS
    .map((id) => CLAUDE_MODELS.find((m) => m.id === id))
    .filter((m): m is ClaudeModelOption => !!m);
}

export type VisionConfig = {
  model: string;
  maxImages: number;
};

const CACHE_TTL_MS = 15_000;
let cached: { at: number; value: VisionConfig } | null = null;

const FALLBACK: VisionConfig = {
  model: VISION_MODEL_FALLBACK,
  maxImages: VISUAL_ANALYSIS_MAX_IMAGES_FALLBACK,
};

function clampImages(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return VISUAL_ANALYSIS_MAX_IMAGES_FALLBACK;
  const n = Math.round(raw);
  if (n < MIN_VISUAL_ANALYSIS_IMAGES || n > MAX_VISUAL_ANALYSIS_IMAGES) {
    return VISUAL_ANALYSIS_MAX_IMAGES_FALLBACK;
  }
  return n;
}

/** Cached so a per-call lookup doesn't hammer Supabase. Falls back to the
 *  shipped values on any error — a misconfigured row must never block a
 *  generation. */
export async function getVisionConfig(): Promise<VisionConfig> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
  try {
    const { data } = await supabase
      .from("product_config")
      .select("vision_model, visual_analysis_max_images")
      .eq("service", "_global")
      .single();
    const row = data as { vision_model?: unknown; visual_analysis_max_images?: unknown } | null;
    const value: VisionConfig = {
      model: isSelectableVisionModel(row?.vision_model) ? row.vision_model : VISION_MODEL_FALLBACK,
      maxImages: clampImages(row?.visual_analysis_max_images),
    };
    cached = { at: now, value };
    return value;
  } catch {
    return FALLBACK;
  }
}

export function invalidateVisionConfigCache(): void {
  cached = null;
}
