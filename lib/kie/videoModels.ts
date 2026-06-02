import type { KieModel } from "@/lib/types";

function m(id: string, name: string, tags: string[]): KieModel {
  return { id, name, type: "video", tags };
}

export const VIDEO_MODELS: KieModel[] = [
  m("bytedance/seedance-2",             "Seedance 2",       ["Image-to-Video", "ByteDance"]),
  m("kling-3.0/video",                  "Kling 3.0",        ["Latest", "Image-to-Video"]),
  m("veo3",                             "Veo 3",            ["Image-to-Video", "Google"]),
  m("veo3_fast",                        "Veo 3 Fast",       ["Image-to-Video", "Google", "Fast"]),
  m("sora-2-image-to-video",            "Sora 2",           ["Image-to-Video"]),
  m("wan/2-7-image-to-video",           "Wan 2.7",          ["Image-to-Video", "1080p"]),
  m("wan/2-6-flash-image-to-video",     "Wan 2.6 Flash",    ["Image-to-Video", "Fast", "720p / 1080p"]),
  m("hailuo/02-image-to-video-pro",     "Hailuo Pro",       ["Image-to-Video"]),
  m("kling-2.6/image-to-video",         "Kling 2.6",        ["Image-to-Video"]),
  m("grok-imagine/image-to-video",      "Grok Imagine",     ["Image-to-Video"]),
  m("bytedance/seedance-2-fast",        "Seedance 2 Fast",  ["Image-to-Video", "ByteDance", "Fast"]),
  m("bytedance/seedance-1.5-pro",       "Seedance 1.5 Pro", ["Image-to-Video", "ByteDance"]),
  m("runway",                           "Runway",           ["Image-to-Video"]),
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
  "kling-3.0/video":                  { durations: [3, 5, 8, 10, 12, 15].map(secStr), aspectRatios: ["16:9", "9:16", "1:1"] },
  "kling-2.6/image-to-video":         { durations: [5, 10].map(secStr),               aspectRatios: [] },
  "wan/2-7-image-to-video":           { durations: [3, 5, 8, 10, 15].map(sec),        aspectRatios: [] },
  "wan/2-6-flash-image-to-video":     { durations: [5, 10, 15].map(secStr),           aspectRatios: [] },
  "hailuo/02-image-to-video-pro":     { durations: [],                                aspectRatios: [] },
  "grok-imagine/image-to-video":      { durations: [6, 8, 10, 15, 20, 30].map(sec),   aspectRatios: [] },
  "sora-2-image-to-video":            { durations: [{ label: "10 frames", value: "10" }, { label: "15 frames", value: "15" }], durationKey: "n_frames", aspectRatios: [] },
  "veo3":                             { durations: [], endpoint: "/api/v1/veo/generate",    aspectRatios: ["16:9", "9:16", "1:1"] },
  "veo3_fast":                        { durations: [], endpoint: "/api/v1/veo/generate",    aspectRatios: ["16:9", "9:16", "1:1"] },
  "runway":                           { durations: [5, 10].map(sec), endpoint: "/api/v1/runway/generate", aspectRatios: ["16:9", "9:16"] },
  "bytedance/seedance-2":             { durations: [4, 5, 6, 8, 10, 12, 15].map(sec), aspectRatios: ["16:9", "9:16", "1:1"] },
  "bytedance/seedance-2-fast":        { durations: [4, 5, 6, 8, 10, 12, 15].map(sec), aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] },
  "bytedance/seedance-1.5-pro":       { durations: [{ label: "4s", value: "4" }, { label: "8s", value: "8" }, { label: "12s", value: "12" }], aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] },
};

export function getVideoModelConfig(modelId: string): VideoModelConfig {
  return VIDEO_MODEL_CONFIGS[modelId] ?? { durations: [sec(5)], aspectRatios: ["16:9"] };
}
