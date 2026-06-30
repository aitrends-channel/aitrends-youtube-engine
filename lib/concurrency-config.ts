import { supabase } from "@/lib/supabase/client";

// Single source of truth for every concurrent-operation cap in the
// product. Each field caps how many things run in parallel at one
// step. Stored as JSONB on product_config._global so the admin UI
// can tune them without code changes — see migration 048.
export type ConcurrencyConfig = {
  /** Video jobs the worker pulls from the queue at once. */
  video_worker: number;
  /** Image-prompt chunks processed in parallel inside one /api/workflow/prompts call. */
  image_prompts_chunks: number;
  /** Video-prompt chunks processed in parallel inside one /api/workflow/prompts call. */
  video_prompts_chunks: number;
  /** Image-completion poll workers in the finish-images cron. */
  finish_images_poll: number;
  /** Images generated per parallel batch in /api/generate/images. */
  image_generation_batch: number;
  /** Thumbnails generated per parallel batch in /api/generate/thumbnail-images. */
  thumbnail_batch: number;
  /** TTS beats generated per parallel batch in /api/generate/tts/beats. */
  tts_beat_batch: number;
  /** Whole video assemblies running in parallel on the worker. */
  assembly_projects: number;
  /** Parallel per-beat clip-normalize jobs inside a single assembly (Stage B). */
  assembly_beats: number;
  /**
   * Controls WHERE the upscale to the user's chosen final resolution
   * happens:
   *   true  → Stage B encodes every per-beat clip at the final
   *           resolution. Coconut (or local Stage F) only burns
   *           captions on top.
   *   false → Stage B encodes at a 720p intermediate, and
   *           Coconut handles the upscale + captions in one pass.
   * Trade-off: Stage B at final resolution is ~4× slower per beat
   * at 1080p and ~16× at 2160p, but captions/logo render at native
   * resolution and Coconut's job is simpler.
   */
  assembly_beats_at_final_res: boolean;
};

export const CONCURRENCY_DEFAULTS: ConcurrencyConfig = {
  video_worker: 3,
  image_prompts_chunks: 1,
  video_prompts_chunks: 1,
  finish_images_poll: 5,
  image_generation_batch: 3,
  thumbnail_batch: 2,
  tts_beat_batch: 5,
  assembly_projects: 1,
  assembly_beats: 1,
  // Default preserves current behavior: 720p intermediate Stage B,
  // Coconut handles the upscale to final resolution.
  assembly_beats_at_final_res: false,
};

// Boolean-typed Assemble flags. Kept in a separate array from the
// numeric CONCURRENCY_FIELDS because the admin UI renders them
// differently (checkbox vs number input) and the validator path
// for booleans skips the min/max bounds check.
export const ASSEMBLY_FLAG_FIELDS: {
  key: "assembly_beats_at_final_res";
  label: string;
  description: string;
}[] = [
  {
    key: "assembly_beats_at_final_res",
    label: "Encode beats at final resolution",
    description: "When ON, Stage B encodes each per-beat clip at the user's chosen output resolution and Coconut only burns captions. When OFF, Stage B uses a 720p intermediate and Coconut does the upscale + captions in one pass. Stage B at final resolution costs ~4× more CPU per beat at 1080p and ~16× at 2160p — but the resulting captions/logo render at native final resolution.",
  },
];

// Narrow the key type to ONLY the numeric-valued fields. Without
// this, `out[f.key] = number` below fails to type-check because
// the boolean fields would be candidates for f.key and the
// assignment target is `number | boolean` (never).
type NumericKey = {
  [K in keyof ConcurrencyConfig]: ConcurrencyConfig[K] extends number ? K : never;
}[keyof ConcurrencyConfig];

