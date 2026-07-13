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
   * Rule-based per-scenario overrides for Stage B concurrency. Each rule
   * matches against the in-flight project's resolution / beat count /
   * source type / captions flag; the first matching rule's value wins.
   * The global `assembly_beats` knob remains the hard ceiling — a rule
   * cannot exceed it, and unmatched runs fall back to it.
   */
  assembly_beats_rules: AssemblyBeatRule[];
};

export const ASSEMBLY_RESOLUTIONS = ["720p", "1080p", "1440p", "2160p"] as const;
export type AssemblyResolution = (typeof ASSEMBLY_RESOLUTIONS)[number];

export type AssemblyBeatRule = {
  /** Human-friendly label for the admin UI. */
  name: string;
  /** All set conditions must match. Unset conditions are wildcards. */
  when: {
    resolution?: AssemblyResolution;
    /** Matches when project beat count is <= this. */
    maxBeats?: number;
    /** Matches when project beat count is >= this. */
    minBeats?: number;
    /** Matches when every beat is image-based (no video sources). */
    allImages?: boolean;
    /** Matches the project's captions toggle. */
    captionsEnabled?: boolean;
  };
  /** Concurrency to apply when this rule matches. Bounded 1..ASSEMBLY_BEATS_MAX at validate-time. */
  value: number;
};

export const ASSEMBLY_BEATS_MIN = 1;
export const ASSEMBLY_BEATS_MAX = 10;

/** Keys of ConcurrencyConfig whose values are a single integer. Excludes
 * the rules array so it doesn't get fed into the per-knob render/save
 * paths that expect a numeric editor. */
export type ConcurrencyNumericKey = Exclude<keyof ConcurrencyConfig, "assembly_beats_rules">;

export const CONCURRENCY_DEFAULTS: ConcurrencyConfig = {
  video_worker: 3,
  // Prompt-generation chunk concurrency = 3. Chunks are slow (Opus via
  // KIE runs ~6 min for a dense ~35-beat, 300-word chunk), so sequential
  // made a full script overrun the 800s function ceiling repeatedly. The
  // earlier parallel failures — KIE queueing requests until their
  // time-to-first-token blew the idle-abort, plus 500 "Server exception"
  // storms at fan-out 4 — were symptoms of the 16384 first-token cliff and
  // the tee starving the SDK, both now fixed. Each call is lighter (12288,
  // fast first token), so 3 in flight cuts wall-clock to ~a third without
  // overloading KIE. Beat numbering stays correct — persistGates serialize
  // the DB inserts in script order. Nudge down to 2 if KIE 500s reappear,
  // up toward 4 only after confirming this account tolerates it.
  image_prompts_chunks: 3,
  video_prompts_chunks: 3,
  finish_images_poll: 5,
  image_generation_batch: 3,
  thumbnail_batch: 2,
  tts_beat_batch: 5,
  assembly_projects: 1,
  assembly_beats: 1,
  assembly_beats_rules: [],
};

// Human-readable labels + per-knob bounds for the admin UI and the
// PUT validator. Keep these together so a new knob lights up in
// both places with a single edit.
export const CONCURRENCY_FIELDS: {
  key: ConcurrencyNumericKey;
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
  const out: ConcurrencyConfig = { ...CONCURRENCY_DEFAULTS, assembly_beats_rules: [] };
  if (raw && typeof raw === "object") {
    for (const f of CONCURRENCY_FIELDS) {
      const v = (raw as Record<string, unknown>)[f.key];
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isInteger(n) && n >= f.min && n <= f.max) {
        out[f.key] = n;
      }
    }
    const rulesRaw = (raw as Record<string, unknown>).assembly_beats_rules;
    if (Array.isArray(rulesRaw)) {
      out.assembly_beats_rules = rulesRaw
        .map((r) => coerceAssemblyBeatRule(r))
        .filter((r): r is AssemblyBeatRule => r !== null);
    }
  }
  return out;
}

function coerceAssemblyBeatRule(raw: unknown): AssemblyBeatRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const value = typeof r.value === "number" ? r.value : Number(r.value);
  if (!Number.isInteger(value) || value < ASSEMBLY_BEATS_MIN || value > ASSEMBLY_BEATS_MAX) return null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 80) : "Unnamed rule";
  const whenRaw = (r.when && typeof r.when === "object") ? r.when as Record<string, unknown> : {};
  const when: AssemblyBeatRule["when"] = {};
  if (typeof whenRaw.resolution === "string" && (ASSEMBLY_RESOLUTIONS as readonly string[]).includes(whenRaw.resolution)) {
    when.resolution = whenRaw.resolution as AssemblyResolution;
  }
  const maxBeats = typeof whenRaw.maxBeats === "number" ? whenRaw.maxBeats : Number(whenRaw.maxBeats);
  if (Number.isInteger(maxBeats) && maxBeats > 0) when.maxBeats = maxBeats;
  const minBeats = typeof whenRaw.minBeats === "number" ? whenRaw.minBeats : Number(whenRaw.minBeats);
  if (Number.isInteger(minBeats) && minBeats > 0) when.minBeats = minBeats;
  if (typeof whenRaw.allImages === "boolean") when.allImages = whenRaw.allImages;
  if (typeof whenRaw.captionsEnabled === "boolean") when.captionsEnabled = whenRaw.captionsEnabled;
  return { name, when, value };
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
  const out: ConcurrencyConfig = { ...CONCURRENCY_DEFAULTS, assembly_beats_rules: [] };
  for (const f of CONCURRENCY_FIELDS) {
    const v = (input as Record<string, unknown>)[f.key];
    if (v === undefined) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n < f.min || n > f.max) {
      return { ok: false, error: `${f.key} must be an integer between ${f.min} and ${f.max}` };
    }
    out[f.key] = n;
  }
  const rulesRaw = (input as Record<string, unknown>).assembly_beats_rules;
  if (rulesRaw !== undefined) {
    if (!Array.isArray(rulesRaw)) return { ok: false, error: "assembly_beats_rules must be an array" };
    if (rulesRaw.length > 32) return { ok: false, error: "assembly_beats_rules may contain at most 32 rules" };
    const cleaned: AssemblyBeatRule[] = [];
    for (let i = 0; i < rulesRaw.length; i++) {
      const r = coerceAssemblyBeatRule(rulesRaw[i]);
      if (!r) return { ok: false, error: `assembly_beats_rules[${i}] is invalid (need name, when, and value 1..${ASSEMBLY_BEATS_MAX})` };
      cleaned.push(r);
    }
    out.assembly_beats_rules = cleaned;
  }
  return { ok: true, value: out };
}
