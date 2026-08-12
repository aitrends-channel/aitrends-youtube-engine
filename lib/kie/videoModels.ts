import type { KieModel } from "@/lib/types";
import { GENAIPRO_VIDEO_MODEL_ID } from "@/lib/genaipro/client";

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
  // Not a KIE model. It runs on Heclus's own GenAIPro account against the
  // credit wallet, submitted by /api/cron/genaipro-video rather than by the
  // video-worker. It lives in this list because this list is what the picker
  // renders; the models route only includes it for plans with an allowance.
  // The "Free" tag is what puts it under the picker's Free tab.
  m(GENAIPRO_VIDEO_MODEL_ID,            "Veo (free credits)", ["Free", "Image-to-Video", "Google"]),
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
  /** Supported values for the resolution / quality / mode enum on KIE.
   *  UI renders these as pills the same way image resolutions do. */
  resolutions?: string[];
  /** The KIE input field this model expects the resolution under.
   *  Defaults to "resolution" when omitted. kling-3.0 uses "mode",
   *  runway uses "quality". */
  resolutionKey?: string;
}

const sec = (n: number): DurationOption => ({ label: `${n}s`, value: n });
const secStr = (n: number): DurationOption => ({ label: `${n}s`, value: String(n) });

export const VIDEO_MODEL_CONFIGS: Record<string, VideoModelConfig> = {
  // GenAIPro's submit takes no duration and only two aspect ratios, so the
  // picker offers exactly what the provider accepts. 16:9 and 9:16 map onto
  // their LANDSCAPE / PORTRAIT enum.
  [GENAIPRO_VIDEO_MODEL_ID]:          { durations: [], aspectRatios: ["16:9", "9:16"] },
  // Kling 3.0 uses "mode" (std / pro / 4K) instead of a "resolution"
  // enum — the three modes map to 720p / 1080p / 4K under the hood.
  "kling-3.0/video":                  { durations: [3, 5, 8, 10, 12, 15].map(secStr), aspectRatios: ["16:9", "9:16", "1:1"], resolutions: ["std", "pro", "4K"], resolutionKey: "mode" },
  "kling-2.6/image-to-video":         { durations: [5, 10].map(secStr),               aspectRatios: [] },
  "wan/2-7-image-to-video":           { durations: [3, 5, 8, 10, 15].map(sec),        aspectRatios: [], resolutions: ["720p", "1080p"] },
  "wan/2-6-flash-image-to-video":     { durations: [5, 10, 15].map(secStr),           aspectRatios: [], resolutions: ["720p", "1080p"] },
  "hailuo/02-image-to-video-pro":     { durations: [],                                aspectRatios: [] },
  "grok-imagine/image-to-video":      { durations: [6, 8, 10, 15, 20, 30].map(sec),   aspectRatios: [], resolutions: ["480p", "720p"] },
  "sora-2-image-to-video":            { durations: [{ label: "10 frames", value: "10" }, { label: "15 frames", value: "15" }], durationKey: "n_frames", aspectRatios: [] },
  // Veo3's aspect enum is 16:9 / 9:16 / Auto — 1:1 is NOT supported;
  // Auto stays out of the UI to keep beat output size predictable.
  "veo3":                             { durations: [{ label: "4s", value: "4" }, { label: "6s", value: "6" }, { label: "8s", value: "8" }], endpoint: "/api/v1/veo/generate",    aspectRatios: ["16:9", "9:16"], resolutions: ["720p"] },
  "veo3_fast":                        { durations: [{ label: "4s", value: "4" }, { label: "6s", value: "6" }, { label: "8s", value: "8" }], endpoint: "/api/v1/veo/generate",    aspectRatios: ["16:9", "9:16"], resolutions: ["720p"] },
  // Runway's resolution enum is "quality" (720p / 1080p). KIE also
  // rejects 1080p when duration = 10s; we don't enforce that cross-
  // constraint in the picker — a 10s + 1080p submit will surface as
  // a KIE 400 in the beat error banner.
  "runway":                           { durations: [5, 10].map(sec), endpoint: "/api/v1/runway/generate", aspectRatios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], resolutionKey: "quality" },
  "bytedance/seedance-2":             { durations: [4, 5, 6, 8, 10, 12, 15].map(sec), aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], resolutions: ["480p", "720p", "1080p", "4k"] },
  "bytedance/seedance-2-fast":        { durations: [4, 5, 6, 8, 10, 12, 15].map(sec), aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], resolutions: ["480p", "720p"] },
  "bytedance/seedance-1.5-pro":       { durations: [{ label: "4s", value: "4" }, { label: "8s", value: "8" }, { label: "12s", value: "12" }], aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], resolutions: ["480p", "720p", "1080p"] },
};

export function getVideoModelConfig(modelId: string): VideoModelConfig {
  return VIDEO_MODEL_CONFIGS[modelId] ?? { durations: [sec(5)], aspectRatios: ["16:9"] };
}
