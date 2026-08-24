import type { KieModel } from "@/lib/types";

// PoYo's image catalog, and what each generation costs in PoYo credits.
//
// The credit figures are the estimate, not the charge. PoYo does report what a
// finished task cost, in credits_amount, and lib/poyo/images.ts settles on that
// (see the note there); this table is what the reserve and the cost chips use
// before there is a task to ask about. It is also demonstrably out of step with
// what PoYo bills — a probe read 18 credits from nano-banana-pro against the 8
// its price list shows — so treat a row without a measured note as indicative.
//
// `verified` is about the id string, not the price. PoYo publishes credit costs
// against display names but does not publish the identifier to send in the
// `model` field, and only two appear literally in their docs. The rest are
// inferred from the naming convention those two establish (lowercase, hyphen
// separated, tracking the display name). An unverified model is deliberately
// withheld from the picker, because the failure mode is a submit rejected at
// PoYo after the wallet has already reserved credits for it.
//
// To verify: scripts/verify-poyo-catalog.mjs probes each id against the real
// API and reports which ones PoYo does not recognise. Flip `verified` on the
// ones that pass and they appear in the picker.
//
// Verified against the live API on 2026-08-22. Four inferred ids came back
// "Model not found" and are still withheld. Their real ids are now known, from
// docs.poyo.ai/api-manual/image-series, but each splits into variants the price
// list does not price separately, so enabling one means deciding which variant
// the published figure belongs to:
//   flux-kontext   → flux-kontext-pro | flux-kontext-max
//   flux-2         → flux-2-pro | flux-2-flex
//   qwen-image-3.0 → qwen-image-3 | qwen-image-3-pro
//   kling-o1-image → kling-o1-image-edit, edit-only: it requires image_urls,
//                    so there is no text-to-image path to expose at all.
//
// flux-schnell is withheld for a different reason. It resolves, but PoYo's
// error names flux-dev back ("prompt is required for flux-dev"), which reads
// like an alias. That matters more than an unknown id would: the two are
// priced 0.48 against 4 credits, so if they are the same model this table
// undercharges by 8x on every generation. Confirm before exposing it.
//
// nano-banana-2 is verified on indirect evidence: an empty prompt reached
// content moderation rather than model lookup, which only happens once the id
// has resolved.

export interface PoyoImageModel {
  /** The string sent in the request's `model` field. */
  id: string;
  name: string;
  /** PoYo credits per generation, from poyo.ai/ai-image-api. */
  credits: number;
  /** Whether `id` has been confirmed against the live API. */
  verified: boolean;
  tags: string[];
}

const m = (id: string, name: string, credits: number, verified: boolean, tags: string[]): PoyoImageModel =>
  ({ id, name, credits, verified, tags });

export const POYO_IMAGE_MODELS: PoyoImageModel[] = [
  // Confirmed: appears as a literal model id in PoYo's own z-image guide.
  m("z-image",           "Z-Image",            2,    true,  ["Fast", "Alibaba"]),
  // Confirmed: the worked example in docs.poyo.ai/api-manual/overview.
  m("gpt-4o-image",      "GPT-4o Image",       4,    true,  ["OpenAI"]),

  m("gpt-image-2",       "GPT Image 2",        2,    true, ["OpenAI"]),
  m("gpt-image-1.5",     "GPT Image 1.5",      2,    true, ["OpenAI"]),
  m("kling-o3-image",    "Kling O3 Image",     3.5,    true, ["Kling"]),
  m("kling-o1-image",    "Kling O1 Image",     3.5,  false, ["Kling"]),
  m("flux-dev",          "Flux Dev",           4,    true, ["Black Forest Labs"]),
  m("flux-schnell",      "Flux Schnell",       0.48, false, ["Black Forest Labs", "Cheapest"]),
  m("flux-kontext",      "Flux Kontext",       8,    false, ["Black Forest Labs"]),
  m("flux-2",            "FLUX.2",             6,    false, ["Black Forest Labs"]),
  m("wan-2.7-image",     "Wan 2.7 Image",      4.2,    true, ["Alibaba"]),
  m("qwen-image-3.0",    "Qwen Image 3.0",     4.8,  false, ["Alibaba"]),
  m("nano-banana",       "Nano Banana",        5,    true, ["Google"]),
  // Measured: the median of nine finished tasks read back 8 credits, not the 5
  // the price list shows.
  m("nano-banana-2",     "Nano Banana 2",      8,    true, ["Google"]),
  m("nano-banana-2-lite","Nano Banana 2 Lite", 5,    true, ["Google", "Fast"]),
  // Measured: a probe task at the default 1K read back 18 credits, not the 8
  // the price list shows.
  m("nano-banana-pro",   "Nano Banana Pro",    18,   true, ["Google", "Pro"]),
  m("seedream-4",        "Seedream 4",         5,    true, ["ByteDance"]),
  m("seedream-4.5",      "Seedream 4.5",       5,    true, ["ByteDance"]),
  m("seedream-5.0-lite", "Seedream 5.0 Lite",  5,    true, ["ByteDance"]),
  m("seedream-5.0-pro",  "Seedream 5.0 Pro",   15,    true, ["ByteDance", "Max Quality"]),
  m("grok-imagine-image", "Grok Imagine",      6,    true, ["xAI"]),
  // Measured, not from the price list: a probe task read back 12 credits.
  m("grok-imagine-image-2.0", "Grok Imagine 2.0", 12,  true, ["xAI"]),
  // NOT an image model. "grok-imagine" is Grok's video endpoint: a task
  // submitted against it came back as an .mp4 and charged 30 credits, while
  // the beat recorded it as an image. Kept, withheld from the picker, so beats
  // that already stored this id can still be priced and settled.
  m("grok-imagine",      "Grok Imagine (video, legacy id)", 30, false, ["xAI"]),
];