// Human-readable labels + per-knob bounds for the admin UI and the
// PUT validator. Keep these together so a new knob lights up in
// both places with a single edit.
export const CONCURRENCY_FIELDS: {
  key: NumericKey;
  label: string;
  description: string;
  min: number;
  max: number;
}[] = [
  {
    key: "video_worker",
    label: "Video worker jobs",
    description: "Caps how many video-generation jobs the worker pulls from the queue at once. Lower protects upstream API quotas; higher reduces queue latency.",
    min: 1, max: 50,
  },
  {
    key: "image_prompts_chunks",
    label: "Image-prompt chunks (workflow)",
    description: "Parallel image-prompt chunks inside one /api/workflow/prompts call. Each chunk batches several beats.",
    min: 1, max: 20,
  },
  {
    key: "video_prompts_chunks",
    label: "Video-prompt chunks (workflow)",
    description: "Parallel video-prompt chunks inside one /api/workflow/prompts call.",
    min: 1, max: 20,
  },
  {
    key: "finish_images_poll",
    label: "Finish-images poll workers",
    description: "Concurrent workers that finalize completed images in the finish-images cron.",
    min: 1, max: 50,
  },
  {
    key: "image_generation_batch",
    label: "Image generation batch",
    description: "Images generated in parallel per batch in /api/generate/images.",
    min: 1, max: 20,
  },
  {
    key: "thumbnail_batch",
    label: "Thumbnail generation batch",
    description: "Thumbnails generated in parallel per batch in /api/generate/thumbnail-images.",
    min: 1, max: 20,
  },
  {
    key: "tts_beat_batch",
    label: "TTS beat batch",
    description: "TTS beats generated in parallel per batch in /api/generate/tts/beats. Overrides the TTS_BEAT_BATCH_SIZE env var when set.",
    min: 1, max: 20,
  },
  {
    key: "assembly_projects",
    label: "Concurrent assemblies",
    description: "Whole video assemblies the worker runs in parallel. Each assembly is ffmpeg-heavy — raise carefully.",
    min: 1, max: 5,
  },
  {
    key: "assembly_beats",
    label: "Beats per assembly",
    description: "Per-beat clip normalize jobs run in parallel inside one assembly (Stage B). Multiplies with Concurrent assemblies for total ffmpeg load.",
    min: 1, max: 10,
  },
];

const CACHE_TTL_MS = 15_000;
let cached: { at: number; value: ConcurrencyConfig } | null = null;

/**
 * Coerce an arbitrary value (e.g. the DB's `batched_processes` JSON
 * blob) into a complete, in-range ConcurrencyConfig. Out-of-range or
 * non-integer values silently fall back to {@link CONCURRENCY_DEFAULTS}
 * for that field, so a malformed DB row never bricks the whole
 * config.
 */
export function coerceConcurrencyConfig(raw: unknown): ConcurrencyConfig {
  const out = { ...CONCURRENCY_DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const f of CONCURRENCY_FIELDS) {
      const v = (raw as Record<string, unknown>)[f.key];
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isInteger(n) && n >= f.min && n <= f.max) {
        out[f.key] = n;
      }
    }
    for (const f of ASSEMBLY_FLAG_FIELDS) {
      const v = (raw as Record<string, unknown>)[f.key];
      if (typeof v === "boolean") out[f.key] = v;
    }
  }
  return out;
}

/**
 * Fetch the current concurrency config, with a short in-memory cache
 * so high-volume code paths (the worker, the cron) don't hammer
 * Supabase. Falls back to {@link CONCURRENCY_DEFAULTS} on any error
 * so a misconfigured DB never takes down generation.
 */
export async function getConcurrencyConfig(): Promise<ConcurrencyConfig> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const { data } = await supabase
      .from("product_config")
      .select("batched_processes")
      .eq("service", "_global")
      .single();
    const value = coerceConcurrencyConfig((data as { batched_processes?: unknown } | null)?.batched_processes);
    cached = { at: now, value };
    return value;
  } catch {
    return CONCURRENCY_DEFAULTS;
  }
}

/** Force the next getConcurrencyConfig() call to re-read from the DB. */
export function invalidateConcurrencyConfigCache(): void {
  cached = null;
}

/** Validate + normalize an arbitrary input into a complete ConcurrencyConfig. Returns null with an error message on bad input. */
export function validateConcurrencyInput(input: unknown): { ok: true; value: ConcurrencyConfig } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Body must be an object" };
  const out = { ...CONCURRENCY_DEFAULTS };
  for (const f of CONCURRENCY_FIELDS) {
    const v = (input as Record<string, unknown>)[f.key];
    if (v === undefined) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n < f.min || n > f.max) {
      return { ok: false, error: `${f.key} must be an integer between ${f.min} and ${f.max}` };
    }
    out[f.key] = n;
  }
  for (const f of ASSEMBLY_FLAG_FIELDS) {
    const v = (input as Record<string, unknown>)[f.key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") {
      return { ok: false, error: `${f.key} must be a boolean` };
    }
    out[f.key] = v;
  }
  return { ok: true, value: out };
}
