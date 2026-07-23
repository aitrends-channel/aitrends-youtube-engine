import type { KieModel } from "@/lib/types";

function m(id: string, name: string, tags: string[]): KieModel {
  return { id, name, type: "image", tags };
}

export const IMAGE_MODELS: KieModel[] = [
  m("flux-kontext-pro",                    "Flux Kontext Pro",       ["High Quality"]),
  m("flux-kontext-max",                    "Flux Kontext Max",       ["Max Quality"]),
  m("flux-2/pro-text-to-image",            "Flux 2 Pro",             ["Fast"]),
  m("flux-2/flex-text-to-image",           "Flux 2 Flex",            ["Flexible"]),
  m("google/imagen4-ultra",                "Imagen 4 Ultra",         ["Google", "Ultra"]),
  m("nano-banana-2",                       "Nano Banana 2",          ["Google"]),
  m("nano-banana-pro",                     "Nano Banana Pro",        ["Google", "Pro"]),
  m("bytedance/seedream-v4-text-to-image", "Seedream 4.0",           ["ByteDance", "Latest"]),
  m("grok-imagine/text-to-image",          "Grok Imagine",           ["xAI"]),
  m("z-image",                             "Z-Image",                ["Stylized"]),
  m("gpt-image-2-text-to-image",           "GPT Image 2",            ["OpenAI"]),
];

// Free-tier image models — BYO (bring-your-own) providers the user connects
// with their own account, so they run on the user's free quota at no cost.
// Kept OUT of IMAGE_MODELS so they only surface under the picker's "Free"
// tab, never in the paid all/fastest/cheapest lists.
export const FREE_IMAGE_MODELS: KieModel[] = [
  {
    id: "cloudflare/flux-1-schnell",
    name: "FLUX Schnell",
    type: "image",
    tags: ["Free", "Fast"],
    description: "Free — fast distilled FLUX. Square output.",
  },
  {
    id: "cloudflare/sdxl-lightning",
    name: "SDXL Lightning",
    type: "image",
    tags: ["Free", "Fast", "Aspect ratios"],
    description: "Free — fast SDXL, supports aspect ratios.",
  },
  {
    id: "cloudflare/sdxl-base",
    name: "Stable Diffusion XL",
    type: "image",
    tags: ["Free", "Aspect ratios"],
    description: "Free — standard SDXL, supports aspect ratios.",
  },
  // NOTE: Gemini (gemini/flash-image) was briefly listed here but removed:
  // Google's API free tier has a hard limit of 0 image requests (verified
  // live July 2026) — every call 429s without billing enabled, so it can't
  // honestly sit in a "Free" tab.
];

export interface ModelConfig {
  aspectRatios: string[];
  resolutions?: string[];
}

export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  "flux-kontext-pro":                    { aspectRatios: ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"] },
  "flux-kontext-max":                    { aspectRatios: ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"] },
  "flux-2/pro-text-to-image":            { aspectRatios: ["16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"],        resolutions: ["1K", "2K"] },
  "flux-2/flex-text-to-image":           { aspectRatios: ["16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"],        resolutions: ["1K", "2K"] },
  "google/imagen4-ultra":                { aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16"] },
  "nano-banana-2":                       { aspectRatios: ["16:9", "21:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16", "4:1", "1:4", "8:1", "1:8"], resolutions: ["1K", "2K", "4K"] },
  "nano-banana-pro":                     { aspectRatios: ["16:9", "21:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"], resolutions: ["1K", "2K", "4K"] },
  "bytedance/seedream-v4-text-to-image": { aspectRatios: ["16:9", "3:2", "4:3", "1:1 HD", "1:1", "2:3", "3:4", "9:16", "21:9"], resolutions: ["1K", "2K", "4K"] },
  "grok-imagine/text-to-image":          { aspectRatios: ["16:9", "3:2", "1:1", "2:3", "9:16"] },
  "z-image":                             { aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16"] },
  // KIE lists this model with three billing tiers (1K / 2K / 4K) — the
  // resolution is a single "input.resolution" field, not part of the
  // model id. Ratios below are the intersection of KIE's supported set
  // and what stays valid at 2K/4K (5:4, 4:5, 3:1, 1:3, 9:21 are 1K-only
  // and dropped; 1:1 4K is rejected by KIE but 1:1 stays for 1K/2K).
  "gpt-image-2-text-to-image":           { aspectRatios: ["16:9", "21:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16", "2:1", "1:2"], resolutions: ["1K", "2K", "4K"] },
  // Cloudflare free models. FLUX Schnell takes only { prompt, steps } →
  // square output. The SDXL models accept width/height, so they support
  // real aspect ratios. No resolution tiers on the free tier.
  "cloudflare/flux-1-schnell":           { aspectRatios: ["1:1"] },
  "cloudflare/sdxl-lightning":           { aspectRatios: ["16:9", "1:1", "9:16", "4:3", "3:4"] },
  "cloudflare/sdxl-base":                { aspectRatios: ["16:9", "1:1", "9:16", "4:3", "3:4"] },
};

export function getModelConfig(modelId: string): ModelConfig {
  return MODEL_CONFIGS[modelId] ?? { aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16"] };
}

export const IMAGE_SIZE_MAP: Record<string, string> = {
  "16:9":   "landscape_16_9",
  "3:2":    "landscape_3_2",
  "4:3":    "landscape_4_3",
  "1:1 HD": "square_hd",
  "1:1":    "square",
  "3:4":    "portrait_4_3",
  "2:3":    "portrait_3_2",
  "9:16":   "portrait_16_9",
  "21:9":   "landscape_21_9",
};

export const IMAGE_SIZE_MODELS = new Set([
  "bytedance/seedream-v4-text-to-image",
]);
