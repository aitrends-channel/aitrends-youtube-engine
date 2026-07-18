import { supabase } from "@/lib/supabase/client";

// 1Click preference config — the user's saved answers to every wizard
// gate, so autopilot can run the whole pipeline unattended. Stored in
// one_click_configs.config (JSONB) with a version field; evolve fields
// here freely, bump CONFIG_VERSION when a breaking reshape happens.

export const CONFIG_VERSION = 1;

// Display name for the classic step-by-step wizard, shown next to
// "1Click" in the mode chooser. Kept as one constant so renaming the
// mode is a one-line change.
export const STUDIO_MODE_NAME = "Studio";

/** Model fallback chain: primary is tried first (with one retry),
 *  then secondary, then fallback, before the run flags
 *  needs_attention. secondary/fallback are optional. */
export interface ModelChain {
  primary: string;
  secondary?: string | null;
  fallback?: string | null;
}

export interface OneClickConfig {
  version: number;
  tts: {
    /** TTS model id (e.g. elevenlabs model) */
    modelId: string;
    voiceId: string;
  };
  /** Unified output format — images, videos, and assembly all inherit
   *  this so the final cut never letterboxes. Per-stage overrides can
   *  be added later without a migration. */
  output: {
    aspectRatio: string; // e.g. "16:9"
    resolution: string;  // e.g. "1080p" | "1K" | "2K"
  };
  images: ModelChain;
  videos: ModelChain & {
    /** Seconds per clip, from the video model's duration options. */
    duration?: number | string;
  };
  assemble: {
    bgMusicUrl: string | null;
    bgMusicVolume: number; // 0..1
    captionsEnabled: boolean;
    captionsLanguage?: string;
    captionsStyle?: string;
    captionsSize?: string;
    captionsPosition?: string;
    logoUrl: string | null;
    logoX: number;    // 0..1 fraction from left
    logoY: number;    // 0..1 fraction from top
    logoSize: number; // logo width as fraction of video width
  };
}

/** Starting values for the setup form. Model ids intentionally empty —
 *  the setup UI prefills them from the admin defaults (/api/kie/models)
 *  so the form always reflects the current recommended models. */
export function emptyConfig(): OneClickConfig {
  return {
    version: CONFIG_VERSION,
    tts: { modelId: "", voiceId: "" },
    // resolution uses the model pickers' tier values ("1K"/"2K"); the
    // orchestrator maps it to assembly output size.
    output: { aspectRatio: "16:9", resolution: "1K" },
    images: { primary: "", secondary: null, fallback: null },
    videos: { primary: "", secondary: null, fallback: null },
    assemble: {
      bgMusicUrl: null,
      bgMusicVolume: 0.15,
      captionsEnabled: false,
      logoUrl: null,
      logoX: 0.02,
      logoY: 0.02,
      logoSize: 0.1,
    },
  };
}

/** Validate a client-submitted config. Returns a normalized config or
 *  a string describing the first problem. Only the fields autopilot
 *  can't run without are hard-required. */
export function validateConfig(raw: unknown): OneClickConfig | string {
  if (typeof raw !== "object" || raw === null) return "Config must be an object";
  const c = raw as Partial<OneClickConfig>;
  if (!c.tts?.modelId?.trim() || !c.tts?.voiceId?.trim()) return "Pick a voiceover model and voice";
  if (!c.images?.primary?.trim()) return "Pick a primary image model";
  if (!c.videos?.primary?.trim()) return "Pick a primary video model";
  if (!c.output?.aspectRatio?.trim() || !c.output?.resolution?.trim()) return "Pick an output format";
  const vol = Number(c.assemble?.bgMusicVolume ?? 0.15);
  const clamp01 = (n: number, dflt: number) => (Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt);
  return {
    version: CONFIG_VERSION,
    tts: { modelId: c.tts.modelId.trim(), voiceId: c.tts.voiceId.trim() },
    output: { aspectRatio: c.output.aspectRatio.trim(), resolution: c.output.resolution.trim() },
    images: {
      primary: c.images.primary.trim(),
      secondary: c.images.secondary?.trim() || null,
      fallback: c.images.fallback?.trim() || null,
    },
    videos: {
      primary: c.videos.primary.trim(),
      secondary: c.videos.secondary?.trim() || null,
      fallback: c.videos.fallback?.trim() || null,
      duration: c.videos.duration ?? 5,
    },
    assemble: {
      bgMusicUrl: c.assemble?.bgMusicUrl?.trim() || null,
      bgMusicVolume: clamp01(vol, 0.15),
      captionsEnabled: Boolean(c.assemble?.captionsEnabled),
      captionsLanguage: c.assemble?.captionsLanguage?.trim() || undefined,
      captionsStyle: c.assemble?.captionsStyle?.trim() || undefined,
      captionsSize: c.assemble?.captionsSize?.trim() || undefined,
      captionsPosition: c.assemble?.captionsPosition?.trim() || undefined,
      logoUrl: c.assemble?.logoUrl?.trim() || null,
      logoX: clamp01(Number(c.assemble?.logoX ?? 0.02), 0.02),
      logoY: clamp01(Number(c.assemble?.logoY ?? 0.02), 0.02),
      logoSize: clamp01(Number(c.assemble?.logoSize ?? 0.1), 0.1),
    },
  };
}

/** The user's default 1Click preset, or null when they've never
 *  configured 1Click (the setup UI opens in that case). */
export async function getOneClickConfig(userId: string): Promise<OneClickConfig | null> {
  const { data, error } = await supabase
    .from("one_click_configs")
    .select("config")
    .eq("user_id", userId)
    .eq("is_default", true)
    .maybeSingle();
  if (error) {
    console.warn("[one-click] config fetch failed:", error.message);
    return null;
  }
  return (data?.config as OneClickConfig | undefined) ?? null;
}

export async function saveOneClickConfig(userId: string, config: OneClickConfig): Promise<void> {
  const { error } = await supabase
    .from("one_click_configs")
    .upsert(
      { user_id: userId, is_default: true, config, updated_at: new Date().toISOString() },
      { onConflict: "user_id", ignoreDuplicates: false },
    );
  if (error) throw new Error(error.message);
}
