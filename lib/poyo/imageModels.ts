import type { KieModel } from "@/lib/types";

// PoYo's image catalog, and what each generation costs in PoYo credits.
//
// The credit figures carry more weight here than they do for KIE. KIE reports
// creditsConsumed on a finished task, so the ledger records what was actually
// spent; PoYo's status response has no equivalent field, so a row in
// project_costs can only be as accurate as this table. Treat a wrong number
// here as a wrong number in the margin report, not just a wrong label.
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
// "Model not found" and are still withheld — PoYo sells these models but not
// under the name their catalog page displays, so the real strings have to come
// from the dashboard: kling-o1-image, flux-kontext, flux-2, qwen-image-3.0.
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
  m("nano-banana-2",     "Nano Banana 2",      5,    true, ["Google"]),
  m("nano-banana-2-lite","Nano Banana 2 Lite", 5,    true, ["Google", "Fast"]),
  m("nano-banana-pro",   "Nano Banana Pro",    8,    true, ["Google", "Pro"]),
  m("seedream-4",        "Seedream 4",         5,    true, ["ByteDance"]),
  m("seedream-4.5",      "Seedream 4.5",       5,    true, ["ByteDance"]),
  m("seedream-5.0-lite", "Seedream 5.0 Lite",  5,    true, ["ByteDance"]),
  m("seedream-5.0-pro",  "Seedream 5.0 Pro",   15,    true, ["ByteDance", "Max Quality"]),
  m("grok-imagine",      "Grok Imagine",       6,    true, ["xAI"]),
  m("grok-imagine-image-2.0", "Grok Imagine 2.0", 8,    true, ["xAI"]),
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

/** PoYo takes the aspect ratio as `size`, using the same "W:H" spelling the
 *  rest of the app already passes around, so no mapping table is needed. */
export const POYO_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"];