const BY_ID = new Map(POYO_IMAGE_MODELS.map((x) => [x.id, x]));

export function getPoyoImageModel(id: string): PoyoImageModel | undefined {
  return BY_ID.get(id);
}

/**
 * What a generation on this model costs, in PoYo credits.
 *
 * Throws on an unknown model rather than returning 0. A zero here would be a
 * generation that produced a cost row saying it was free, which is the one
 * accounting error nobody notices. Same reasoning as the rate guard in
 * lib/pricing.ts.
 */
export function poyoCreditsFor(modelId: string): number {
  const model = BY_ID.get(modelId);
  if (!model) throw new Error(`No PoYo price for model: ${modelId}`);
  return model.credits;
}

/** Only verified ids reach the picker. See the note above on why. */
export function listPoyoImageModels(): KieModel[] {
  return POYO_IMAGE_MODELS
    .filter((x) => x.verified)
    .map((x) => ({ id: x.id, name: x.name, type: "image" as const, tags: x.tags }));
}

/** What a model with no entry in POYO_MODEL_INPUTS is assumed to take. Also the
 *  list every ratio-validating model in the catalog has in common. */
export const POYO_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"];

/**
 * What each model's `input` accepts: which ratios, and whether it has its own
 * resolution control.
 *
 * PoYo validates `size` per model and rejects anything outside that model's own
 * list rather than falling back, which is how a house default of 16:9 turned
 * into "Invalid size, must be one of: 1024x1024, 1024x1536, 1536x1024, 1:1,
 * 2:3, 3:2" on the GPT models. Ratios are read off the validator itself (a
 * submit with an impossible size names the whole list; see
 * scripts/probe-poyo-sizes.mjs) and cross-checked against each model's page
 * under docs.poyo.ai/api-manual/image-series. Read 2026-08-23.
 *
 * Ratios are ordered for the picker, not alphabetically: the first entry is
 * what the UI falls back to when the current choice is unsupported, so the
 * landscape ratio closest to 16:9 leads every row.
 *
 * A model absent here takes POYO_ASPECT_RATIOS. That is only the four that
 * validate nothing at all (nano-banana and both grok ids accepted a garbage
 * size and generated anyway) plus anything added without checking.
 */
