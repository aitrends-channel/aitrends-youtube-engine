import type { KieModel } from "@/lib/types";

function m(id: string, name: string, tags: string[]): KieModel {
  return { id, name, type: "video", tags };
}

export const VIDEO_MODELS: KieModel[] = [
  m("kling-3.0/video",             "Kling 3.0",         ["Latest", "I2V + T2V"]),
  m("kling-2.6/text-to-video",     "Kling 2.6 T2V",     ["Text-to-Video"]),
  m("kling-2.6/image-to-video",    "Kling 2.6 I2V",     ["Image-to-Video"]),
  m("wan/2-7-text-to-video",       "Wan 2.7 T2V",       ["Text-to-Video"]),
  m("wan/2-7-image-to-video",      "Wan 2.7 I2V",       ["Image-to-Video"]),
  m("hailuo/02-text-to-video-pro", "Hailuo Pro",        ["Text-to-Video"]),
  m("grok-imagine/image-to-video", "Grok Imagine",      ["Image-to-Video"]),
  m("sora-2-image-to-video",       "Sora 2",            ["Image-to-Video"]),
  m("veo3",                        "Veo 3",             ["T2V + I2V", "Google"]),
  m("veo3_fast",                   "Veo 3 Fast",        ["T2V + I2V", "Google", "Fast"]),
  m("runway",                      "Runway",            ["T2V + I2V"]),
  m("bytedance/seedance-2",        "Seedance 2",        ["ByteDance", "I2V + T2V"]),
];

export interface DurationOption {
  label: string;
  value: string | number;
}

export interface VideoModelConfig {
  durations: DurationOption[];
  aspectRatios: string[];
  durationKey?: string;
  endpoint?: string;
}

const sec = (n: number): DurationOption => ({ label: `${n}s`, value: n });
const secStr = (n: number): DurationOption => ({ label: `${n}s`, value: String(n) });

export const VIDEO_MODEL_CONFIGS: Record<string, VideoModelConfig> = {
  "kling-3.0/video":             { durations: [3, 5, 8, 10, 12, 15].map(secStr), aspectRatios: ["16:9", "9:16", "1:1"] },
  "kling-2.6/text-to-video":     { durations: [5, 10].map(secStr),               aspectRatios: ["16:9", "9:16", "1:1"] },
  "kling-2.6/image-to-video":    { durations: [5, 10].map(secStr),               aspectRatios: [] },
  "wan/2-7-text-to-video":       { durations: [3, 5, 8, 10, 15].map(sec),        aspectRatios: ["16:9", "9:16", "1:1"] },
  "wan/2-7-image-to-video":      { durations: [3, 5, 8, 10, 15].map(sec),        aspectRatios: [] },
  "hailuo/02-text-to-video-pro": { durations: [],                                aspectRatios: ["16:9", "9:16"] },
  "grok-imagine/image-to-video": { durations: [6, 8, 10, 15, 20, 30].map(sec),  aspectRatios: [] },
  "sora-2-image-to-video":       { durations: [{ label: "10 frames", value: "10" }, { label: "15 frames", value: "15" }], durationKey: "n_frames", aspectRatios: [] },
  "veo3":                        { durations: [], endpoint: "/api/v1/veo/generate",    aspectRatios: ["16:9", "9:16", "1:1"] },
  "veo3_fast":                   { durations: [], endpoint: "/api/v1/veo/generate",    aspectRatios: ["16:9", "9:16", "1:1"] },
  "runway":                      { durations: [5, 10].map(sec), endpoint: "/api/v1/runway/generate", aspectRatios: ["16:9", "9:16"] },
  "bytedance/seedance-2":        { durations: [4, 5, 6, 8, 10, 12, 15].map(sec), aspectRatios: ["16:9", "9:16", "1:1"] },
};

export function getVideoModelConfig(modelId: string): VideoModelConfig {
  return VIDEO_MODEL_CONFIGS[modelId] ?? { durations: [sec(5)], aspectRatios: ["16:9"] };
}