interface PoyoModelInputs {
  /** Accepted values for the ratio field, as PoYo spells them. */
  sizes: string[];
  /** Values for the model's own `resolution` field, when it has one. */
  resolutions?: string[];
  /** grok-imagine-image-2.0 calls the ratio field `aspect_ratio`. */
  sizeKey?: "aspect_ratio";
  /**
   * Longest prompt this model accepts, where it says so.
   *
   * z-image takes 1,000 characters and our beat prompts are longer, so a run
   * of 46 images failed with "prompt must be 1000 characters or less" and not
   * one call reached generation. The retry that exists for KIE's version of
   * this error did not fire, because PoYo words it differently.
   *
   * Measured 2026-08-24 by submitting a 30,000-character prompt and reading
   * the rejection. Only measured limits are here: several models accepted that
   * prompt outright, so their real ceiling is unknown and capping them on a
   * documented figure would trim prompts for no reason. The docs claim 1,000
   * for the GPT models and they took 30,000 without complaint, which is either
   * a stale doc or a silent truncation, and neither is worth guessing at.
   */
  promptMax?: number;
  /**
   * Models whose resolution presets are values of `size` rather than a field of
   * their own (Seedream 4.5 and 5.0 Lite). Since one field cannot carry both, a
   * chosen resolution is expressed as the WIDTHxHEIGHT that keeps the ratio,
   * which those two document as a custom size. The number is the long edge.
   */
  sizeResolutions?: Record<string, number>;
}

export const POYO_MODEL_INPUTS: Record<string, PoyoModelInputs> = {
  "z-image":            { sizes: ["16:9", "9:16", "1:1", "4:3", "3:4"], promptMax: 1000 },
  // No 16:9 on either GPT model. 3:2 is the widest they offer.
  "gpt-4o-image":       { sizes: ["3:2", "2:3", "1:1"] },
  "gpt-image-1.5":      { sizes: ["3:2", "2:3", "1:1"] },
  "gpt-image-2":        { sizes: ["16:9", "9:16", "1:1", "21:9", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5"], resolutions: ["1K", "2K", "4K"] },
  "kling-o3-image":     { sizes: ["16:9", "9:16", "1:1", "21:9", "3:2", "2:3", "4:3", "3:4"], resolutions: ["1K", "2K", "4K"] },
  "flux-dev":           { sizes: ["16:9", "9:16", "1:1", "4:3", "3:4"] },
  "flux-schnell":       { sizes: ["16:9", "9:16", "1:1", "4:3", "3:4"] },
  // Pixel dimensions only, and no resolution field: 1024x576 is the 16:9 the
  // picker asks for.
  "wan-2.7-image":      { sizes: ["1024x576", "576x1024", "1024x1024", "1024x768", "768x1024", "512x512"] },
  "nano-banana":        { sizes: ["16:9", "9:16", "1:1", "21:9", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5"], promptMax: 5000 },
  "nano-banana-2":      { sizes: ["16:9", "9:16", "1:1", "21:9", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5"], resolutions: ["1K", "2K", "4K"] },
  "nano-banana-2-lite": { sizes: ["16:9", "9:16", "1:1", "21:9", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5"], promptMax: 20_000 },
  "nano-banana-pro":    { sizes: ["16:9", "9:16", "1:1", "21:9", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5"], resolutions: ["1K", "2K", "4K"], promptMax: 20_000 },
  "seedream-4":         { sizes: ["16:9", "9:16", "1:1", "21:9", "3:2", "2:3", "4:3", "3:4"], resolutions: ["1K", "2K", "4K"] },
  "seedream-4.5":       { sizes: ["16:9", "9:16", "1:1", "21:9", "3:2", "2:3", "4:3", "3:4"], sizeResolutions: { "2K": 2048, "4K": 4096 } },
  "seedream-5.0-lite":  { sizes: ["16:9", "9:16", "1:1", "21:9", "3:2", "2:3", "4:3", "3:4"], sizeResolutions: { "2K": 2048, "3K": 3072 } },
  "seedream-5.0-pro":   { sizes: ["16:9", "9:16", "1:1", "21:9", "3:2", "2:3", "4:3", "3:4"], resolutions: ["1K", "2K"] },
  "grok-imagine-image": { sizes: ["16:9", "9:16", "1:1", "3:2", "2:3"], promptMax: 5000 },
  "grok-imagine-image-2.0": { sizes: ["16:9", "9:16", "1:1", "3:2", "2:3"], resolutions: ["1K", "2K"], sizeKey: "aspect_ratio", promptMax: 8000 },
};

const RATIO = /^(\d+):(\d+)$/;
const PIXELS = /^(\d+)x(\d+)$/i;

/** A size as a width/height number, or null for the tokens that are not one
 *  ("auto", "2K", "1:1 HD"). Those stay out of the nearest-match search. */
function sizeValue(size: string): number | null {
  const r = RATIO.exec(size);
  if (r) return Number(r[1]) / Number(r[2]);
  const p = PIXELS.exec(size);
  if (p) return Number(p[1]) / Number(p[2]);
  return null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** "1024x576" → "16:9". Used to label pixel-only models in the picker. */
function ratioLabel(size: string): string | null {
  const p = PIXELS.exec(size);
  if (!p) return RATIO.test(size) ? size : null;
  const w = Number(p[1]), h = Number(p[2]);
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

export function poyoSizesFor(modelId: string): string[] {
  return POYO_MODEL_INPUTS[modelId]?.sizes ?? POYO_ASPECT_RATIOS;
}

/**
 * The size to send for a requested aspect ratio.
 *
 * Exact match when the model has one, otherwise the closest shape it does
 * offer — a 16:9 beat on gpt-4o-image becomes 3:2 rather than a 400. Closest
 * is measured on log ratio so 21:9 and 9:16 are equally far from 16:9 in the
 * direction they are actually wrong.
 */
export function poyoSizeFor(modelId: string, requested: string): string {
  const sizes = poyoSizesFor(modelId);
  if (sizes.includes(requested)) return requested;

  const want = sizeValue(requested);
  if (want === null) return sizes[0] ?? requested;

  let best: string | null = null;
  let bestGap = Infinity;
  for (const size of sizes) {
    const value = sizeValue(size);
    if (value === null) continue;
    const gap = Math.abs(Math.log(value / want));
    if (gap < bestGap) { bestGap = gap; best = size; }
  }
  return best ?? requested;
}

/** The ratios and resolutions to offer for a PoYo model, shaped like
 *  lib/kie/imageModels.ts's ModelConfig so the picker can take either.
 *  Pixel-only models are shown as the ratios their dimensions describe;
 *  poyoImageInput converts back on submit. */
export function poyoImageConfig(modelId: string): { aspectRatios: string[]; resolutions?: string[] } {
  const inputs = POYO_MODEL_INPUTS[modelId];
  const labels: string[] = [];
  for (const size of poyoSizesFor(modelId)) {
    const label = ratioLabel(size);
    if (label && !labels.includes(label)) labels.push(label);
  }
  // Both kinds of resolution control look the same to the user. Only the
  // request shape differs, which poyoImageInput handles.
  const resolutions = inputs?.resolutions
    ?? (inputs?.sizeResolutions ? Object.keys(inputs.sizeResolutions) : undefined);
  return { aspectRatios: labels.length ? labels : POYO_ASPECT_RATIOS, resolutions };
}

/** Round to a multiple of 16. Generators want dimensions on a grid, and the
 *  few pixels lost are invisible next to a wrong aspect ratio. */
function grid16(n: number): number {
  return Math.max(16, Math.round(n / 16) * 16);
}

/**
 * The size and resolution fields to send for this model.
 *
 * Three shapes, because PoYo does not have one:
 *   - most models: `size` as a ratio, plus `resolution` when they take one
 *   - grok-imagine-image-2.0: the same, but the ratio field is `aspect_ratio`
 *   - Seedream 4.5 / 5.0 Lite: no resolution field, its presets are values of
 *     `size`, so the two choices are combined into a custom WIDTHxHEIGHT
 *
 * An unsupported resolution is dropped rather than corrected. Unlike a ratio,
 * there is no near-miss worth guessing at, and the model's own default is a
 * better answer than a value it would reject.
 */
export function poyoImageInput(
  modelId: string,
  aspectRatio: string,
  resolution?: string | null,
): Record<string, string> {
  const inputs = POYO_MODEL_INPUTS[modelId];
  const size = poyoSizeFor(modelId, aspectRatio);

  const longEdge = resolution ? inputs?.sizeResolutions?.[resolution] : undefined;
  if (longEdge) {
    const ratio = sizeValue(size);
    // A model in this branch always spells its sizes as ratios, so `ratio` is
    // only null if the table is edited into an inconsistent state.
    if (ratio !== null) {
      const [w, h] = ratio >= 1
        ? [longEdge, grid16(longEdge / ratio)]
        : [grid16(longEdge * ratio), longEdge];
      return { size: `${w}x${h}` };
    }
  }

  const out: Record<string, string> = { [inputs?.sizeKey ?? "size"]: size };
  if (resolution && inputs?.resolutions?.includes(resolution)) out.resolution = resolution;
  return out;
}

/** The longest prompt this model will take, or null when it has never said. */
export function poyoPromptMax(modelId: string): number | null {
  return POYO_MODEL_INPUTS[modelId]?.promptMax ?? null;
}
