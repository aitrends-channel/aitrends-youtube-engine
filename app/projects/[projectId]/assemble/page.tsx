"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { StepCostCard } from "@/components/StepCostCard";
import { CostTipsModal } from "@/components/CostTipsModal";
import { StepBalanceCard } from "@/components/StepBalanceCard";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import { Volume2, VolumeX, Play, Pause, ChevronDown, ChevronRight, Ban } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { Beat } from "@/lib/types";
import { FullVoiceoverPreview } from "@/components/voiceover/FullVoiceoverPreview";
import { presignedUpload } from "@/lib/upload-client";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { SubscriptionModal } from "@/components/SubscriptionModal";
import { PRO_RESOLUTIONS, PRO_TIER_PLANS } from "@/lib/plans-gating";
import { isAdminUser } from "@/lib/admin";

interface PageProps {
  params: { projectId: string };
}

const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:5", "4:3", "3:4", "21:9"] as const;
type AspectRatio = typeof ASPECT_RATIOS[number];

// Pro-tier resolution gate constants live in lib/plans-gating so the
// UI here and the assemble POST endpoint share one source of truth.

const RESOLUTION_PRESETS = ["720p", "1080p", "1440p", "2160p"] as const;
type ResolutionPreset = typeof RESOLUTION_PRESETS[number];

// Per-preset short/long edge sizes. Vertical (9:16) uses short as
// width, square uses short on both axes, horizontal uses long×short.
// Matches the dimsFor() implementation server-side.
const RESOLUTION_EDGES: Record<ResolutionPreset, { long: number; short: number }> = {
  "720p":  { long: 1280, short: 720 },
  "1080p": { long: 1920, short: 1080 },
  "1440p": { long: 2560, short: 1440 },
  "2160p": { long: 3840, short: 2160 },
};

// Generic aspect-ratio → pixel dims. The resolution preset's `short`
// edge is held constant (so "1080p" is 1080 on the short side for any
// ratio — 1920×1080 landscape, 1080×1920 portrait, 1080×1080 square,
// matching platform conventions); the long edge is derived from the
// ratio and rounded to even (ffmpeg requires even dimensions).
function dimsFor(aspect: AspectRatio, preset: ResolutionPreset): { w: number; h: number; label: string } {
  const { long, short } = RESOLUTION_EDGES[preset];
  const [wr, hr] = aspect.split(":").map(Number);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  let w: number, h: number;
  if (!wr || !hr) { w = long; h = short; }                 // malformed → 16:9
  else if (wr === hr) { w = short; h = short; }            // square
  else if (wr > hr) { h = short; w = even((short * wr) / hr); }  // landscape
  else { w = short; h = even((short * hr) / wr); }         // portrait
  return { w, h, label: `${w} × ${h}` };
}

const CAPTION_LANGUAGES = [
  { code: "source", label: "Source language" },
  { code: "Spanish", label: "Spanish" },
  { code: "French", label: "French" },
  { code: "Portuguese", label: "Portuguese" },
  { code: "German", label: "German" },
  { code: "Italian", label: "Italian" },
  { code: "Japanese", label: "Japanese" },
  { code: "Korean", label: "Korean" },
  { code: "Chinese", label: "Chinese" },
  { code: "Hindi", label: "Hindi" },
  { code: "Arabic", label: "Arabic" },
] as const;

const IMAGE_MOTIONS = [
  // None first, because it is what every existing project already does and
  // what the setting defaults to. Auto next: a hundred beats all pushing the
  // same way reads as a filter rather than as camera work.
  { id: "none",     label: "None",     hint: "Hold the frame" },
  { id: "auto",     label: "Auto",     hint: "Alternate in and out" },
  { id: "random",   label: "Random",   hint: "A different effect per image" },
  { id: "zoom-in",  label: "Zoom in",  hint: "Push slowly in" },
  { id: "zoom-out", label: "Zoom out", hint: "Pull slowly out" },
  { id: "pan-right", label: "Pan right", hint: "Slide across, zoom held" },
  { id: "pan-left",  label: "Pan left",  hint: "Slide back, zoom held" },
  { id: "drift",     label: "Drift",     hint: "Push in while sliding" },
];

/** What a single beat can be set to in the timeline. The first entry clears the
 *  override and returns that beat to the project's setting. */
/** Pixels per second of narration, at each zoom step.
 *
 *  Forty is the default: a four-second beat is 160px, wide enough to recognise
 *  the thumbnail inside it and narrow enough that a ten-minute video is a
 *  scroll rather than a marathon. Eight fits roughly ten minutes on a laptop
 *  screen; 120 is close enough to inspect a one-second beat. */
function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const ZOOM_STEPS = [8, 14, 22, 40, 70, 120];

/** Words a narrator gets through in a second. Used only to estimate a beat's
 *  length before its voiceover exists — the real figure replaces it the moment
 *  the audio is generated. Two and a half is the rate the beats prompt is
 *  written against. */
const WORDS_PER_SECOND = 2.5;

/** How long a beat runs: measured if the voiceover exists, estimated from its
 *  narration if not, and a plain guess if it has neither.
 *
 *  Without this the whole strip collapsed. Width is duration, and a project
 *  with no voiceover has no durations, so every block fell to the minimum and
 *  the timeline became a row of slivers with a 0s ruler. */
function beatSeconds(b: Beat): { seconds: number; estimated: boolean } {
  if (b.voiceoverDurationMs) return { seconds: b.voiceoverDurationMs / 1000, estimated: false };
  const words = (b.scriptSegment ?? "").trim().split(/\s+/).filter(Boolean).length;
  if (words > 0) return { seconds: Math.max(1, words / WORDS_PER_SECOND), estimated: true };
  return { seconds: 3, estimated: true };
}
const DEFAULT_ZOOM = 3;

/** How far each strength travels, as a share of the frame. Mirrors
 *  MOTION_TRAVEL in the worker: if these drift apart the preview lies. */
const MOTION_STRENGTHS = [
  { id: "gentle", label: "Gentle", hint: "8% of the frame", travel: 0.08 },
  { id: "normal", label: "Normal", hint: "15% of the frame", travel: 0.15 },
  { id: "strong", label: "Strong", hint: "25% of the frame", travel: 0.25 },
];

/** The preview animation for each, matching what the assembler renders. */
/** The CSS for the grade in force, at the strength in force. */
function gradeCss(id: string, strength: number): string {
  const f = VIDEO_FILTERS.find((x) => x.id === id);
  return f ? f.css(Math.max(0, Math.min(1, strength))) : "none";
}

/** The sound library, synthesised by the worker's scripts/make-sfx.sh and
 *  copied into public/sfx so the browser can play the same files. */
const SOUND_EFFECTS = [
  { id: "whoosh",   label: "Whoosh",   hint: "Something passing the camera" },
  { id: "swish",    label: "Swish",    hint: "Shorter and higher, for a cut" },
  { id: "sweep",    label: "Sweep",    hint: "Long, for a full cross-fade" },
  { id: "click",    label: "Click",    hint: "A tick, the length of a keystroke" },
  { id: "pop",      label: "Pop",      hint: "A rounded click with a pitch" },
  { id: "zoom-in",  label: "Zoom in",  hint: "A tone sweeping up" },
  { id: "zoom-out", label: "Zoom out", hint: "The same sweep, downward" },
  { id: "riser",    label: "Riser",    hint: "Noise climbing to a reveal" },
  { id: "impact",   label: "Impact",   hint: "A low hit with a short tail" },
  { id: "thud",     label: "Thud",     hint: "Softer, for something landing" },
  { id: "chime",    label: "Chime",    hint: "Two tones, for a point made" },
] as const;

/** The vignette the render draws, approximated for the preview. */
const VIGNETTE_SHADOW = "radial-gradient(ellipse at center, transparent 45%, oklch(0 0 0 / 0.55) 100%)";

/** Colour grades, with the CSS that stands in for each in the browser. The
 *  render uses ffmpeg's own chain; these are close enough to choose by. */
const VIDEO_FILTERS = [
  { id: "none",      label: "None",      css: () => "none" },
  { id: "warm",      label: "Warm",      css: (k: number) => `sepia(${0.28 * k}) saturate(${1 + 0.15 * k}) hue-rotate(${-8 * k}deg)` },
  { id: "cool",      label: "Cool",      css: (k: number) => `hue-rotate(${12 * k}deg) saturate(${1 + 0.05 * k}) brightness(${1 + 0.02 * k})` },
  { id: "vivid",     label: "Vivid",     css: (k: number) => `saturate(${1 + 0.35 * k}) contrast(${1 + 0.08 * k})` },
  { id: "muted",     label: "Muted",     css: (k: number) => `saturate(${1 - 0.28 * k}) contrast(${1 - 0.02 * k})` },
  { id: "mono",      label: "Mono",      css: (k: number) => `grayscale(${k}) contrast(${1 + 0.05 * k})` },
  { id: "sepia",     label: "Sepia",     css: (k: number) => `sepia(${0.85 * k})` },
  { id: "vintage",   label: "Vintage",   css: (k: number) => `sepia(${0.35 * k}) contrast(${1 - 0.1 * k}) saturate(${1 - 0.15 * k}) brightness(${1 + 0.05 * k})` },
  { id: "faded",     label: "Faded",     css: (k: number) => `contrast(${1 - 0.15 * k}) brightness(${1 + 0.08 * k}) saturate(${1 - 0.1 * k})` },
  { id: "punch",     label: "Punch",     css: (k: number) => `contrast(${1 + 0.25 * k}) saturate(${1 + 0.08 * k})` },
  { id: "cinematic", label: "Cinematic", css: (k: number) => `contrast(${1 + 0.12 * k}) saturate(${1 + 0.08 * k}) hue-rotate(${-6 * k}deg)` },
  { id: "noir",      label: "Noir",      css: (k: number) => `grayscale(${k}) contrast(${1 + 0.4 * k})` },
  { id: "golden",    label: "Golden",    css: (k: number) => `sepia(${0.32 * k}) saturate(${1 + 0.3 * k}) hue-rotate(${-14 * k}deg) brightness(${1 + 0.04 * k})` },
  { id: "bleach",    label: "Bleach",    css: (k: number) => `saturate(${1 - 0.65 * k}) contrast(${1 + 0.35 * k})` },
  { id: "cross",     label: "Cross",     css: (k: number) => `hue-rotate(${-14 * k}deg) saturate(${1 + 0.4 * k}) contrast(${1 + 0.15 * k})` },
  { id: "matte",     label: "Matte",     css: (k: number) => `contrast(${1 - 0.08 * k}) brightness(${1 + 0.05 * k}) saturate(${1 - 0.15 * k}) sepia(${0.08 * k})` },
  { id: "night",     label: "Night",     css: (k: number) => `brightness(${1 - 0.15 * k}) saturate(${1 - 0.1 * k}) hue-rotate(${12 * k}deg) contrast(${1 + 0.05 * k})` },
  { id: "pastel",    label: "Pastel",    css: (k: number) => `saturate(${1 - 0.15 * k}) brightness(${1 + 0.06 * k}) contrast(${1 - 0.08 * k})` },
  // Not a colour change: darkened corners, drawn as a shadow because CSS has
  // no vignette function.
  { id: "vignette",  label: "Vignette",  css: () => "none" },
] as const;

/** What happens at every beat boundary. Hard cut first: it is what every
 *  assembly has done, and a cut is the one join a viewer does not notice. */
const TRANSITIONS = [
  { id: "none",          label: "Cut",           hint: "Straight to the next shot" },
  { id: "dissolve",      label: "Dissolve",      hint: "One fades into the other" },
  { id: "fade-black",    label: "Through black", hint: "Out to black, then in" },
  { id: "fade-white",    label: "Through white", hint: "Out to white, then in" },
  { id: "fade-grays",    label: "Through grey",  hint: "Colour drains, then returns" },
  { id: "slide-left",    label: "Slide left",    hint: "The next shot pushes in from the right" },
  { id: "slide-up",      label: "Slide up",      hint: "The next shot pushes in from below" },
  { id: "wipe-right",    label: "Wipe",          hint: "A hard edge crosses the frame" },
  { id: "wipe-up",       label: "Wipe up",       hint: "A hard edge rises up the frame" },
  { id: "wipe-diagonal", label: "Diagonal",      hint: "The edge crosses from the corner" },
  { id: "smooth-right",  label: "Soft wipe",     hint: "A wipe with a feathered edge" },
  { id: "circle-open",   label: "Circle in",     hint: "The old shot closes to a point" },
  { id: "circle-close",  label: "Circle out",    hint: "The new shot opens from a point" },
  { id: "zoom",          label: "Zoom",          hint: "The old shot rushes past the camera" },
  { id: "pixelize",      label: "Pixelate",      hint: "Both shots break into blocks" },
  { id: "blur",          label: "Blur",          hint: "Out of focus and back" },
  { id: "grain",         label: "Scatter",       hint: "Pixels swap over at random" },
] as const;

const SEAM_ANIMATION: Record<string, string> = {
  dissolve: "seam-dissolve 3s ease-in-out infinite",
  "fade-black": "seam-fade-black 3s ease-in-out infinite",
  "fade-white": "seam-fade-white 3s ease-in-out infinite",
  "fade-grays": "seam-fade-grays 3s ease-in-out infinite",
  "slide-left": "seam-slide-left 3s ease-in-out infinite",
  "slide-up": "seam-slide-up 3s ease-in-out infinite",
  "wipe-right": "seam-wipe-right 3s ease-in-out infinite",
  "wipe-up": "seam-wipe-up 3s ease-in-out infinite",
  "wipe-diagonal": "seam-wipe-diagonal 3s ease-in-out infinite",
  "smooth-right": "seam-smooth-right 3s ease-in-out infinite",
  "circle-open": "seam-circle-open 3s ease-in-out infinite",
  // Circle out reveals the incoming shot, so the animation runs on the layer
  // underneath rather than on the one leaving.
  "circle-close": "seam-circle-close 3s ease-in-out infinite",
  zoom: "seam-zoom 3s ease-in-out infinite",
  pixelize: "seam-pixelize 3s ease-in-out infinite",
  blur: "seam-blur 3s ease-in-out infinite",
  grain: "seam-grain 3s ease-in-out infinite",
};

/**
 * The same transitions again, as a function of progress rather than as a
 * keyframe loop. Playback needs this: the seam has to happen at the moment the
 * playhead reaches it, over the length the render will use, not on a 3s loop of
 * its own. Applied to the outgoing frame, with the incoming one underneath.
 */
function seamStyle(kind: string, p: number): React.CSSProperties {
  const pct = `${(p * 100).toFixed(1)}%`;
  switch (kind) {
    case "dissolve":     return { opacity: 1 - p };
    // Two halves: out to the colour by the midpoint, then the layer goes.
    case "fade-black":   return { filter: `brightness(${Math.max(0, 1 - p * 2)})`, opacity: p < 0.5 ? 1 : 0 };
    case "fade-white":   return { filter: `brightness(${1 + p * 5})`, opacity: p < 0.5 ? 1 : 0 };
    case "fade-grays":   return { filter: `saturate(${Math.max(0, 1 - p * 2)})`, opacity: 1 - p };
    case "slide-left":   return { transform: `translateX(-${pct})` };
    case "slide-up":     return { transform: `translateY(-${pct})` };
    case "wipe-right":   return { clipPath: `inset(0 0 0 ${pct})` };
    case "wipe-up":      return { clipPath: `inset(${pct} 0 0 0)` };
    case "wipe-diagonal":return { clipPath: `polygon(0 0, ${(200 - p * 200).toFixed(1)}% 0, 0 ${(200 - p * 200).toFixed(1)}%)` };
    case "smooth-right": return { ...SEAM_MASK["smooth-right"], WebkitMaskPosition: pct, maskPosition: pct };
    case "circle-open":  return { clipPath: `circle(${((1 - p) * 75).toFixed(1)}% at 50% 50%)` };
    case "circle-close": return { ...SEAM_MASK["circle-close"], WebkitMaskSize: `${(p * 300).toFixed(0)}% ${(p * 300).toFixed(0)}%`, maskSize: `${(p * 300).toFixed(0)}% ${(p * 300).toFixed(0)}%` };
    case "zoom":         return { transform: `scale(${1 + p * 1.2})`, opacity: 1 - p };
    // No CSS for pixelate or a random pixel swap; blur stands in for both, and
    // for the blur transition it is the real thing.
    case "pixelize":     return { filter: `blur(${(p * 10).toFixed(1)}px) contrast(${1 + p * 0.6})`, opacity: 1 - p * 0.9 };
    case "blur":         return { filter: `blur(${(p * 8).toFixed(1)}px)`, opacity: 1 - p };
    case "grain":        return { opacity: 1 - p, filter: `contrast(${1 + p * 0.6})` };
    default:             return { opacity: 1 - p };
  }
}

/** The soft wipe animates a mask, which has to be declared on the element. */
const SEAM_MASK: Record<string, React.CSSProperties> = {
  "smooth-right": {
    WebkitMaskImage: "linear-gradient(to right, transparent 0%, black 35%)",
    maskImage: "linear-gradient(to right, transparent 0%, black 35%)",
    WebkitMaskSize: "300% 100%",
    maskSize: "300% 100%",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
  },
  // A hole that grows: the outgoing shot is masked out from the centre while
  // the incoming one shows through it.
  "circle-close": {
    WebkitMaskImage: "radial-gradient(circle, transparent 49%, black 50%)",
    maskImage: "radial-gradient(circle, transparent 49%, black 50%)",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
  },
};

const MOTION_ANIMATION: Record<string, string> = {
  "zoom-in": "ken-burns-in 4s linear infinite",
  "zoom-out": "ken-burns-out 4s linear infinite",
  "pan-right": "ken-burns-pan-right 4s linear infinite",
  "pan-left": "ken-burns-pan-left 4s linear infinite",
  drift: "ken-burns-drift 4s linear infinite",
  // Auto varies between beats, which one frame cannot show. Playing a move out
  // and back is the closest honest picture of "these will differ".
  auto: "ken-burns-in 4s linear infinite alternate",
};

/** What Random draws from, mirroring RANDOM_POOL in the worker. The preview
 *  walks it so "a different effect per image" is shown rather than described. */
const RANDOM_POOL = ["zoom-in", "zoom-out", "pan-right", "pan-left", "drift"];

const CAPTION_STYLES = [
  { id: "classic", label: "Classic", hint: "White, black outline" },
  { id: "bold",    label: "Bold",    hint: "Yellow, bold" },
  { id: "boxed",   label: "Boxed",   hint: "White on dark box" },
  { id: "minimal", label: "Minimal", hint: "White, thin outline" },
] as const;

const CAPTION_SIZES     = [{ id: "small", label: "S" }, { id: "medium", label: "M" }, { id: "large", label: "L" }] as const;
const CAPTION_POSITIONS = [{ id: "bottom", label: "Bottom" }, { id: "top", label: "Top" }] as const;

export default function AssemblePage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project, mutate } = useProject(projectId);

  const beats: Beat[] = project?.beats ?? [];
  const ttsUrl: string | null = project?.tts_url ?? null;
  const ttsCleanedUrl: string | null = project?.tts_cleaned_url ?? null;
  const generatedVideos = beats.filter((b) => b.videoUrl).length;
  // Beats the assembler will render from a still image, because they have a
  // picture and no clip. These are the only ones image movement applies to.
  // What the project-wide effect applies to: clips included, since they follow
  // it like anything else.
  const movableBeats = beats.filter((b) => b.imageUrl || b.videoUrl).length;

  const videoBeats = beats.filter((b) => b.videoPrompt).length;

  // Bump current_state to 15 the first time the user lands here so the
  // Generate step ticks done in the WizardNav. No-op on subsequent visits.
  useEffect(() => {
    const reached = project?.current_state as number | undefined;
    if (reached !== undefined && reached < 15) {
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_state: 15 }),
      }).then(() => mutate()).catch(() => { /* non-blocking */ });
    }
  }, [project?.current_state, projectId, mutate]);


  // Hydrate BGM, logo, trim-silence, and the five caption knobs from
  // the project row on first load. Migrations 047 (BGM + logo) and 051
  // (trim + captions) backed these columns; /api/generate/assemble
  // writes them when the user clicks Assemble. The ref guard runs this
  // exactly once per mount so later SWR polls don't clobber in-
  // progress local edits (e.g. a slider tweak mid-session). NULL on
  // any column means the project pre-dates that migration or never
  // assembled — fall through to the React-side default in that case.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!project || hydratedRef.current) return;
    hydratedRef.current = true;
    const bgmUrl = project.background_music_url as string | null | undefined;
    if (bgmUrl) {
      setBgmUploadedUrl(bgmUrl);
      const v = project.background_music_volume;
      if (typeof v === "number") setBgmVolume(v);
    }
    const lUrl = project.logo_url as string | null | undefined;
    if (lUrl) {
      setLogoUploadedUrl(lUrl);
      const x = project.logo_x, y = project.logo_y, s = project.logo_size;
      if (typeof x === "number") setLogoX(x);
      if (typeof y === "number") setLogoY(y);
      if (typeof s === "number") setLogoSize(s);
    }
    // Default the output aspect ratio to the project's actual video
    // ratio so the logo-placement preview (and the render) match the
    // clips instead of always assuming 16:9. The user can still override
    // it with the selector.
    const projAspect = (project as { video_aspect_ratio?: string | null }).video_aspect_ratio;
    if (typeof projAspect === "string" && (ASPECT_RATIOS as readonly string[]).includes(projAspect)) {
      setAspectRatio(projAspect as AspectRatio);
    }
    const trim = (project as { trim_silence_enabled?: boolean | null }).trim_silence_enabled;
    if (typeof trim === "boolean") setTrimSilence(trim);
    const cap = project as {
      captions_enabled?:  boolean | null;
      captions_language?: string  | null;
      captions_style?:    string  | null;
      captions_size?:     string  | null;
      captions_position?: string  | null;
      video_filter?:      string  | null;
      video_filter_strength?: number | null;
      sfx_volume?: number | null;
      transition?:        string  | null;
      transition_seconds?: number | null;
      image_motion?:      string  | null;
      image_motion_seconds?: number | null;
      image_motion_strength?: string | null;
    };
    if (typeof cap.captions_enabled  === "boolean") setCaptionsEnabled(cap.captions_enabled);
    if (typeof cap.captions_language === "string" && cap.captions_language) setCaptionsLanguage(cap.captions_language);
    if (typeof cap.captions_style    === "string" && cap.captions_style)    setCaptionsStyle(cap.captions_style);
    if (typeof cap.captions_size     === "string" && cap.captions_size)     setCaptionsSize(cap.captions_size);
    if (typeof cap.captions_position === "string" && cap.captions_position) setCaptionsPosition(cap.captions_position);
    if (typeof cap.video_filter      === "string" && cap.video_filter)      setVideoFilter(cap.video_filter);
    if (typeof cap.video_filter_strength === "number")                      setVideoFilterStrength(cap.video_filter_strength);
    if (typeof cap.sfx_volume        === "number")                          setSfxVolume(cap.sfx_volume);
    if (typeof cap.transition        === "string" && cap.transition)        setTransition(cap.transition);
    if (typeof cap.transition_seconds === "number" && cap.transition_seconds > 0) setTransitionSeconds(cap.transition_seconds);
    if (typeof cap.image_motion      === "string" && cap.image_motion)      setImageMotion(cap.image_motion);
    if (typeof cap.image_motion_seconds === "number")                       setImageMotionSeconds(cap.image_motion_seconds);
    if (typeof cap.image_motion_strength === "string" && cap.image_motion_strength) setImageMotionStrength(cap.image_motion_strength);
  }, [project]);

  // "Use this always": per-user saved bg-music + logo defaults, tracked
  // INDEPENDENTLY (each control has its own toggle). On a fresh project
  // (no bgm/logo of its own) with a default enabled, prefill it so the user
  // doesn't re-select every video.
  const [useAlwaysBgm, setUseAlwaysBgm] = useState(false);
  const [useAlwaysLogo, setUseAlwaysLogo] = useState(false);
  const defaultsFetchedRef = useRef(false);
  useEffect(() => {
    if (!project || defaultsFetchedRef.current) return;
    defaultsFetchedRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/me/assembly-defaults");
        const { defaults } = (await res.json()) as { defaults: null | { bgmEnabled: boolean; logoEnabled: boolean; backgroundMusicUrl: string | null; backgroundMusicVolume: number; logoUrl: string | null; logoX: number; logoY: number; logoSize: number } };
        if (!defaults) return;
        setUseAlwaysBgm(!!defaults.bgmEnabled);
        setUseAlwaysLogo(!!defaults.logoEnabled);
        // Prefill only what's enabled AND the project hasn't set itself.
        if (defaults.bgmEnabled && !project.background_music_url && defaults.backgroundMusicUrl) {
          setBgmUploadedUrl(defaults.backgroundMusicUrl);
          if (typeof defaults.backgroundMusicVolume === "number") setBgmVolume(defaults.backgroundMusicVolume);
        }
        if (defaults.logoEnabled && !project.logo_url && defaults.logoUrl) {
          setLogoUploadedUrl(defaults.logoUrl);
          if (typeof defaults.logoX === "number") setLogoX(defaults.logoX);
          if (typeof defaults.logoY === "number") setLogoY(defaults.logoY);
          if (typeof defaults.logoSize === "number") setLogoSize(defaults.logoSize);
        }
      } catch { /* defaults are best-effort */ }
    })();
  }, [project]);

  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  // Render resolution. Default 1080p (matches YouTube's HD standard
  // and the dimensions previously displayed in the Output card).
  const [selectedResolution, setSelectedResolution] = useState<ResolutionPreset>("1080p");

  // Pro-tier gate for 1440p / 2160p. We look up app_metadata.plan
  // once on mount via the browser Supabase client — same pattern as
  // the dashboard. Defaults to "starter" so the UI gates Pro-only
  // presets while the fetch is in flight; if the user actually has
  // Pro the buttons flip enabled within a tick. Admins bypass.
  const [userPlan, setUserPlan] = useState<string>("starter");
  const [userEmail, setUserEmail] = useState<string>("");
  // Drives the SubscriptionModal when a non-Pro user clicks a
  // Pro-locked resolution. SubscriptionModal is mounted lazily —
  // most assemble sessions never need it.
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const client = createSupabaseBrowserClient();
    client.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      const meta = (data.user?.app_metadata ?? {}) as { plan?: unknown };
      // isAdminUser folds in both the app_metadata.is_admin flag AND
      // the legacy hardcoded ADMIN_EMAILS backstop — otherwise the
      // founder admin (recognised by email) would fail canUsePro and
      // get locked out of 4K assemble.
      if (isAdminUser(data.user)) {
        setUserPlan("admin");
      } else if (typeof meta.plan === "string" && meta.plan.trim()) {
        setUserPlan(meta.plan.trim().toLowerCase());
      }
      if (data.user?.email) setUserEmail(data.user.email);
    }).catch(() => { /* leave default */ });
    return () => { cancelled = true; };
  }, []);
  const canUsePro = PRO_TIER_PLANS.has(userPlan);
  // Per-preview loading state — true while either A/B card is still
  // building on the server or buffering audio in the browser. Drives
  // the "Loading previews…" indicator under the Voiceover Source label.
  // Default true so the indicator paints from first render whenever
  // there are voiceovers to preview, instead of flickering on after
  // the child cards mount and report back.
  const [trimmedLoading, setTrimmedLoading] = useState(true);
  const [originalLoading, setOriginalLoading] = useState(true);

  // Per-beat silence trim — drives the worker's trimSilenceEnabled flag.
  // Outgoing requests hard-code voiceoverType to "original" so the
  // worker's legacy-mode source-mp3 picker (tts_url ?? tts_cleaned_url)
  // prefers the freshest voiceover. Defaulting to "cleaned" silently
  // resurrected stale tts_cleaned_url files from the old "Trim to
  // video length" flow — users heard a voiceover they didn't recognize.
  // In per-beat mode (current default) voiceoverType is ignored anyway.
  const [trimSilence, setTrimSilence] = useState<boolean>(true);
  // Optional background music. The file gets uploaded to storage on
  // first assemble (via /api/upload) and the resulting public URL is
  // sent to the worker. backgroundMusicVolume is a 0–1 multiplier the
  // worker applies in ffmpeg's amix filter — 0.15 is the classic
  // "podcast bed" level that keeps voiceover crisp.
  const [bgmFile, setBgmFile] = useState<File | null>(null);
  const [bgmUploadedUrl, setBgmUploadedUrl] = useState<string | null>(null);
  const [bgmVolume, setBgmVolume] = useState<number>(0.15);
  // The level to come back to. Muting writes 0, which is what the worker reads,
  // so without this unmuting would guess rather than restore.
  const bgmLevelBeforeMute = useRef<number>(0.15);
  // Inline preview playback for the uploaded/selected background music.
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const [bgmPlaying, setBgmPlaying] = useState(false);
  const [bgmUploading, setBgmUploading] = useState(false);
  const bgmInputRef = useRef<HTMLInputElement>(null);
  // Channel logo overlay. logoX/logoY are top-left position as a
  // fraction of video dimensions (0–1); logoSize is logo width as a
  // fraction of video width. Same upload model as bgm — local file →
  // blob URL for the drag preview, then uploaded to storage on
  // assemble. Defaults put the logo in the top-right corner at 10%
  // width (classic YouTube watermark placement).
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoUploadedUrl, setLogoUploadedUrl] = useState<string | null>(null);
  const [logoObjectUrl, setLogoObjectUrl] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoX, setLogoX] = useState<number>(0.85);
  const [logoY, setLogoY] = useState<number>(0.05);
  const [logoSize, setLogoSize] = useState<number>(0.1);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Persist the user's "Use this always" defaults. bgm and logo have
  // independent toggles; every write sends both current enabled flags plus
  // the current values.
  function persistAssemblyDefaults(bgmEnabled: boolean, logoEnabled: boolean) {
    void fetch("/api/me/assembly-defaults", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bgmEnabled,
        logoEnabled,
        backgroundMusicUrl: bgmUploadedUrl,
        backgroundMusicVolume: bgmVolume,
        logoUrl: logoUploadedUrl,
        logoX, logoY, logoSize,
      }),
    }).catch(() => {});
  }
  function toggleUseAlwaysBgm() {
    const next = !useAlwaysBgm;
    setUseAlwaysBgm(next);
    persistAssemblyDefaults(next, useAlwaysLogo);
  }
  function toggleUseAlwaysLogo() {
    const next = !useAlwaysLogo;
    setUseAlwaysLogo(next);
    persistAssemblyDefaults(useAlwaysBgm, next);
  }
  // Keep the saved music default in sync while its toggle is on.
  useEffect(() => {
    if (!useAlwaysBgm) return;
    const t = setTimeout(() => persistAssemblyDefaults(useAlwaysBgm, useAlwaysLogo), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useAlwaysBgm, bgmUploadedUrl, bgmVolume]);
  // Keep the saved logo default in sync while its toggle is on.
  useEffect(() => {
    if (!useAlwaysLogo) return;
    const t = setTimeout(() => persistAssemblyDefaults(useAlwaysBgm, useAlwaysLogo), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useAlwaysLogo, logoUploadedUrl, logoX, logoY, logoSize]);
  useEffect(() => {
    if (!logoFile) {
      if (logoObjectUrl) URL.revokeObjectURL(logoObjectUrl);
      setLogoObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(logoFile);
    setLogoObjectUrl(url);
    return () => { URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logoFile]);

  // Local blob URL for in-browser preview playback. Created when a
  // file is picked and revoked when it's replaced or cleared so we
  // don't leak object URLs over the page's lifetime.
  const [bgmObjectUrl, setBgmObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bgmFile) {
      if (bgmObjectUrl) URL.revokeObjectURL(bgmObjectUrl);
      setBgmObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(bgmFile);
    setBgmObjectUrl(url);
    return () => { URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgmFile]);
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captionsLanguage, setCaptionsLanguage] = useState("source");
  const [captionsStyle, setCaptionsStyle] = useState("classic");
  const [captionsSize, setCaptionsSize] = useState("medium");
  const [captionsPosition, setCaptionsPosition] = useState("bottom");
  // Collapsed by default. Captions carry five settings and most assemblies do
  // not touch them, so open they push the timeline off the screen.
  const [captionsOpen, setCaptionsOpen] = useState(false);
  // Open by default, unlike captions. This is where the preview lives, and the
  // timeline below drives it: collapsing it by default would mean selecting a
  // beat and watching nothing happen.
  const [effectsOpen, setEffectsOpen] = useState(true);
  // Closed: decoration, and most assemblies add neither.
  const [brandingOpen, setBrandingOpen] = useState(false);
  // Closed: readouts plus one setting, all of it in the summary line.
  const [outputOpen, setOutputOpen] = useState(false);
  // Movement for beats that are a still image. Only reaches those beats: one
  // that has a generated clip is untouched, so a project with clips everywhere
  // sees no difference whatever this is set to.
  const [imageMotion, setImageMotion] = useState("none");
  const [transition, setTransition] = useState("none");
  const [transitionSeconds, setTransitionSeconds] = useState(0.5);
  const [videoFilter, setVideoFilter] = useState("none");
  const [videoFilterStrength, setVideoFilterStrength] = useState(1);
  const [sfxVolume, setSfxVolume] = useState(0.6);
  const [effectsTab, setEffectsTab] = useState<"effects" | "transitions" | "filters" | "sound">("effects");
  // Seconds each move takes. 0 is the slider's left-most position and means the
  // whole beat, which is what every render did before this was a choice.
  const [imageMotionSeconds, setImageMotionSeconds] = useState(0);
  // How far a move travels, as a share of the frame. The default 15% is
  // deliberately gentle under narration; "strong" is a camera move you notice.
  const [imageMotionStrength, setImageMotionStrength] = useState("normal");
  // Random shows a different effect every few seconds rather than standing in
  // with one of them: the whole point of the option is that beats differ, and a
  // single looping move says the opposite.
  const [randomPreviewStep, setRandomPreviewStep] = useState(0);
  // Which beat the inspector is showing, by number. Null is nothing selected,
  // which is how the panel stays out of the way until it is wanted.
  const [timelineBeat, setTimelineBeat] = useState<number | null>(null);
  // The music's own length, so the track can show where it starts over. The
  // worker loops it to cover the narration; the timeline said nothing about
  // that, which made a two-minute track under a nine-minute video look like
  // eight minutes of silence.
  const [bgmDuration, setBgmDuration] = useState<number | null>(null);
  // Phone only: the controls fold under the preview. Open from sm up, where
  // the class does the work and this value is ignored.
  const [mobileEffectsOpen, setMobileEffectsOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  // How wide a second is. Stepped rather than continuous: a slider over pixels
  // per second invites fiddling, and six steps cover ten minutes to one beat.
  const timelineTotal = beats.reduce((sum, b) => sum + beatSeconds(b).seconds, 0);
  // True while any beat is still guessing, so the panel can say so rather than
  // presenting an estimate as a measurement.
  const timelineEstimated = beats.some((b) => beatSeconds(b).estimated);
  const [pxPerSecond, setPxPerSecond] = useState(ZOOM_STEPS[DEFAULT_ZOOM]);
  // The step nearest the current scale, so the slider and the buttons still
  // work after Fit has put us somewhere between two of them.
  const zoomStep = ZOOM_STEPS.reduce(
    (best, v, i) => Math.abs(v - pxPerSecond) < Math.abs(ZOOM_STEPS[best] - pxPerSecond) ? i : best, 0,
  );
  const timelineViewportRef = useRef<HTMLDivElement | null>(null);

  // Squeeze the whole video into the width available, the way CapCut's fit
  // does. Not a zoom step: the right scale depends on the window and on how
  // long this particular video is, so it is computed rather than chosen.
  const fitTimeline = useCallback(() => {
    const width = timelineViewportRef.current?.clientWidth ?? 0;
    if (!width || !timelineTotal) return;
    // Sixteen px of slack so the last beat is not flush against the edge.
    setPxPerSecond(Math.max(2, (width - 16) / timelineTotal));
  }, [timelineTotal]);

  // Fit the whole video into the width once the lengths are known. Runs on the
  // first real total only: after that the zoom is the user's, and re-fitting
  // when a beat's duration arrives would yank the strip out from under them.
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || !timelineTotal || !timelineViewportRef.current?.clientWidth) return;
    fittedRef.current = true;
    fitTimeline();
  }, [timelineTotal, fitTimeline, narrow]);

  // Playing the edit before rendering it.
  //
  // There is no assembled video to scrub yet, so this plays what actually
  // exists: each beat's voiceover in order. That is enough to hear the rhythm
  // the timeline is showing — where a beat runs long, where two short ones
  // stack up — which is the question the strip is there to answer.
  //
  // The playhead advances by each beat's SHARE of its own audio rather than by
  // wall-clock seconds, so it crosses a block exactly as that block's narration
  // plays even when the estimated width and the real audio differ.
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0); // seconds along the timeline
  // Which beat is sounding, so the effects preview can show it. That panel is
  // the only frame-sized surface on this step, so during playback it doubles as
  // the viewer rather than sitting there showing an unrelated beat.
  const [playingBeat, setPlayingBeat] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // The bed runs underneath as one continuous element rather than restarting
  // per beat, which is what the assembler does with it: narration is cut into
  // beats, music is not. Its own ref, separate from the music card's inline
  // preview player, so the two cannot pause each other.
  const timelineBgmRef = useRef<HTMLAudioElement | null>(null);
  const playIndexRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const playable = beats.filter((b) => !!b.voiceoverUrl);
  const bgmPreviewUrl = bgmObjectUrl ?? bgmUploadedUrl;
  // Preview only. The worker has no narration level — the voiceover is the
  // reference everything else is mixed against — so this changes what you hear
  // here and nothing about the render. Labelled as such rather than left to be
  // discovered.
  const [narrationPreviewVolume, setNarrationPreviewVolume] = useState(1);
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, narrationPreviewVolume));
  }, [narrationPreviewVolume]);

  useEffect(() => {
    if (timelineBgmRef.current) timelineBgmRef.current.volume = Math.max(0, Math.min(1, bgmVolume));
  }, [bgmVolume]);

  const stopPlayback = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    timelineBgmRef.current?.pause();
    timelineBgmRef.current = null;
    setPlaying(false);
    setPlayingBeat(null);
  }, []);

  // Stop when the page goes away, or the audio keeps playing over a step the
  // user has already left.
  useEffect(() => stopPlayback, [stopPlayback]);

  const playFrom = useCallback((index: number, startAt = 0) => {
    const beat = playable[index];
    if (!beat?.voiceoverUrl) { stopPlayback(); setPlayhead(0); setPlayingBeat(null); return; }
    playIndexRef.current = index;
    setPlayingBeat(beat.beatNumber);

    // Where this block starts, measured the same way its width is, so the
    // playhead and the strip agree.
    const offset = playable.slice(0, index).reduce((sum, b) => sum + beatSeconds(b).seconds, 0);
    const span = beatSeconds(beat).seconds;

    // The beat's own sound, at its start, at the level the render will use. The
    // same file the worker mixes, so what is heard here is what is heard there.
    if (beat.soundEffect && startAt <= 0.01 && sfxVolume > 0) {
      const cue = new Audio(`/sfx/${beat.soundEffect}.mp3`);
      cue.volume = Math.max(0, Math.min(1, sfxVolume));
      void cue.play().catch(() => { /* autoplay rules; the narration still plays */ });
    }

    const audio = new Audio(beat.voiceoverUrl);
    audioRef.current = audio;
    if (startAt > 0) {
      // Duration is unknown until metadata arrives, and the offset is a
      // fraction of the beat rather than of the file: they are the same length
      // in principle, but a trimmed voiceover is not.
      audio.addEventListener("loadedmetadata", () => {
        const d = audio.duration;
        if (Number.isFinite(d) && d > 0) audio.currentTime = Math.min(d - 0.05, startAt * d);
      }, { once: true });
    }
    audio.onended = () => playFrom(index + 1);
    audio.onerror = () => playFrom(index + 1);
    audio.volume = Math.max(0, Math.min(1, narrationPreviewVolume));
    void audio.play().catch(() => stopPlayback());

    const tick = () => {
      const d = audio.duration;
      const share = d && Number.isFinite(d) ? Math.min(1, audio.currentTime / d) : 0;
      setPlayhead(offset + share * span);
      rafRef.current = requestAnimationFrame(tick);
    };
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [playable, stopPlayback, narrationPreviewVolume, sfxVolume]);

  // Click anywhere on the timeline and the playhead goes there. This is most
  // of what makes it a timeline rather than a strip of pictures: a tester
  // looked at it and did not recognise one, having found nothing that behaves
  // the way an editor's does.
  const seekTo = useCallback((seconds: number) => {
    const t = Math.max(0, Math.min(timelineTotal, seconds));
    let acc = 0;
    let index = 0;
    let within = 0;
    for (let i = 0; i < playable.length; i++) {
      const span = beatSeconds(playable[i]).seconds;
      if (t < acc + span || i === playable.length - 1) {
        index = i;
        within = span > 0 ? Math.max(0, Math.min(1, (t - acc) / span)) : 0;
        break;
      }
      acc += span;
    }
    setPlayhead(t);
    const landedOn = playable[index];
    if (playing) {
      playFrom(index, within);
    } else if (landedOn) {
      // Not playing: point the preview at the beat under the playhead, which
      // is what a scrub is for when the audio is stopped.
      setTimelineBeat(landedOn.beatNumber);
    }
  }, [playable, playing, playFrom, timelineTotal]);

  const togglePlay = useCallback(() => {
    if (playing) { stopPlayback(); return; }
    if (playable.length === 0) { toast.info("No voiceover to play yet."); return; }
    setPlaying(true);
    setPlayhead(0);

    // Muted means volume zero, which is exactly what the worker is told, so
    // there is nothing to start.
    if (bgmPreviewUrl && bgmVolume > 0) {
      const bed = new Audio(bgmPreviewUrl);
      bed.loop = true;              // shorter than the video is the normal case
      bed.volume = Math.max(0, Math.min(1, bgmVolume));
      timelineBgmRef.current = bed;
      void bed.play().catch(() => { /* the narration still plays without it */ });
    }

    playFrom(0);
  }, [playing, playable.length, playFrom, stopPlayback, bgmPreviewUrl, bgmVolume]);

  // Set or clear one beat's effect. Optimistic: the select is the only feedback
  // and waiting a round trip to show a choice feels broken.
  useEffect(() => {
    if (!bgmPreviewUrl) { setBgmDuration(null); return; }
    const probe = new Audio();
    probe.preload = "metadata";
    const done = () => {
      const d = probe.duration;
      setBgmDuration(Number.isFinite(d) && d > 0 ? d : null);
    };
    probe.addEventListener("loadedmetadata", done);
    probe.src = bgmPreviewUrl;
    return () => probe.removeEventListener("loadedmetadata", done);
  }, [bgmPreviewUrl]);

  const setBeatMotion = useCallback(async (beatNumber: number, motion: string | null) => {
    await mutate((cur: unknown) => {
      const c = cur as { beats?: Beat[] } | undefined;
      if (!c?.beats) return cur;
      return { ...c, beats: c.beats.map((b) => b.beatNumber === beatNumber ? { ...b, imageMotion: motion } : b) };
    }, { revalidate: false });
    try {
      const res = await fetch(`/api/projects/${projectId}/beats/motion`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beatNumber, motion }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not set the effect");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not set the effect");
      await mutate();
    }
  }, [projectId, mutate]);

  const setBeatSound = useCallback(async (beatNumber: number, sound: string | null) => {
    await mutate((cur: unknown) => {
      const c = cur as { beats?: Beat[] } | undefined;
      if (!c?.beats) return cur;
      return { ...c, beats: c.beats.map((b) => b.beatNumber === beatNumber ? { ...b, soundEffect: sound } : b) };
    }, { revalidate: false });
    try {
      const res = await fetch(`/api/projects/${projectId}/beats/sound`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beatNumber, sound }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not set the sound");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not set the sound");
      await mutate();
    }
  }, [projectId, mutate]);

  // What the preview demonstrates on.
  //
  // Selecting a beat in the timeline points the preview at that beat, so the
  // two panels are about the same shot rather than two different ones. With
  // nothing selected it falls back to the first still, which is the frame
  // someone judging the project-wide setting would want.
  //
  // One of their own frames either way: a stock image would show the movement
  // but not what it does to their composition, which is the part worth judging.
  const previewBeat = (playingBeat !== null
    ? beats.find((b) => b.beatNumber === playingBeat && (b.imageUrl || b.videoUrl))
    : null)
    ?? (timelineBeat !== null
      ? beats.find((b) => b.beatNumber === timelineBeat && (b.imageUrl || b.videoUrl))
      : null)
    ?? beats.find((b) => !b.videoUrl && b.imageUrl) ?? null;
  // A beat that generated a clip previews as that clip: it is what gets
  // assembled, and a still of its first frame says nothing about the motion
  // that was paid for.
  const previewClipUrl = previewBeat?.videoUrl ?? null;
  const stillPreviewUrl = previewBeat?.imageUrl ?? null;
  const previewSrc = previewClipUrl ?? stillPreviewUrl;
  // The shot after the previewed one. A transition is about two frames, and two
  // copies of the same one shows nothing.
  const nextPreviewUrl = (() => {
    const at = previewBeat ? beats.findIndex((b) => b.beatNumber === previewBeat.beatNumber) : -1;
    const after = at >= 0 ? beats.slice(at + 1).find((b) => b.imageUrl) : beats.filter((b) => b.imageUrl)[1];
    return after?.imageUrl ?? stillPreviewUrl;
  })();

  // The effect that beat will actually get: its own if it has one, otherwise
  // the project's. Watching the project setting animate on a beat that
  // overrides it would be a lie about what will be rendered.
  const previewMotion = previewBeat?.imageMotion ?? imageMotion;

  // Playback runs the transition where it will actually happen: in the last t
  // seconds of a beat, at the length the render uses. Without this the preview
  // cut hard between beats and the setting looked like it did nothing.
  const playbackSeam = (() => {
    if (!playing || transition === "none" || playingBeat === null) return null;
    const idx = playable.findIndex((b) => b.beatNumber === playingBeat);
    if (idx < 0 || idx >= playable.length - 1) return null;
    const start = playable.slice(0, idx).reduce((sum, b) => sum + beatSeconds(b).seconds, 0);
    const span = beatSeconds(playable[idx]).seconds;
    // The same clamp the worker applies, so what plays is what renders.
    const shortest = Math.min(...playable.map((b) => beatSeconds(b).seconds));
    const t = Math.min(transitionSeconds, 2, shortest / 5);
    const remaining = start + span - playhead;
    if (t <= 0 || remaining > t || remaining < 0) return null;
    const next = playable[idx + 1];
    return { p: Math.min(1, Math.max(0, (t - remaining) / t)), url: next.imageUrl ?? null };
  })();

  // Select a beat on the timeline and the grid edits that beat; select nothing
  // and it edits the project. One grid either way — a second copy of it for
  // per-beat work would be the same eight tiles asking to be kept in step.
  const editingBeat = timelineBeat !== null
    ? beats.find((b) => b.beatNumber === timelineBeat && (b.imageUrl || b.videoUrl)) ?? null
    : null;
  const editingMotion = editingBeat ? (editingBeat.imageMotion ?? imageMotion) : imageMotion;

  useEffect(() => {
    if (previewMotion !== "random") return;
    const t = setInterval(() => setRandomPreviewStep((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, [previewMotion]);

  const previewAnimation = previewMotion === "random"
    ? MOTION_ANIMATION[RANDOM_POOL[randomPreviewStep % RANDOM_POOL.length]]
    : MOTION_ANIMATION[previewMotion];

  // Live-persist trim + captions to the project row whenever they
  // change. The /api/generate/assemble call already writes them on
  // Assemble, but a user who toggles "Original voiceover" or flips
  // captions to "bold/large/top" and then refreshes without clicking
  // Assemble would lose their selection. Debounced so a rapid
  // sequence of dropdown changes coalesces into one PATCH instead
  // of spamming the API. Skipped on first render — hydratedRef
  // gates this so we don't PATCH the hydrated values straight back
  // to the server.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const t = setTimeout(() => {
      void fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trim_silence_enabled: trimSilence,
          captions_enabled: captionsEnabled,
          captions_language: captionsLanguage,
          captions_style: captionsStyle,
          captions_size: captionsSize,
          captions_position: captionsPosition,
          image_motion: imageMotion,
          image_motion_seconds: imageMotionSeconds || null,
          image_motion_strength: imageMotionStrength,
          transition,
          transition_seconds: transition === "none" ? null : transitionSeconds,
          video_filter: videoFilter,
          video_filter_strength: videoFilterStrength,
          sfx_volume: sfxVolume,
        }),
      }).catch(() => { /* non-blocking — Assemble click is the safety net */ });
    }, 500);
    return () => clearTimeout(t);
  }, [trimSilence, captionsEnabled, captionsLanguage, captionsStyle, captionsSize, captionsPosition, imageMotion, imageMotionSeconds, imageMotionStrength, transition, transitionSeconds, videoFilter, videoFilterStrength, sfxVolume, projectId]);
  const [assembling, setAssembling] = useState(false);
  // Monotonic high-water mark for the rendered stage index. We hold
  // the latest matched stage so a transient unmatched status line
  // from the worker doesn't drop the visible step back to 1 before
  // the next valid line snaps it forward (the cause of the visible
  // "reverses then continues" jump). Reset to -1 whenever assembling
  // flips back on (a new run, or a Resume that may revisit earlier
  // stages — both want the watermark to restart from scratch).
  const lastStageIdxRef = useRef<number>(-1);
  useEffect(() => {
    if (assembling) lastStageIdxRef.current = -1;
  }, [assembling]);
  // True from the moment the user clicks Stop until the worker
  // acknowledges by transitioning assembly_status to "stopped".
  // Lets the button label/disabled-state flip to "Stopping…"
  // instantly while the worker finishes its current ffmpeg stage and
  // persists the checkpoint.
  const stopRequested = !!project?.assembly_stop_requested;
  const finalizeRequested = !!project?.assembly_finalize_preview_requested;
  // Confirm dialog for Reassemble. Reassemble doesn't start the run
  // directly anymore — it asks first, then on confirm flips the page
  // into reassembleMode, which hides the current assembled video and
  // reveals the pre-assembly config panel so the user can pick a
  // different voiceover, change captions, etc. before kicking off.
  const [reassembleConfirmOpen, setReassembleConfirmOpen] = useState(false);
  const [bgmDisclaimerOpen, setBgmDisclaimerOpen] = useState(false);
  // When true: the existing assembled video is suppressed and the
  // config + Assemble button block is rendered. Cleared automatically
  // when assembleVideo() actually fires (the new run will replace
  // project.assembled_url on success) or if the user navigates away
  // and comes back.
  const [reassembleMode, setReassembleMode] = useState(false);
  const [assembleStatus, setAssembleStatus] = useState("");
  const [assembledUrl, setAssembledUrl] = useState<string | null>(null);

  // Derived: the URL we should actually show in the preview. Single
  // source of truth for "is the preview section visible". Hidden
  // whenever:
  //   - the user committed to reassembling (don't flash the deleted
  //     video back even for a tick), or
  //   - a new assembly is in flight (assembling status), or
  //   - the DB row carries no assembled_url (the canonical source —
  //     the moment clear_assembled lands, the preview disappears).
  // Local `assembledUrl` state is no longer consulted for the gate;
  // the polling effects keep it for unrelated UI bits (e.g. the
  // download anchor target) but rendering decisions go through here
  // so a stale local value can't flash an already-deleted player.
  const dbAssembledUrl = (project?.assembled_url as string | undefined) ?? null;
  const previewUrl: string | null = (reassembleMode || assembling) ? null : dbAssembledUrl;
  const showPreview = !!previewUrl;

  // Width the preview <video> actually renders at: min(panel width,
  // 70vh × ratio) — the same bound its max-h-[70vh] + max-w-full impose.
  // The action buttons use this so they line up with the video's width
  // instead of spilling full-width under a narrow portrait preview.
  const [arW, arH] = aspectRatio.split(":").map(Number);
  const previewMaxW = arW && arH ? `min(100%, calc(70vh * ${arW} / ${arH}))` : "100%";

  // In-progress preview — the worker uploads mixed.mp4 (full audio +
  // visuals at intermediate resolution, no captions/logo yet) as soon
  // as the mix step lands, BEFORE the multi-minute final-burn pass.
  // On the >80-beat path that burn can take 10-25 min; this gives
  // the user something watchable while they wait. Only shown while
  // assembly is still in progress; cleared by the worker on every
  // terminal transition.
  const inProgressPreviewUrl: string | null =
    assembling && !reassembleMode
      ? ((project?.assembly_preview_url as string | undefined) ?? null)
      : null;

  // Inline preview-load error. The <video> element fires onError
  // when the src URL is unreachable (worker temp file vanished, R2
  // 404, etc.). We don't toast (it was popping every first page load
  // for stale R2 URLs and felt like a hard error); we set this flag
  // so an inline note appears under the player. onLoadedMetadata
  // clears the flag, so a transient buffering hiccup that recovers
  // doesn't leave the warning stuck.
  const [previewLoadError, setPreviewLoadError] = useState(false);
  useEffect(() => { setPreviewLoadError(false); }, [previewUrl]);

  useEffect(() => {
    // Don't auto-restore the preview URL while the user is actively
    // reassembling — the SWR cache can still have stale project data
    // for a tick or two between the PATCH that nulled assembled_url and
    // the refetch that picks up the change, and this effect would
    // otherwise flash the old video back in.
    if (reassembleMode) return;
    const status = project?.assembly_status as string | undefined;
    const url = project?.assembled_url as string | undefined;
    if (!assembling && url && !assembledUrl && (status === "done" || status === "preview")) {
      setAssembledUrl(url);
    }
  }, [project, assembling, assembledUrl, reassembleMode]);

  useEffect(() => {
    const status = project?.assembly_status as string | undefined;
    if (!status) return;
    if (status === "queued") {
      setAssembling(true);
      setAssembleStatus("Queued…");
    } else if (status === "processing" || status === "uploading") {
      setAssembling(true);
      setAssembleStatus((project?.assembly_progress as string | undefined) ?? "Assembling…");
    } else if (status === "stopped") {
      // Worker honored the Stop signal and persisted the checkpoint.
      // Keep the panel visible so the user sees the Resume button
      // (rendered below) without having to refresh — the panel renders
      // as long as `assembling` is true, and `assembleStatus` carries
      // the last progress line so they remember where it stopped.
      setAssembling(true);
      setAssembleStatus((project?.assembly_progress as string | undefined) ?? "Stopped — click Resume to continue");
    } else if (status === "preview" || status === "done") {
      // Loading-state clears always run on terminal success — leaving
      // `assembling` true after status=done left the progress panel
      // stuck on screen with no way for the user to dismiss it.
      // The reassembleMode guard now only gates re-populating
      // assembledUrl (the original concern was that stale "done"
      // status from the SWR cache pre-refetch would otherwise put
      // the deleted URL back). Clearing the loading flag is safe
      // either way: if the user is mid-reassemble flow they're
      // looking at the config panel, not the progress strip.
      const url = project?.assembled_url as string | undefined;
      setAssembling(false);
      setAssembleStatus("");
      if (!reassembleMode && url) setAssembledUrl(url);
    } else if (status === "failed") {
      if (assembling) toast.error((project?.assembly_error as string | undefined) ?? "Assembly failed");
      setAssembling(false);
      setAssembleStatus("");
      setAssembledUrl((prev) => (prev?.includes("/api/preview/") ? null : prev));
    }
  }, [project?.assembly_status, project?.assembly_progress, reassembleMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Confirm-Reassemble action. Hits the clear_assembled endpoint which
  // deletes the assembled mp4 from R2, wipes the assembly_* fields on
  // the project (including the saved checkpoint), then flips the page
  // into reassembleMode so the user can adjust voiceover / captions /
  // aspect ratio before kicking off the new run. The old video is
  // gone the moment this resolves — there is no fallback to the
  // previous output.
  //
  // Order matters: we flip every local-state gate that could keep the
  // preview visible BEFORE the network round-trip. Otherwise the user
  // sees the old player for the ~500ms the PATCH + SWR refetch takes,
  // which looks like the button didn't work. The PATCH itself is then
  // the canonical cleanup (DB + R2), and the mutate() that follows
  // syncs project.assembled_url back to null so the gate stays closed
  // even when reassembleMode eventually drops back to false.
  const [clearingAssembled, setClearingAssembled] = useState(false);
  async function confirmReassemble() {
    // Hide preview + reset every local cache that could keep it
    // visible. These run before the network call so the player
    // disappears immediately on click.
    setReassembleMode(true);
    setAssembledUrl(null);
    setAssembleStatus("");
    setReassembleConfirmOpen(false);
    // Optimistic SWR update: blank assembled_url + assembly_* fields
    // locally so the gate reads null immediately, even before the
    // PATCH completes and the canonical refetch lands.
    void mutate((cur: Record<string, unknown> | undefined) => cur ? {
      ...cur,
      assembled_url: null,
      assembly_status: null,
      assembly_progress: null,
      assembly_error: null,
      assembly_checkpoint: null,
    } : cur, { revalidate: false });
    setClearingAssembled(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_assembled: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to clear assembled video");
      }
      // Canonical refetch — replaces the optimistic state with the
      // server's truth. If the PATCH failed mid-flight, this is what
      // would surface the inconsistency.
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear the existing video");
      // Roll back the optimistic hide so the user can see the existing
      // video again and retry, instead of being stuck on a config
      // panel that doesn't reflect actual server state.
      setReassembleMode(false);
      await mutate();
    } finally {
      setClearingAssembled(false);
    }
  }

  async function stopAssembly() {
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assembly_stop_requested: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to request stop");
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stop failed");
    }
  }

  // Step 1 of the two-step "ship the preview" flow.
  // PATCHes the finalize-preview flag; the worker watches it
  // alongside assembly_stop_requested and aborts to a stopped state
  // with the flag preserved. The UI then shows a Continue button
  // (in place of Resume) which calls commitPreview() to actually
  // promote the preview to assembled_url.
  async function finalizeWithPreview() {
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assembly_finalize_preview_requested: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to request finalize");
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Finalize failed");
    }
  }

  // Step 2 of the two-step flow. Called from the Continue button on
  // the stopped panel. Promotes assembly_preview_url to assembled_url
  // and flips the project to done — no worker round-trip needed
  // since mixed.mp4 is already in R2.
  const [committingPreview, setCommittingPreview] = useState(false);
  async function commitPreview() {
    setCommittingPreview(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit_preview: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to commit preview");
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not use this preview");
    } finally {
      setCommittingPreview(false);
    }
  }

  // Confirm-Cancel action paired with Resume when assembly_status is
  // "stopped". Hits the cancel_assembly PATCH which wipes the
  // checkpoint folder + every assembly_* field on the project (but
  // leaves assembled_url alone so a previously-successful video stays
  // available). After this the progress panel goes away and the user
  // is back at the pre-assembly config view.
  const [cancelAssemblyConfirmOpen, setCancelAssemblyConfirmOpen] = useState(false);
  const [cancellingAssembly, setCancellingAssembly] = useState(false);
  async function cancelAssembly() {
    setCancellingAssembly(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cancel_assembly: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to cancel");
      }
      setAssembling(false);
      setAssembleStatus("");
      setCancelAssemblyConfirmOpen(false);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setCancellingAssembly(false);
    }
  }

  async function resumeAssembly() {
    try {
      // Re-queue via the same endpoint as a fresh assembly. The endpoint
      // writes the current options into Redis (so the worker reads the
      // user's CURRENT settings on Resume — captionsStyle changes etc.
      // take effect) and clears assembly_stop_requested. The worker's
      // checkpoint-hash check then invalidates only the suffix of stages
      // affected by any changed options.
      const res = await fetch("/api/generate/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          aspectRatio,
          voiceoverType: "original",
          captionsEnabled,
          captionsLanguage,
          captionsStyle,
          captionsSize,
          captionsPosition,
          trimSilenceEnabled: trimSilence,
          imageMotion,
          transition,
          transitionSeconds: transition === "none" ? null : transitionSeconds,
          videoFilter,
          videoFilterStrength,
          sfxVolume,
          imageMotionSeconds: imageMotionSeconds || null,
          imageMotionStrength,
          backgroundMusicUrl: bgmUploadedUrl,
          backgroundMusicVolume: bgmVolume,
          resolution: selectedResolution,
          logoUrl: logoUploadedUrl,
          logoX, logoY, logoSize,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to resume");
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Resume failed");
    }
  }

  // Upload the picked BGM file once and cache its URL on this page
  // for the lifetime of the file selection. Re-uploads only when the
  // user picks a different file. Returns null on no-file or failure.
  // Shared upload helper. Uploads `file` to R2 via the presigned-URL
  // flow, mirrors the URL into the project row immediately, and
  // returns the public URL. Used by both the file-picker onChange
  // (upload on select) and the Assemble click path (retry if state
  // somehow has a file but no URL). The DB persist is fire-and-forget
  // — UI already reflects the upload, a transient persist failure
  // shouldn't block the user.
  async function uploadAndPersist(
    file: File,
    kind: "bgm" | "logo",
  ): Promise<string | null> {
    const folder = kind === "bgm" ? "background-music" : "channel-logo";
    const column = kind === "bgm" ? "background_music_url" : "logo_url";
    const setUploading = kind === "bgm" ? setBgmUploading : setLogoUploading;
    const setUrl = kind === "bgm" ? setBgmUploadedUrl : setLogoUploadedUrl;
    setUploading(true);
    try {
      const url = await presignedUpload(file, projectId, folder);
      setUrl(url);
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [column]: url }),
      }).catch(() => { /* non-blocking */ });
      return url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${kind === "bgm" ? "Music" : "Logo"} upload failed`);
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function ensureBgmUploaded(): Promise<string | null> {
    if (!bgmFile) return null;
    if (bgmUploadedUrl) return bgmUploadedUrl;
    return uploadAndPersist(bgmFile, "bgm");
  }

  async function ensureLogoUploaded(): Promise<string | null> {
    if (!logoFile) return null;
    if (logoUploadedUrl) return logoUploadedUrl;
    return uploadAndPersist(logoFile, "logo");
  }

  // Clear local state AND the persisted URL on the project row so
  // refresh doesn't re-hydrate a logo the user just removed. The PATCH
  // is best-effort — local state changes regardless so the UI updates
  // immediately even if the network blip the row update.
  function clearLogo() {
    const hadPersisted = !!logoUploadedUrl;
    setLogoFile(null);
    setLogoUploadedUrl(null);
    if (logoInputRef.current) logoInputRef.current.value = "";
    if (hadPersisted) {
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logo_url: null }),
      }).catch(() => { /* non-blocking */ });
    }
  }

  function clearBgm() {
    const hadPersisted = !!bgmUploadedUrl;
    setBgmFile(null);
    setBgmUploadedUrl(null);
    if (bgmInputRef.current) bgmInputRef.current.value = "";
    if (hadPersisted) {
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ background_music_url: null }),
      }).catch(() => { /* non-blocking */ });
    }
  }

  async function assembleVideo() {
    if (assembling) return;
    // Whether this is a first assembly or a confirmed reassemble, the
    // config panel is the launch path — drop reassembleMode here so a
    // successful run swaps cleanly back to the video-player view.
    setReassembleMode(false);
    setAssembling(true);
    setAssembledUrl(null);
    setAssembleStatus(trimSilence ? "Queuing (trim silences)…" : "Queuing…");
    try {
      // Upload background music first (if a file was picked but hasn't
      // been uploaded yet). The worker downloads from this URL during
      // the mix step.
      //
      // Initialize from the persisted/hydrated URL so a hydrated row
      // (page refresh + no new pick) still ships the previous selection
      // to the worker. A fresh File pick overrides via ensure*Uploaded.
      //
      // If a file is picked but upload fails, abort here. Quietly
      // sending `null` to the worker produced a video without music or
      // logo and hid the progress rows — the user thought it worked.
      let bgmUrl: string | null = bgmUploadedUrl;
      if (bgmFile) {
        setAssembleStatus("Uploading background music…");
        bgmUrl = await ensureBgmUploaded();
        if (!bgmUrl) throw new Error("Background music upload failed — please try again");
      }
      let logoUploadUrl: string | null = logoUploadedUrl;
      if (logoFile) {
        setAssembleStatus("Uploading channel logo…");
        logoUploadUrl = await ensureLogoUploaded();
        if (!logoUploadUrl) throw new Error("Channel logo upload failed — please try again");
      }
      setAssembleStatus(trimSilence ? "Queuing (trim silences)…" : "Queuing…");
      console.log("[assemble] submitting", { bgmUrl, bgmVolume, logoUploadUrl, logoX, logoY, logoSize, bgmFile: !!bgmFile, logoFile: !!logoFile, bgmUploadedUrl, logoUploadedUrl });
      const res = await fetch("/api/generate/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          aspectRatio,
          voiceoverType: "original",
          captionsEnabled,
          captionsLanguage,
          captionsStyle,
          captionsSize,
          captionsPosition,
          trimSilenceEnabled: trimSilence,
          imageMotion,
          transition,
          transitionSeconds: transition === "none" ? null : transitionSeconds,
          videoFilter,
          videoFilterStrength,
          sfxVolume,
          imageMotionSeconds: imageMotionSeconds || null,
          imageMotionStrength,
          backgroundMusicUrl: bgmUrl,
          backgroundMusicVolume: bgmVolume,
          resolution: selectedResolution,
          logoUrl: logoUploadUrl,
          logoX, logoY, logoSize,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to queue assembly");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Assembly failed");
      setAssembling(false);
      setAssembleStatus("");
    }
  }

  async function retryUpload() {
    if (assembling) return;
    setAssembling(true);
    setAssembleStatus("Uploading…");
    try {
      const res = await fetch("/api/generate/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to start upload");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
      setAssembling(false);
      setAssembleStatus("");
    }
  }

  // Per-beat voiceovers (current default) live on beat rows, not on
  // the project's legacy tts_url / tts_cleaned_url. The Assemble
  // button below gates on this flag, so without the beat-level check
  // the button stays disabled on every per-beat project even when
  // the previews above are happily playing the per-beat audio.
  const hasVoiceover = !!(ttsCleanedUrl || ttsUrl) || beats.some((b) => !!b.voiceoverUrl);
  const uploadFailedPreview = project?.assembly_status === "preview" && !project?.assembled_url;

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={15} highestState={project?.current_state} channelName={project?.channel_name} progressComplete={!!(project?.assembled_url)} />

      <main className="flex-1 overflow-y-auto pt-[105px] md:pt-0 lg:px-[15px]">
        {/* Header */}
        <div className="px-5 sm:px-8 lg:px-[60px] py-4 sm:py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div>
            <h1 className="font-bold text-base sm:text-lg">Assemble Final Video</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Transcribes your voiceover to align each clip to the exact narration timing
            </p>
            <div className="mt-3 flex items-center gap-2 flex-wrap min-w-0 w-full">
              <StepCostCard projectId={projectId} column="assemble" />
              <StepBalanceCard />
              <CostTipsModal />
            </div>
          </div>
        </div>

        <div className="px-5 sm:px-8 lg:px-[60px] py-4 sm:py-8 pb-24">
          <div className="w-full space-y-6">

            {/* Voiceover, clips, resolution and aspect ratio in one panel.
                Three of the four are readouts and the fourth is picked once,
                so the summary line carries them and the controls stay out of
                the way of the steps that get touched every time. */}
            <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={outputOpen}
                onClick={() => setOutputOpen((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOutputOpen((v) => !v); }
                }}
                className={`flex items-center justify-between gap-3 cursor-pointer select-none ${outputOpen ? "mb-4" : ""}`}
              >
                <div>
                  <p className="text-sm font-semibold">Output</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                    {[
                      `${dimsFor(aspectRatio, selectedResolution).label} · ${aspectRatio}`,
                      `${generatedVideos}/${videoBeats} clips`,
                      !hasVoiceover ? "no voiceover" : trimSilence ? "trimmed voiceover" : "original voiceover",
                    ].join(" · ")}
                  </p>
                </div>
                <span className="shrink-0" style={{ color: "var(--c-45)" }}>
                  {outputOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </span>
              </div>
              {outputOpen && (
              <div className="space-y-3">
                {/* Which take gets assembled. It lives here because the
                    card above already reports which one is selected, and the
                    previews are what makes that choice: hearing the two is
                    the only way to tell them apart. Clicking a card selects
                    it; the play button inside stops propagation so listening
                    does not also switch the selection. */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Voiceover Source</p>
                    {(trimmedLoading || originalLoading) && (
                      <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--brand-text)" }}>
                        <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Loading previews…
                      </span>
                    )}
                    {!beats.some((b) => !!b.voiceoverUrl) && (
                      <span className="text-[11px]" style={{ color: "var(--c-40)" }}>none generated yet</span>
                    )}
                  </div>
                  {beats.some((b) => !!b.voiceoverUrl) && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      <FullVoiceoverPreview
                        projectId={projectId}
                        beats={beats}
                        trimSilence={true}
                        title="Trimmed voiceover"
                        selected={trimSilence}
                        onSelect={assembling || !hasVoiceover ? undefined : () => setTrimSilence(true)}
                        onLoadingChange={setTrimmedLoading}
                      />
                      <FullVoiceoverPreview
                        projectId={projectId}
                        beats={beats}
                        trimSilence={false}
                        title="Original voiceover"
                        selected={!trimSilence}
                        onSelect={assembling || !hasVoiceover ? undefined : () => setTrimSilence(false)}
                        onLoadingChange={setOriginalLoading}
                      />
                    </div>
                  )}
                </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Voiceover</p>
                  <p className="mt-2 text-sm font-medium"
                    style={{ color: !hasVoiceover ? "var(--c-45)" : trimSilence ? "oklch(0.7 0.15 145)" : "var(--brand-text)" }}>
                    {!hasVoiceover ? "Missing" : trimSilence ? "Trimmed ✓" : "Original"}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Video Clips</p>
                  <p className="mt-2 text-sm font-medium"
                    style={{ color: generatedVideos > 0 ? "var(--brand-text)" : "var(--c-45)" }}>
                    {generatedVideos} / {videoBeats}
                  </p>
                  {generatedVideos < videoBeats && (
                    <p className="text-xs mt-1" style={{ color: "var(--c-40)" }}>
                      {videoBeats - generatedVideos} will use still images
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Output</p>
                  <p className="text-sm font-medium" style={{ color: "var(--c-65)" }}>{dimsFor(aspectRatio, selectedResolution).label}</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                    {RESOLUTION_PRESETS.map((p) => {
                      const isProOnly = PRO_RESOLUTIONS.has(p);
                      const locked = isProOnly && !canUsePro;
                      const active = selectedResolution === p;
                      return (
                        <button
                          key={p}
                          onClick={() => {
                            if (locked) {
                              // Pop the SubscriptionModal so the user
                              // can upgrade in-place rather than just
                              // being told "no" by a toast.
                              setShowUpgradeModal(true);
                              return;
                            }
                            setSelectedResolution(p);
                          }}
                          disabled={assembling}
                          title={locked
                            ? `Pro plan unlocks ${p} (${dimsFor(aspectRatio, p).label}) — click to upgrade`
                            : `Render at ${dimsFor(aspectRatio, p).label}`}
                          className="w-full py-1 rounded-md text-[10px] font-semibold transition-all disabled:opacity-40 inline-flex items-center justify-center gap-1"
                          style={active ? {
                            background: "oklch(0.72 0.25 285 / 0.18)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.45)",
                            color: "var(--accent-purple-text)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-card)",
                            color: "var(--c-50)",
                          }}
                        >
                          {p}
                          {isProOnly && (
                            <span
                              className="text-[8px] px-1 py-px rounded leading-none uppercase font-bold tracking-wide"
                              style={{
                                background: "oklch(0.72 0.25 285)",
                                color: "white",
                              }}
                            >
                              Pro
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--c-40)" }}>
                  Output Aspect Ratio{" "}
                  <span className="normal-case font-normal" style={{ color: "var(--c-35)" }}>· matches your generated images</span>
                </p>
                {/* Read-only: the output must match the ratio the images (and
                    therefore the clips) were generated at — changing it here
                    would letterbox/crop every beat. Locked to the project's
                    generation aspect ratio. */}
                <span className="inline-flex px-4 py-2 rounded-xl text-xs font-medium"
                  style={{ background: "oklch(0.72 0.25 285 / 0.15)", border: "1px solid oklch(0.72 0.25 285 / 0.4)", color: "var(--accent-purple-text)" }}>
                  {aspectRatio}
                </span>
              </div>
              </div>
              )}
            </div>

            {/* Music and logo together.
                Two uploads that decorate the video rather than change what it
                says, both used on a minority of assemblies, and each was its
                own full-width card. One section, closed by default, gives the
                steps that matter the room instead. */}
            <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={brandingOpen}
                onClick={() => setBrandingOpen((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setBrandingOpen((v) => !v); }
                }}
                className={`flex items-center justify-between gap-3 cursor-pointer select-none ${brandingOpen ? "mb-4" : ""}`}
              >
                <div>
                  <p className="text-sm font-semibold">Background music & logo</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                    {[
                      bgmPreviewUrl ? (bgmVolume > 0 ? `Music at ${Math.round(bgmVolume * 100)}%` : "Music muted") : null,
                      logoUploadedUrl || logoFile ? "Logo added" : null,
                    ].filter(Boolean).join(" · ") || "None added"}
                  </p>
                </div>
                <span className="shrink-0" style={{ color: "var(--c-45)" }}>
                  {brandingOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </span>
              </div>
              {brandingOpen && (
              <div className="space-y-4">
              {/* Background music — compact single-bar picker. Pre-pick
                  shows label + Choose file. Post-pick collapses every
                  control (filename, size, upload status, volume slider,
                  remove ×) into one horizontal row to keep the assemble
                  page dense. The chip + play-with-preview toggle still
                  renders inside each preview card. */}
              <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5 flex-wrap"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <span aria-hidden="true" className="text-base shrink-0" style={{ color: "var(--brand-text)" }}>♫</span>
                {!bgmFile && !bgmUploadedUrl ? (
                  <>
                    <p className="text-sm font-semibold flex-1">Background music</p>
                    <button
                      onClick={() => bgmInputRef.current?.click()}
                      disabled={assembling}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all shrink-0"
                      style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                    >
                      Choose file
                    </button>
                  </>
                ) : (
                  <>
                    {/* Play/pause preview — appears once a track is
                        selected/uploaded so the user can hear it before
                        assembling. Uses the local blob when available,
                        else the saved R2 URL. */}
                    {(() => {
                      const bgmPreviewSrc = bgmObjectUrl ?? bgmUploadedUrl;
                      if (!bgmPreviewSrc) return null;
                      return (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              const a = bgmAudioRef.current;
                              if (!a) return;
                              if (a.paused) {
                                a.volume = Math.max(0, Math.min(1, bgmVolume));
                                a.play().catch(() => {});
                              } else {
                                a.pause();
                              }
                            }}
                            title={bgmPlaying ? "Pause preview" : "Play preview"}
                            aria-label={bgmPlaying ? "Pause background music" : "Play background music"}
                            className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-transform hover:scale-105"
                            style={{ background: "oklch(0.72 0.25 285)", color: "#fff" }}
                          >
                            {bgmPlaying ? (
                              <span className="flex gap-[2px]">
                                <span className="block w-[3px] h-3 rounded-sm" style={{ background: "currentColor" }} />
                                <span className="block w-[3px] h-3 rounded-sm" style={{ background: "currentColor" }} />
                              </span>
                            ) : (
                              <span
                                className="block w-0 h-0 ml-[2px]"
                                style={{ borderLeft: "8px solid currentColor", borderTop: "5px solid transparent", borderBottom: "5px solid transparent" }}
                              />
                            )}
                          </button>
                          <audio
                            ref={bgmAudioRef}
                            src={bgmPreviewSrc}
                            preload="none"
                            onPlay={() => setBgmPlaying(true)}
                            onPause={() => setBgmPlaying(false)}
                            onEnded={() => setBgmPlaying(false)}
                          />
                        </>
                      );
                    })()}
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                        Background music
                      </p>
                      <p className="text-xs font-medium truncate" style={{ color: "var(--c-80)" }} title={bgmFile?.name ?? bgmUploadedUrl ?? ""}>
                        {bgmFile ? bgmFile.name : (bgmUploadedUrl?.split("/").pop() ?? "Saved track")}
                      </p>
                      <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
                        {bgmFile
                          ? `${(bgmFile.size / (1024 * 1024)).toFixed(1)} MB${bgmUploadedUrl ? " · Uploaded" : bgmUploading ? " · Uploading…" : " · Not uploaded yet"}`
                          : "Saved from a previous run"}
                      </p>
                      <button
                        type="button"
                        onClick={() => setBgmDisclaimerOpen(true)}
                        className="text-[10px] underline underline-offset-2 hover:opacity-80"
                        style={{ color: "oklch(0.7 0.22 25)" }}
                      >
                        Disclaimer
                      </button>
                    </div>
                    <div className="flex items-center gap-2 w-full sm:w-auto sm:shrink-0">
                      <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>Vol</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={bgmVolume}
                        onChange={(e) => setBgmVolume(parseFloat(e.target.value))}
                        disabled={assembling}
                        aria-label="Background music volume"
                        className="flex-1 sm:flex-none sm:w-32"
                      />
                      <span className="text-[11px] font-mono tabular-nums w-9 text-right" style={{ color: "var(--c-60)" }}>
                        {Math.round(bgmVolume * 100)}%
                      </span>
                      <button
                        onClick={clearBgm}
                        disabled={assembling || bgmUploading}
                        title="Remove background music"
                        className="w-7 h-7 rounded-lg flex items-center justify-center transition-opacity hover:opacity-90 disabled:opacity-40 shrink-0"
                        style={{ background: "transparent", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                      >
                        ×
                      </button>
                    </div>
                    <div className="flex items-center justify-end gap-2 w-full">
                      <span className="text-xs" style={{ color: "var(--c-55)" }}>Use this always</span>
                      <button
                        type="button"
                        onClick={toggleUseAlwaysBgm}
                        aria-pressed={useAlwaysBgm}
                        title="Reuse this background music on future videos"
                        className="relative w-9 h-5 rounded-full transition-all shrink-0 cursor-pointer"
                        style={{ background: useAlwaysBgm ? "oklch(0.72 0.25 285)" : "var(--c-22)", border: "1px solid var(--bd-10)" }}
                      >
                        <span className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                          style={{ background: "oklch(0.95 0 0)", left: useAlwaysBgm ? "calc(100% - 1.125rem)" : "0.125rem" }} />
                      </button>
                    </div>
                  </>
                )}
                <input
                  ref={bgmInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    if (!f) return;
                    setBgmFile(f);
                    // New file → invalidate any previously-uploaded URL
                    // and immediately upload + persist so a refresh
                    // doesn't lose the selection. Fire-and-forget
                    // since the user may continue tweaking other
                    // settings while the upload runs in the background.
                    setBgmUploadedUrl(null);
                    void uploadAndPersist(f, "bgm");
                  }}
                />
              </div>

              {/* Channel logo — single-bar picker matching the bgm
                  section. Pre-pick shows label + Choose file. Once a
                  file is selected, the bar expands with an aspect-
                  ratio drag surface where the user positions the logo,
                  a width slider, and the × clear. Position and size
                  are stored as 0–1 fractions of video dimensions so
                  they're resolution-agnostic. */}
              <div className="rounded-2xl px-4 py-2.5 space-y-3"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <div className="flex items-center gap-3 flex-wrap">
                  <span aria-hidden="true" className="text-base shrink-0" style={{ color: "var(--brand-text)" }}>◈</span>
                  {!logoFile && !logoUploadedUrl ? (
                    <>
                      <p className="text-sm font-semibold flex-1">Channel logo</p>
                      <button
                        onClick={() => logoInputRef.current?.click()}
                        disabled={assembling}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all shrink-0"
                        style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                      >
                        Choose file
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                          Channel logo
                        </p>
                        <p className="text-xs font-medium truncate" style={{ color: "var(--c-80)" }} title={logoFile?.name ?? logoUploadedUrl ?? ""}>
                          {logoFile ? logoFile.name : (logoUploadedUrl?.split("/").pop() ?? "Saved logo")}
                        </p>
                        <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
                          {logoFile
                            ? `${(logoFile.size / 1024).toFixed(0)} KB${logoUploadedUrl ? " · Uploaded" : logoUploading ? " · Uploading…" : " · Not uploaded yet"}`
                            : "Saved from a previous run"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 w-full sm:w-auto sm:shrink-0">
                        <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>Size</span>
                        <input
                          type="range"
                          min={0.03}
                          max={0.4}
                          step={0.01}
                          value={logoSize}
                          onChange={(e) => setLogoSize(parseFloat(e.target.value))}
                          disabled={assembling}
                          aria-label="Logo size"
                          className="flex-1 sm:flex-none sm:w-32"
                        />
                        <span className="text-[11px] font-mono tabular-nums w-9 text-right" style={{ color: "var(--c-60)" }}>
                          {Math.round(logoSize * 100)}%
                        </span>
                        <button
                          onClick={clearLogo}
                          disabled={assembling || logoUploading}
                          title="Remove channel logo"
                          className="w-7 h-7 rounded-lg flex items-center justify-center transition-opacity hover:opacity-90 disabled:opacity-40 shrink-0"
                          style={{ background: "transparent", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                        >
                          ×
                        </button>
                      </div>
                      <div className="flex items-center justify-end gap-2 w-full">
                        <span className="text-xs" style={{ color: "var(--c-55)" }}>Use this always</span>
                        <button
                          type="button"
                          onClick={toggleUseAlwaysLogo}
                          aria-pressed={useAlwaysLogo}
                          title="Reuse this logo on future videos"
                          className="relative w-9 h-5 rounded-full transition-all shrink-0 cursor-pointer"
                          style={{ background: useAlwaysLogo ? "oklch(0.72 0.25 285)" : "var(--c-22)", border: "1px solid var(--bd-10)" }}
                        >
                          <span className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                            style={{ background: "oklch(0.95 0 0)", left: useAlwaysLogo ? "calc(100% - 1.125rem)" : "0.125rem" }} />
                        </button>
                      </div>
                    </>
                  )}
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      if (!f) return;
                      setLogoFile(f);
                      setLogoUploadedUrl(null);
                      // Immediately upload + persist (same reasoning as bgm above).
                      void uploadAndPersist(f, "logo");
                    }}
                  />
                </div>
                {(logoObjectUrl || logoUploadedUrl) && (() => {
                  // Draggable preview surface. The surface holds the
                  // current aspect ratio (16:9 / 9:16 / 1:1). Logo is
                  // an absolutely positioned img the user drags around.
                  // Position is stored as 0–1 fractions of the surface
                  // dimensions, mirroring how the worker interprets
                  // logoX / logoY against the actual video.
                  // Source: blob URL for a freshly-picked File, otherwise
                  // the persisted R2 URL hydrated from the project row.
                  const logoSrc = logoObjectUrl ?? logoUploadedUrl!;
                  const aspect = aspectRatio.replace(":", " / ");
                  function onDragLogo(e: React.PointerEvent<HTMLImageElement>) {
                    e.preventDefault();
                    e.stopPropagation();
                    const surface = (e.currentTarget.parentElement?.parentElement as HTMLElement | null);
                    if (!surface) return;
                    const img = e.currentTarget;
                    img.setPointerCapture(e.pointerId);
                    const startBox = surface.getBoundingClientRect();
                    const offsetX = e.clientX - img.getBoundingClientRect().left;
                    const offsetY = e.clientY - img.getBoundingClientRect().top;
                    function move(ev: PointerEvent) {
                      const localX = ev.clientX - startBox.left - offsetX;
                      const localY = ev.clientY - startBox.top - offsetY;
                      // Clamp so the logo can't be dragged outside the
                      // visible video area. We don't know the rendered
                      // logo width yet (it depends on size %), but the
                      // worker also clamps via overlay's auto, so a
                      // simple [0, 1 - logoSize] keeps it sensible.
                      const maxX = 1 - logoSize;
                      const surfaceAspect = startBox.height / startBox.width;
                      // Approx maxY using the logo's render height ≈
                      // logoSize * surface width / image natural ratio.
                      const approxLogoHpct = (img.offsetHeight / startBox.height);
                      const maxY = Math.max(0, 1 - approxLogoHpct);
                      const nextX = Math.max(0, Math.min(maxX, localX / startBox.width));
                      const nextY = Math.max(0, Math.min(maxY, localY / startBox.height));
                      setLogoX(nextX);
                      setLogoY(nextY);
                      void surfaceAspect;
                    }
                    function up(ev: PointerEvent) {
                      img.releasePointerCapture(ev.pointerId);
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                    }
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up);
                  }
                  // Resize via dragging the bottom-right handle. Stops
                  // pointer propagation so the move handler on the img
                  // doesn't also fire. New width = pointer x − logo
                  // left edge, expressed as fraction of surface width.
                  // Clamped to the same 0.03–0.40 range as the slider.
                  function onResizeLogo(e: React.PointerEvent<HTMLSpanElement>) {
                    e.preventDefault();
                    e.stopPropagation();
                    const handle = e.currentTarget;
                    const surface = handle.parentElement?.parentElement as HTMLElement | null;
                    if (!surface) return;
                    handle.setPointerCapture(e.pointerId);
                    const startBox = surface.getBoundingClientRect();
                    // Capture current logo left edge in px so we measure
                    // from there regardless of where the pointer lands.
                    const logoLeftPx = startBox.left + logoX * startBox.width;
                    function move(ev: PointerEvent) {
                      const newWidthPx = Math.max(0, ev.clientX - logoLeftPx);
                      const newSize = Math.max(0.03, Math.min(0.4, newWidthPx / startBox.width));
                      // Don't push past the right edge: if the new size
                      // would overflow given the current x, clamp size.
                      const maxSize = Math.max(0.03, 1 - logoX);
                      setLogoSize(Math.min(newSize, maxSize));
                    }
                    function up(ev: PointerEvent) {
                      handle.releasePointerCapture(ev.pointerId);
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                    }
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up);
                  }
                  return (
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                        Drag to position · drag corner to resize
                      </p>
                      <div
                        className="relative w-full rounded-lg overflow-hidden select-none"
                        style={{
                          aspectRatio: aspect,
                          maxWidth: "320px",
                          background: "linear-gradient(135deg, oklch(0.16 0 0), oklch(0.22 0 0))",
                          border: "1px solid var(--bd-card)",
                        }}
                      >
                        <div
                          className="absolute group"
                          style={{
                            left: `${logoX * 100}%`,
                            top: `${logoY * 100}%`,
                            width: `${logoSize * 100}%`,
                          }}
                        >
                          <img
                            src={logoSrc}
                            alt={logoFile?.name ?? "Channel logo"}
                            draggable={false}
                            onPointerDown={assembling ? undefined : onDragLogo}
                            className="touch-none block w-full h-auto"
                            style={{
                              cursor: assembling ? "default" : "grab",
                              opacity: 0.95,
                              filter: "drop-shadow(0 2px 8px oklch(0 0 0 / 0.5))",
                            }}
                          />
                          {/* Bottom-right resize handle. Visible at all
                              times so it's discoverable; sized small so
                              it doesn't obscure tiny logos. */}
                          {!assembling && (
                            <span
                              onPointerDown={onResizeLogo}
                              aria-label="Resize logo"
                              title="Drag to resize"
                              className="absolute touch-none flex items-center justify-center"
                              style={{
                                right: "-6px",
                                bottom: "-6px",
                                width: "14px",
                                height: "14px",
                                borderRadius: "9999px",
                                background: "oklch(0.72 0.25 285)",
                                border: "2px solid #ffffff",
                                cursor: "nwse-resize",
                                boxShadow: "0 0 0 1px oklch(0.4 0.15 285)",
                              }}
                            />
                          )}
                        </div>
                      </div>
                      <p className="text-[10px] font-mono tabular-nums" style={{ color: "var(--c-40)" }}>
                        x: {Math.round(logoX * 100)}% · y: {Math.round(logoY * 100)}% · size: {Math.round(logoSize * 100)}%
                      </p>
                    </div>
                  );
                })()}
              </div>

              </div>
              )}
            </div>

            {/* Captions */}
            <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              {/* The whole row opens the section, so the target is the row
                  rather than the words. The switch only appears once it is
                  open: collapsed, the summary already says on or off, and a
                  switch sitting on a clickable row is a thing to hit by
                  accident while trying to expand it. */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={captionsOpen}
                onClick={() => setCaptionsOpen((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCaptionsOpen((v) => !v); }
                }}
                className={`flex items-center justify-between gap-3 cursor-pointer select-none ${captionsOpen ? "mb-4" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <div>
                    <p className="text-sm font-semibold">Captions</p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                      {captionsEnabled
                        ? `On · ${captionsStyle}, ${captionsSize}, ${captionsPosition}`
                        : "Off · burned into the video when on"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                {captionsOpen && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setCaptionsEnabled((v) => !v); }}
                    disabled={assembling}
                    aria-label={captionsEnabled ? "Turn captions off" : "Turn captions on"}
                    className="relative w-11 h-6 rounded-full transition-all disabled:opacity-40 shrink-0"
                    style={{ background: captionsEnabled ? "oklch(0.72 0.25 285)" : "var(--c-22)", border: "1px solid var(--bd-10)" }}
                  >
                    <span className="absolute top-0.5 w-5 h-5 rounded-full transition-all"
                      style={{ background: "oklch(0.95 0 0)", left: captionsEnabled ? "calc(100% - 1.375rem)" : "0.125rem" }} />
                  </button>
                )}
                {/* The arrow lives at the far edge, where the eye goes to find
                    out whether a row opens. Left of the title it competed with
                    the heading; here it reads as the affordance for the row. */}
                <span style={{ color: "var(--c-45)" }}>
                  {captionsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </span>
                </div>
              </div>

              {captionsOpen && captionsEnabled && (
                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Style</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {CAPTION_STYLES.map((s) => (
                        <button key={s.id} onClick={() => setCaptionsStyle(s.id)} disabled={assembling}
                          className="py-2 px-3 rounded-xl text-left transition-all disabled:opacity-40"
                          style={captionsStyle === s.id ? {
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-card)",
                          }}>
                          <p className="text-xs font-medium" style={{ color: captionsStyle === s.id ? "var(--accent-purple-text)" : "var(--c-60)" }}>{s.label}</p>
                          <p className="text-xs mt-0.5" style={{ color: "var(--c-38)" }}>{s.hint}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex gap-4">
                    <div className="flex-1">
                      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Size</p>
                      <div className="flex gap-1.5">
                        {CAPTION_SIZES.map((s) => (
                          <button key={s.id} onClick={() => setCaptionsSize(s.id)} disabled={assembling}
                            className="flex-1 py-1.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-40"
                            style={captionsSize === s.id ? {
                              background: "oklch(0.72 0.25 285 / 0.15)",
                              border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                              color: "var(--accent-purple-text)",
                            } : {
                              background: "var(--bg-input)",
                              border: "1px solid var(--bd-card)",
                              color: "var(--c-50)",
                            }}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex-1">
                      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Position</p>
                      <div className="flex gap-1.5">
                        {CAPTION_POSITIONS.map((p) => (
                          <button key={p.id} onClick={() => setCaptionsPosition(p.id)} disabled={assembling}
                            className="flex-1 py-1.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                            style={captionsPosition === p.id ? {
                              background: "oklch(0.72 0.25 285 / 0.15)",
                              border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                              color: "var(--accent-purple-text)",
                            } : {
                              background: "var(--bg-input)",
                              border: "1px solid var(--bd-card)",
                              color: "var(--c-50)",
                            }}>
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Language</p>
                    <div className="flex flex-wrap gap-1.5">
                      {CAPTION_LANGUAGES.map((lang) => (
                        <button key={lang.code} onClick={() => setCaptionsLanguage(lang.code)} disabled={assembling}
                          className="px-3 py-1.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                          style={captionsLanguage === lang.code ? {
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                            color: "var(--accent-purple-text)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-card)",
                            color: "var(--c-50)",
                          }}>
                          {lang.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Movement, and the preview the timeline plays through.
                The project-wide setting reaches stills only, so with every beat
                already a clip there is nothing for it to change and only the
                preview is worth showing. */}
            {movableBeats > 0 && (
            <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              {/* Same row-as-toggle as captions, and the summary carries the
                  current setting so it is readable while closed. */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={effectsOpen}
                onClick={() => setEffectsOpen((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEffectsOpen((v) => !v); }
                }}
                className={`flex items-center justify-between gap-3 cursor-pointer select-none ${effectsOpen ? "mb-4" : ""}`}
              >
                <div>
                  <p className="text-sm font-semibold">Preview & Effects</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                    {[
                      imageMotion === "none"
                        ? `${movableBeats} ${movableBeats === 1 ? "beat" : "beats"} · no movement`
                        : `${IMAGE_MOTIONS.find((m) => m.id === imageMotion)?.label ?? imageMotion} · ${MOTION_STRENGTHS.find((x) => x.id === imageMotionStrength)?.label.toLowerCase()} · ${imageMotionSeconds === 0 ? "whole beat" : `${imageMotionSeconds.toFixed(1)}s`}`,
                      transition === "none"
                        ? "hard cuts"
                        : `${TRANSITIONS.find((t) => t.id === transition)?.label.toLowerCase()} ${transitionSeconds.toFixed(1)}s`,
                      videoFilter === "none" ? null : `${VIDEO_FILTERS.find((f) => f.id === videoFilter)?.label.toLowerCase()} ${Math.round(videoFilterStrength * 100)}%`,
                    ].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <span className="shrink-0" style={{ color: "var(--c-45)" }}>
                  {effectsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </span>
              </div>
              {effectsOpen && (
              <>
              {/* Side by side. Full width, the preview was mostly black bars
                  around a small frame and the three options were stretched
                  across a row they did not need. The preview is the size of the
                  thing being judged, and the options sit beside it where they
                  can be read as a list. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {previewSrc && (
                <div>
                  <div
                    /* Half the section, however wide that is — a 15% move on
                       a 320px preview was about thirty pixels of travel, which
                       is a nudge rather than something to decide from. A 9:16
                       project is capped, since a full half of a wide screen
                       would make a preview taller than its own panel. Below sm
                       the grid is one column and this simply sits on top. */
                    className={`rounded-xl overflow-hidden w-full ${
                      aspectRatio === "9:16" ? "max-w-[240px]" : ""
                    }`}
                    style={{
                      border: "1px solid var(--bd-card)",
                      background: "black",
                    }}
                  >
                    <div
                      className="relative w-full overflow-hidden"
                      style={{
                        aspectRatio: aspectRatio === "9:16" ? "9 / 16" : aspectRatio === "1:1" ? "1 / 1" : "16 / 9",
                        // On the wrapper, not the frame: the grade is over the
                        // whole picture, so it survives a seam where two frames
                        // are on screen at once.
                        filter: gradeCss(videoFilter, videoFilterStrength),
                      }}
                    >
                      {/* On the transitions tab the preview shows the join
                          rather than the shot: this beat handing over to the
                          next one, at the size the decision is made at. The
                          tiles are too small to judge a soft wipe from a hard
                          one. Playback wins over both — while the timeline is
                          running, this is the playback view. */}
                      {videoFilter === "vignette" && (
                        <span className="absolute inset-0 z-10 pointer-events-none"
                          style={{ background: VIGNETTE_SHADOW, opacity: videoFilterStrength }} />
                      )}
                      {playbackSeam?.url && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={playbackSeam.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
                      )}
                      {effectsTab === "transitions" && transition !== "none" && !playing && stillPreviewUrl && nextPreviewUrl ? (
                        <>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={nextPreviewUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={stillPreviewUrl}
                            alt=""
                            key={`seam-${transition}`}
                            className="absolute inset-0 w-full h-full object-cover"
                            style={{
                              animation: SEAM_ANIMATION[transition],
                              ...(SEAM_MASK[transition] ?? {}),
                            }}
                          />
                        </>
                      ) : previewClipUrl ? (
                        <video
                          src={previewClipUrl}
                          autoPlay
                          muted
                          // Looped because that is what the assembler does: a
                          // clip shorter than its narration is repeated to fill
                          // the beat, not frozen on its last frame.
                          loop
                          playsInline
                          className="absolute inset-0 w-full h-full object-cover"
                          // Re-keyed on the beat so moving along the timeline
                          // restarts the clip rather than resuming whatever
                          // point the previous one had reached.
                          key={`clip-${previewBeat?.beatNumber}-${previewMotion}`}
                          style={playbackSeam ? seamStyle(transition, playbackSeam.p) : previewAnimation ? {
                            animation: previewAnimation,
                            willChange: "transform",
                            ["--kb-max" as string]: String(1 + (MOTION_STRENGTHS.find((x) => x.id === imageMotionStrength)?.travel ?? 0.15)),
                            ["--kb-pan" as string]: `${((MOTION_STRENGTHS.find((x) => x.id === imageMotionStrength)?.travel ?? 0.15) * 40).toFixed(0)}%`,
                          } : undefined}
                        />
                      ) : (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={stillPreviewUrl ?? undefined}
                        alt=""
                        className="absolute inset-0 w-full h-full object-cover"
                        // Re-keyed on each step so React restarts the
                        // animation rather than swapping the name mid-cycle,
                        // which would jump the frame.
                        key={imageMotion === "random" ? `r${randomPreviewStep}` : imageMotion}
                        style={playbackSeam ? seamStyle(transition, playbackSeam.p) : previewAnimation ? {
                          animation: previewAnimation,
                          willChange: "transform",
                          // The keyframes read these, so one set covers every
                          // strength and the preview travels exactly as far as
                          // the render will.
                          ["--kb-max" as string]: String(1 + (MOTION_STRENGTHS.find((x) => x.id === imageMotionStrength)?.travel ?? 0.15)),
                          ["--kb-pan" as string]: `${((MOTION_STRENGTHS.find((x) => x.id === imageMotionStrength)?.travel ?? 0.15) * 40).toFixed(0)}%`,
                        } : undefined}
                      />
                      )}
                    </div>
                  </div>
                </div>
                )}

                {/* Absolutely positioned from sm up, so this column takes its
                    height from the preview beside it rather than setting the
                    row's height itself. The tiles, strength and duration come
                    to a little more than a 16:9 frame is tall, and the column
                    growing past the picture left a ragged edge under it. What
                    does not fit scrolls here instead. */}
                <div className={`min-w-0 ${previewSrc ? "sm:relative" : ""}`}>
                  {/* On a phone the preview and this column stack, which puts
                      the picture above a screen of controls. Folded away by
                      default there, and always open from sm up, where they sit
                      side by side and there is nothing to gain by hiding it. */}
                  <button
                    type="button"
                    onClick={() => setMobileEffectsOpen((v) => !v)}
                    aria-expanded={mobileEffectsOpen}
                    className="sm:hidden w-full flex items-center justify-between gap-3 py-1.5"
                  >
                    <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
                      Effect, strength & duration
                    </span>
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="text-xs truncate" style={{ color: "var(--c-45)" }}>
                        {IMAGE_MOTIONS.find((m) => m.id === imageMotion)?.label ?? imageMotion}
                      </span>
                      <span style={{ color: "var(--c-45)" }}>
                        {mobileEffectsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                    </span>
                  </button>
                  <div className={`${previewSrc ? "sm:absolute sm:inset-0 sm:overflow-y-auto sm:pr-1" : ""} ${mobileEffectsOpen ? "" : "hidden sm:block"}`}>
                {/* Two things about the same edit: what a shot does while it is
                    on screen, and how it gives way to the next one. Tabs rather
                    than two stacked grids, which would put the second one below
                    the fold of a column sized to the preview. */}
                <div className="flex gap-1 p-1 rounded-xl mb-3" style={{ background: "var(--bg-input)" }}>
                  {([["effects", "Effects"], ["transitions", "Transitions"], ["filters", "Filters"], ["sound", "Sound"]] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setEffectsTab(id)}
                      className="flex-1 py-1.5 rounded-lg text-[11px] sm:text-xs font-medium transition-all"
                      style={effectsTab === id ? {
                        background: "oklch(0.72 0.25 285 / 0.18)",
                        color: "var(--accent-purple-text)",
                      } : { color: "var(--c-50)" }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {effectsTab === "sound" ? (
                <>
                  {/* A sound belongs to a beat, not to the project: it is an
                      accent on a moment. So this tab needs one selected, and
                      says so rather than quietly doing nothing. */}
                  <p className="text-xs mb-2" style={{ color: "var(--c-45)" }}>
                    {editingBeat
                      ? <>Plays at the start of <span style={{ color: "var(--accent-purple-text)" }}>beat {editingBeat.beatNumber}</span></>
                      : "Click to hear one. Select a beat on the timeline to give it that sound."}
                  </p>
                  <div className="min-w-0 grid grid-cols-2 lg:grid-cols-3 gap-1.5">
                    {SOUND_EFFECTS.map((snd) => {
                      const active = editingBeat?.soundEffect === snd.id;
                      return (
                        <button
                          key={snd.id}
                          type="button"
                          disabled={assembling}
                          title={snd.hint}
                          onClick={() => {
                            // Always playable, even with nothing selected: a
                            // greyed-out row of names reads as broken, and
                            // hearing the library is how anyone decides which
                            // one they want. With a beat selected it is also
                            // the choice.
                            void new Audio(`/sfx/${snd.id}.mp3`).play().catch(() => { /* autoplay rules */ });
                            if (editingBeat) setBeatSound(editingBeat.beatNumber, active ? null : snd.id);
                          }}
                          className="w-full py-2 px-2.5 rounded-xl text-left text-xs transition-all disabled:opacity-40 truncate"
                          style={active ? {
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                            color: "var(--accent-purple-text)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-card)",
                            color: "var(--c-60)",
                          }}
                        >
                          {snd.label}
                        </button>
                      );
                    })}
                  </div>
                  {editingBeat?.soundEffect && (
                    <button
                      type="button"
                      onClick={() => setBeatSound(editingBeat.beatNumber, null)}
                      disabled={assembling}
                      className="mt-2 text-xs underline underline-offset-2 disabled:opacity-40"
                      style={{ color: "var(--c-50)" }}
                    >
                      No sound on this beat
                    </button>
                  )}
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--c-40)" }}>
                      Effects level · every beat
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={sfxVolume}
                        disabled={assembling}
                        onChange={(e) => setSfxVolume(Number(e.target.value))}
                        className="flex-1 min-w-0 accent-[oklch(0.72_0.25_285)] disabled:opacity-40"
                      />
                      <span className="shrink-0 px-2 py-1 rounded-lg text-[11px] font-mono tabular-nums"
                        style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-65)" }}>
                        {Math.round(sfxVolume * 100)}%
                      </span>
                    </div>
                  </div>
                </>
                ) : effectsTab === "filters" ? (
                <>
                  <p className="text-xs mb-2" style={{ color: "var(--c-45)" }}>
                    Graded over every beat, under the captions and the logo
                  </p>
                  <div className="min-w-0 grid grid-cols-3 lg:grid-cols-4 gap-2">
                    {VIDEO_FILTERS.map((f) => {
                      const active = videoFilter === f.id;
                      return (
                        <button key={f.id} onClick={() => setVideoFilter(f.id)} disabled={assembling}
                          className="text-left transition-all disabled:opacity-40">
                          <span className="block relative w-full aspect-video rounded-lg overflow-hidden"
                            style={{
                              background: "var(--bg-input)",
                              border: `1px solid ${active ? "oklch(0.72 0.25 285)" : "var(--bd-card)"}`,
                              boxShadow: active ? "0 0 0 2px oklch(0.72 0.25 285 / 0.25)" : "none",
                            }}>
                            {stillPreviewUrl ? (
                              <>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={stillPreviewUrl} alt="" className="absolute inset-0 w-full h-full object-cover"
                                  style={{ filter: f.css(videoFilterStrength) }} />
                                {f.id === "vignette" && (
                                  <span className="absolute inset-0" style={{ background: VIGNETTE_SHADOW, opacity: videoFilterStrength }} />
                                )}
                              </>
                            ) : (
                              <span className="absolute inset-0 flex items-center justify-center" style={{ color: "var(--c-32)" }}>
                                <Ban size={16} />
                              </span>
                            )}
                          </span>
                          <span className="block mt-1 text-[11px] truncate"
                            style={{ color: active ? "var(--accent-purple-text)" : "var(--c-55)" }}>
                            {f.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {videoFilter !== "none" && (
                    <div className="mt-4">
                      <p className="text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--c-40)" }}>
                        Intensity
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={0.05}
                          max={1}
                          step={0.05}
                          value={videoFilterStrength}
                          disabled={assembling}
                          onChange={(e) => setVideoFilterStrength(Number(e.target.value))}
                          className="flex-1 min-w-0 accent-[oklch(0.72_0.25_285)] disabled:opacity-40"
                        />
                        <span className="shrink-0 px-2 py-1 rounded-lg text-[11px] font-mono tabular-nums"
                          style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-65)" }}>
                          {Math.round(videoFilterStrength * 100)}%
                        </span>
                      </div>
                    </div>
                  )}
                </>
                ) : effectsTab === "transitions" ? (
                <>
                  {/* Every boundary, not one of them: a transition set per seam
                      needs a control between two tiles on the timeline, which is
                      its own piece of work. */}
                  <p className="text-xs mb-2" style={{ color: "var(--c-45)" }}>
                    Applied at every cut between beats
                  </p>
                  <div className="min-w-0 grid grid-cols-3 lg:grid-cols-4 gap-2">
                    {TRANSITIONS.map((tr) => {
                      const active = transition === tr.id;
                      const anim = SEAM_ANIMATION[tr.id];
                      return (
                        <button key={tr.id} onClick={() => setTransition(tr.id)} disabled={assembling}
                          title={tr.hint}
                          className="text-left transition-all disabled:opacity-40">
                          <span className="block relative w-full aspect-video rounded-lg overflow-hidden"
                            style={{
                              background: "var(--bg-input)",
                              border: `1px solid ${active ? "oklch(0.72 0.25 285)" : "var(--bd-card)"}`,
                              boxShadow: active ? "0 0 0 2px oklch(0.72 0.25 285 / 0.25)" : "none",
                            }}>
                            {stillPreviewUrl && nextPreviewUrl && (
                              <>
                                {/* The incoming shot underneath, the outgoing
                                    one over it doing whatever it does to
                                    leave. A cut has nothing to animate, so it
                                    shows the two halves meeting instead. */}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={nextPreviewUrl} alt="" className="absolute inset-0 w-full h-full object-cover"
                                  style={tr.id === "none" ? { clipPath: "inset(0 0 0 50%)" } : undefined} />
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={stillPreviewUrl} alt="" className="absolute inset-0 w-full h-full object-cover"
                                  style={tr.id === "none"
                                    ? { clipPath: "inset(0 50% 0 0)" }
                                    : anim ? { animation: anim, ...(SEAM_MASK[tr.id] ?? {}) } : undefined} />
                                {tr.id === "none" && (
                                  <span className="absolute inset-y-0 left-1/2 w-px" style={{ background: "oklch(1 0 0 / 0.7)" }} />
                                )}
                              </>
                            )}
                          </span>
                          <span className="block mt-1 text-[11px] truncate"
                            style={{ color: active ? "var(--accent-purple-text)" : "var(--c-55)" }}>
                            {tr.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {transition !== "none" && (
                    <div className="mt-4">
                      <p className="text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--c-40)" }}>
                        Transition length
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={0.2}
                          max={1.5}
                          step={0.1}
                          value={transitionSeconds}
                          disabled={assembling}
                          onChange={(e) => setTransitionSeconds(Number(e.target.value))}
                          className="flex-1 min-w-0 accent-[oklch(0.72_0.25_285)] disabled:opacity-40"
                        />
                        <span className="shrink-0 px-2 py-1 rounded-lg text-[11px] font-mono tabular-nums"
                          style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-65)" }}>
                          {transitionSeconds.toFixed(1)}s
                        </span>
                      </div>
                      <p className="text-xs mt-1.5" style={{ color: "var(--c-38)" }}>
                        Each beat holds this much longer so the overlap does not pull the narration early. Capped at a fifth of the shortest beat.
                      </p>
                    </div>
                  )}
                </>
                ) : (
                <>
                {/* A grid of moving thumbnails rather than a list of names.
                    "Drift" and "Pan left, zoom held" describe a movement to
                    somebody who already knows what it looks like; a tile that
                    performs it does not need the sentence. Each runs the real
                    travel for the chosen strength, on one of the project's own
                    frames. */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="text-xs" style={{ color: "var(--c-45)" }}>
                    {editingBeat
                      ? <>Applying to <span style={{ color: "var(--accent-purple-text)" }}>beat {editingBeat.beatNumber}</span>{editingBeat.imageMotion ? "" : " · currently follows the project"}</>
                      : "Applying to every beat"}
                  </p>
                  {editingBeat && (
                    <div className="flex items-center gap-2 shrink-0">
                      {editingBeat.imageMotion && (
                        <button
                          type="button"
                          onClick={() => setBeatMotion(editingBeat.beatNumber, null)}
                          disabled={assembling}
                          className="text-xs underline underline-offset-2 disabled:opacity-40"
                          style={{ color: "var(--c-50)" }}
                        >
                          Follow project
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setTimelineBeat(null)}
                        className="text-xs underline underline-offset-2"
                        style={{ color: "var(--c-50)" }}
                      >
                        Edit all beats
                      </button>
                    </div>
                  )}
                </div>
                <div className="min-w-0 grid grid-cols-3 lg:grid-cols-4 gap-2">
                  {IMAGE_MOTIONS.map((m) => {
                    const active = editingMotion === m.id;
                    const anim = m.id === "random"
                      ? MOTION_ANIMATION[RANDOM_POOL[randomPreviewStep % RANDOM_POOL.length]]
                      : MOTION_ANIMATION[m.id];
                    return (
                      <button key={m.id}
                        onClick={() => editingBeat ? setBeatMotion(editingBeat.beatNumber, m.id) : setImageMotion(m.id)}
                        disabled={assembling}
                        title={m.hint}
                        className="group text-left transition-all disabled:opacity-40">
                        <span
                          className="block relative w-full aspect-video rounded-lg overflow-hidden"
                          style={{
                            background: "var(--bg-input)",
                            border: `1px solid ${active ? "oklch(0.72 0.25 285)" : "var(--bd-card)"}`,
                            boxShadow: active ? "0 0 0 2px oklch(0.72 0.25 285 / 0.25)" : "none",
                          }}
                        >
                          {m.id === "none" || !stillPreviewUrl ? (
                            <span className="absolute inset-0 flex items-center justify-center" style={{ color: "var(--c-32)" }}>
                              <Ban size={16} />
                            </span>
                          ) : (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={stillPreviewUrl}
                              alt=""
                              key={m.id === "random" ? `r${randomPreviewStep}` : m.id}
                              className="absolute inset-0 w-full h-full object-cover"
                              style={anim ? {
                                animation: anim,
                                ["--kb-max" as string]: String(1 + (MOTION_STRENGTHS.find((x) => x.id === imageMotionStrength)?.travel ?? 0.15)),
                                ["--kb-pan" as string]: `${((MOTION_STRENGTHS.find((x) => x.id === imageMotionStrength)?.travel ?? 0.15) * 40).toFixed(0)}%`,
                              } : undefined}
                            />
                          )}
                          {(m.id === "auto" || m.id === "random") && (
                            <span className="absolute bottom-1 right-1 px-1 rounded text-[8px] font-bold uppercase tracking-wide leading-[1.4]"
                              style={{ background: "oklch(0 0 0 / 0.6)", color: "oklch(1 0 0 / 0.8)" }}>
                              Varies
                            </span>
                          )}
                        </span>
                        <span className="block mt-1 text-[11px] truncate"
                          style={{ color: active ? "var(--accent-purple-text)" : "var(--c-55)" }}>
                          {m.label}
                        </span>
                        {/* Auto and Random are the two a thumbnail cannot say:
                            one tile shows a move, and what these do is differ
                            from beat to beat. They keep their line of text. */}
                        {(m.id === "auto" || m.id === "random") && (
                          <span className="block text-[10px] leading-tight" style={{ color: "var(--c-38)" }}>
                            {m.hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {/* How long each move takes, as distinct from how long the beat
                    runs. Left-most is the whole beat, the old behaviour and the
                    honest default; anything shorter means the move arrives and
                    the frame holds, which is how a camera move actually behaves. */}
                {editingMotion !== "none" && (
                  <div className="mt-4">
                    <div className="flex items-baseline justify-between mb-1.5">
                      <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
                        Strength{editingBeat ? " · every beat" : ""}
                      </p>
                      <p className="text-xs" style={{ color: "var(--c-55)" }}>
                        {MOTION_STRENGTHS.find((x) => x.id === imageMotionStrength)?.hint}
                      </p>
                    </div>
                    <div className="flex gap-1.5 mb-4">
                      {MOTION_STRENGTHS.map((x) => (
                        <button key={x.id} onClick={() => setImageMotionStrength(x.id)} disabled={assembling}
                          className="flex-1 py-1.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-40"
                          style={imageMotionStrength === x.id ? {
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                            color: "var(--accent-purple-text)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-card)",
                            color: "var(--c-60)",
                          }}>
                          {x.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--c-40)" }}>
                      Move duration{editingBeat ? " · every beat" : ""}
                    </p>
                    {/* Value in a chip on the slider's own line: at a glance the
                        number belongs to the handle, and the row above does not
                        have to carry a sentence saying it. */}
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={6}
                        step={0.5}
                        value={imageMotionSeconds}
                        disabled={assembling}
                        onChange={(e) => setImageMotionSeconds(Number(e.target.value))}
                        className="flex-1 min-w-0 accent-[oklch(0.72_0.25_285)] disabled:opacity-40"
                      />
                      <span className="shrink-0 px-2 py-1 rounded-lg text-[11px] font-mono tabular-nums"
                        style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-65)" }}>
                        {imageMotionSeconds === 0 ? "Whole beat" : `${imageMotionSeconds.toFixed(1)}s`}
                      </span>
                    </div>
                    <p className="text-xs mt-1.5" style={{ color: "var(--c-38)" }}>
                      {imageMotionSeconds === 0
                        ? "The move runs the length of each beat."
                        : "The move arrives, then the frame holds. Capped at the beat's length."}
                    </p>
                  </div>
                )}
                </>
                )}
                  </div>
                </div>
              </div>

              </>
              )}
            </div>
            )}

            {/* Timeline.
                Laid out the way an editor lays one out: left to right, each
                beat as wide as it is long, so the shape of the video is the
                shape on screen. The grid on the generate step gives every beat
                an equal square, which hides the two things that decide whether
                an effect suits a beat — how long it runs, and what its
                neighbours do.

                Not draggable, and no playhead. A strip you can drag promises
                retiming, reordering and playback, none of which exist yet.
                Selecting a beat and setting its effect is what this does, so
                that is all it offers. */}
            {beats.length > 0 && (
            <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              {/* The bar an editor puts above its timeline: what you are
                  looking at on the left, the transport in the middle, zoom on
                  the right. Laid out as a three-column grid rather than
                  justify-between so the transport is centred on the panel and
                  not on whatever is left over after the other two. */}
              <div className="mb-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 pb-2"
                style={{ borderBottom: "1px solid var(--bd-6)" }}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Timeline</p>
                  <p className="text-xs mt-0.5 truncate" style={{ color: "var(--c-45)" }}>
                    {beats.length} beats · video, narration and music
                    {timelineEstimated && " · lengths estimated"}
                  </p>
                </div>

                {/* Transport, centred, reading elapsed against total. */}
                <div className="flex items-center gap-2 justify-self-center">
                  <button
                    type="button"
                    onClick={togglePlay}
                    disabled={playable.length === 0}
                    title={playable.length === 0 ? "No voiceover generated yet" : playing ? "Pause" : "Play the narration"}
                    aria-label={playing ? "Pause" : "Play"}
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-opacity hover:opacity-85 disabled:opacity-30"
                    style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
                  >
                    {playing ? <Pause size={13} /> : <Play size={13} className="ml-[1px]" />}
                  </button>
                  <span className="text-xs font-mono tabular-nums whitespace-nowrap" style={{ color: "var(--c-60)" }}>
                    {fmtClock(playhead)}
                    <span style={{ color: "var(--c-32)" }}> / {fmtClock(timelineTotal)}</span>
                  </span>
                </div>

                {/* Zoom, the way an editor does it: out to see the shape of
                    the whole video, in to work on one beat. */}
                <div className="flex items-center gap-2 justify-self-end">
                  <span className="text-xs hidden lg:inline" style={{ color: "var(--c-38)" }}>Drag the ruler to scrub</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPxPerSecond(ZOOM_STEPS[Math.max(0, zoomStep - 1)])}
                      disabled={zoomStep === 0}
                      aria-label="Zoom out"
                      className="w-6 h-6 rounded-md text-xs font-semibold transition-opacity hover:opacity-80 disabled:opacity-30"
                      style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
                    >
                      −
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={ZOOM_STEPS.length - 1}
                      step={1}
                      value={zoomStep}
                      onChange={(e) => setPxPerSecond(ZOOM_STEPS[Number(e.target.value)])}
                      aria-label="Timeline zoom"
                      className="hidden sm:block w-20 accent-[oklch(0.72_0.25_285)]"
                    />
                    <button
                      type="button"
                      onClick={() => setPxPerSecond(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, zoomStep + 1)])}
                      disabled={zoomStep === ZOOM_STEPS.length - 1}
                      aria-label="Zoom in"
                      className="w-6 h-6 rounded-md text-xs font-semibold transition-opacity hover:opacity-80 disabled:opacity-30"
                      style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={fitTimeline}
                      title="Compress the whole video into the width available"
                      className="h-6 px-2 rounded-md text-[11px] font-medium transition-opacity hover:opacity-80"
                      style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
                    >
                      Fit
                    </button>
                  </div>
                </div>
              </div>

              <div
                ref={timelineViewportRef}
                className="overflow-x-auto rounded-xl px-2 pt-1 pb-2"
                style={{ background: "oklch(1 0 0 / 0.11)", border: "1px solid oklch(1 0 0 / 0.13)" }}
              >
                <div style={{ width: Math.max(320, timelineTotal * pxPerSecond) }}>
                  {/* Ruler. Every five seconds, which keeps a ten-minute video
                      readable without a mark per second. Drag it to scrub:
                      the ticks say what this is, the dragging proves it. */}
                  <div
                    className="relative h-5 mb-1 cursor-ew-resize select-none"
                    style={{ borderBottom: "1px solid var(--bd-10)" }}
                    onPointerDown={(e) => {
                      const strip = e.currentTarget;
                      const scrub = (clientX: number) => {
                        const rect = strip.getBoundingClientRect();
                        seekTo((clientX - rect.left) / pxPerSecond);
                      };
                      scrub(e.clientX);
                      const move = (ev: PointerEvent) => scrub(ev.clientX);
                      const up = () => {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                      };
                      window.addEventListener("pointermove", move);
                      window.addEventListener("pointerup", up);
                    }}
                  >
                    {(() => {
                      // Marks no closer than 60px, or zooming out turns the
                      // ruler into a smear of overlapping numbers.
                      const every = Math.max(1, Math.ceil(60 / pxPerSecond / 5) * 5);
                      // Minor ticks between the numbers, as long as they stay
                      // at least 6px apart — closer than that and they read as
                      // a grey band rather than as marks.
                      const minor = every / 5;
                      const minorTicks = minor * pxPerSecond >= 6
                        ? Array.from({ length: Math.floor(timelineTotal / minor) + 1 }, (_, i) => i * minor)
                            .filter((t) => Math.abs(t / every - Math.round(t / every)) > 1e-6)
                        : [];
                      return (
                        <>
                          {minorTicks.map((t) => (
                            <span key={`m${t}`} className="absolute bottom-0 w-px h-1.5 pointer-events-none"
                              style={{ left: t * pxPerSecond, background: "oklch(1 0 0 / 0.22)" }} />
                          ))}
                          {Array.from({ length: Math.floor(timelineTotal / every) + 1 }, (_, i) => i * every).map((t) => (
                            <span key={t} className="absolute bottom-0 flex items-end gap-1 pointer-events-none"
                              style={{ left: t * pxPerSecond }}>
                              <span className="block w-px h-3" style={{ background: "oklch(1 0 0 / 0.4)" }} />
                              <span className="text-[9px] tabular-nums leading-none pb-px" style={{ color: "var(--c-45)" }}>
                                {t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}` : `${t}s`}
                              </span>
                            </span>
                          ))}
                        </>
                      );
                    })()}
                  </div>

                  {/* The beats themselves. The playhead spans this and the
                      audio below it, so the tracks read as one thing at one
                      moment in time. */}
                  <div className="relative">
                  {(() => {
                    const every = Math.max(1, Math.ceil(60 / pxPerSecond / 5) * 5);
                    return Array.from({ length: Math.floor(timelineTotal / every) + 1 }, (_, i) => i * every)
                      .filter((t) => t > 0)
                      .map((t) => (
                        <span key={`g${t}`} className="absolute top-0 bottom-0 w-px z-20 pointer-events-none"
                          style={{ left: t * pxPerSecond, background: "oklch(1 0 0 / 0.07)" }} />
                      ));
                  })()}
                  <div className="absolute top-0 bottom-0 w-[2px] z-30 pointer-events-none"
                    style={{
                      left: playhead * pxPerSecond,
                      background: playing ? "oklch(0.95 0 0)" : "oklch(0.85 0 0 / 0.75)",
                      boxShadow: playing ? "0 0 6px oklch(0.95 0 0 / 0.6)" : "none",
                    }}>
                    {/* The head, which is the part people recognise. */}
                    <span className="absolute -top-1 -left-[3px] w-2 h-2 rounded-sm rotate-45"
                      style={{ background: playing ? "oklch(0.95 0 0)" : "oklch(0.85 0 0 / 0.75)" }} />
                  </div>
                  <div className="flex gap-[1px] items-stretch rounded-md"
                    style={{ background: "oklch(1 0 0 / 0.09)" }}>
                    {(() => { let elapsed = 0; return beats.map((b) => {
                      const { seconds } = beatSeconds(b);
                      const startsAt = elapsed;
                      elapsed += seconds;
                      const isClip = !!b.videoUrl;
                      const selected = timelineBeat === b.beatNumber;
                      return (
                        <button
                          key={b.beatNumber}
                          type="button"
                          // Selects the beat and puts the playhead where the
                          // click landed, rather than at the beat's start.
                          // Being thrown back to the beginning of a shot you
                          // clicked three quarters along is what makes a strip
                          // feel like a row of pictures instead of a timeline.
                          onClick={(e) => {
                            setTimelineBeat(b.beatNumber);
                            const rect = e.currentTarget.getBoundingClientRect();
                            seekTo(startsAt + (e.clientX - rect.left) / pxPerSecond);
                          }}
                          title={`Beat ${b.beatNumber} · ${seconds.toFixed(1)}s${beatSeconds(b).estimated ? " (estimated)" : ""}`}
                          className="relative h-10 sm:h-16 shrink-0 rounded-md overflow-hidden transition-all hover:brightness-110 cursor-pointer"
                          style={{
                            // A floor, or a half-second beat is a sliver nobody
                            // can hit with a mouse.
                            // The floor keeps a short beat clickable, but it
                            // has to give way when the whole video is being
                            // squeezed to fit, or the sum of the floors would
                            // be wider than the space we are fitting into.
                            width: Math.max(pxPerSecond < 12 ? 4 : narrow ? 12 : 20, seconds * pxPerSecond),
                            background: "var(--bg-progress)",
                            border: `1px solid ${selected ? "oklch(0.72 0.25 285)" : "var(--bd-6)"}`,
                            boxShadow: selected ? "0 0 0 2px oklch(0.72 0.25 285 / 0.25)" : "none",
                          }}
                        >
                          {isClip && b.videoUrl ? (
                            // The clip itself, because the clip is what gets
                            // assembled. Its first frame stands in for it, laid
                            // out like the still head frame below rather than
                            // stretched across the block.
                            //
                            // preload="metadata" plus a #t fragment: enough of
                            // the file to paint one frame, not the whole clip
                            // times nineteen every time this page opens.
                            <video
                              src={`${b.videoUrl}#t=0.1`}
                              muted
                              playsInline
                              preload="metadata"
                              tabIndex={-1}
                              className="absolute left-0 top-0 h-full w-auto max-w-none pointer-events-none"
                            />
                          ) : b.imageUrl ? (
                            // Tiled, not stretched. The block's width is the
                            // beat's duration, so a six-second beat is 240px
                            // wide and a single cover-fitted thumbnail became a
                            // thin horizontal slice of the image. Repeating the
                            // frame at its own aspect ratio is what a filmstrip
                            // in any editor actually shows, and it keeps the
                            // picture recognisable at every duration.
                            <span
                              className="absolute inset-0"
                              style={{
                                // Behind the head frame: the same picture,
                                // heavily dimmed, so the tail of a long beat
                                // still belongs to it.
                                backgroundColor: "var(--bg-progress)",
                                backgroundImage: `url(${b.imageUrl})`,
                                backgroundSize: "auto 100%",
                                backgroundRepeat: "no-repeat",
                                backgroundPosition: "left center",
                              }}
                            />
                          ) : (
                            <span className="absolute inset-0 flex items-center justify-center text-[9px]"
                              style={{ color: "var(--c-30)" }}>
                              {b.beatNumber}
                            </span>
                          )}

                          {/* A clip is tinted rather than labelled: at 20px wide
                              there is no room for a word. Lighter than it was,
                              now that the tint sits over the clip's own frame
                              and not over the still that stood in for it. */}
                          {isClip && <span className="absolute inset-0" style={{ background: "oklch(0.55 0.15 240 / 0.16)" }} />}

                          {/* A scrim, so the number stays legible over a bright
                              image without dimming the whole thumbnail. */}
                          {(b.imageUrl || b.videoUrl) && (
                            <span className="absolute inset-x-0 top-0 h-5 pointer-events-none"
                              style={{ background: "linear-gradient(oklch(0 0 0 / 0.55), transparent)" }} />
                          )}
                          {(b.imageUrl || b.videoUrl) && (
                            <span className="absolute top-[3px] left-[4px] text-[9px] font-semibold tabular-nums leading-none"
                              style={{ color: "oklch(1 0 0 / 0.85)" }}>
                              {b.beatNumber}
                            </span>
                          )}

                          {/* Its own effect, if it has one. A bar rather than a
                              label: the narrowest block here is 20px. */}
                          {b.imageMotion && (
                            <span className="absolute bottom-0 left-0 right-0 h-[3px]"
                              style={{ background: "oklch(0.72 0.25 285)" }} />
                          )}
                          {/* A sound on this beat. A dot rather than a label:
                              the narrowest block here is 12px. */}
                          {b.soundEffect && (
                            <span className="absolute top-[3px] right-[3px] w-1.5 h-1.5 rounded-full"
                              style={{ background: "oklch(0.66 0.14 60)", boxShadow: "0 0 3px oklch(0 0 0 / 0.6)" }} />
                          )}
                        </button>
                      );
                    }); })()}
                  </div>

                  {/* The audio, stacked below the video the way an editor
                      stacks it. Two tracks because there are two things making
                      sound, and each says whether it is in the render. */}
                  <div className="mt-[3px] space-y-[3px]">
                    <div className="relative h-5 rounded-md flex items-center"
                      style={{ background: "oklch(0.55 0.15 145 / 0.18)", border: "1px solid oklch(0.55 0.15 145 / 0.35)" }}>
                      {/* Sticky, not scrolled away: the mute and the level are
                          the controls for the whole track, and a track is as
                          wide as the video. Opaque, since the strip runs under
                          it. The gradient is the row's own tint composited over
                          the panel, so the block does not read as a hole. */}
                      <div className="sticky left-0 z-10 h-full flex items-center gap-2 px-2 rounded-md"
                        style={{ background: "linear-gradient(oklch(0.55 0.15 145 / 0.18), oklch(0.55 0.15 145 / 0.18)), var(--bg-panel)" }}>
                      {/* Not mutable, and it should not pretend to be. Every
                          beat's length comes from its narration, so a silent
                          voiceover is not a quieter video, it is a video with
                          no timing at all. */}
                      <span title="The narration sets every beat's length, so the video cannot be built without it"
                        className="shrink-0 cursor-help flex items-center" style={{ color: "oklch(0.62 0.13 145)" }}>
                        <Volume2 size={11} />
                      </span>
                      <span className="text-[9px] font-medium leading-none whitespace-nowrap" style={{ color: "oklch(0.62 0.13 145)" }}>
                        Narration{trimSilence ? " · silences trimmed" : ""}
                      </span>
                      </div>
                      {/* Preview only, and the tooltip says so. The worker has
                          no narration level: the voiceover is the reference the
                          rest is mixed against. Pinned to the right edge, where
                          a fader belongs and where a phone can still reach it. */}
                      <div className="sticky right-0 z-10 ml-auto h-full flex items-center px-2 rounded-md"
                        style={{ background: "linear-gradient(oklch(0.55 0.15 145 / 0.18), oklch(0.55 0.15 145 / 0.18)), var(--bg-panel)" }}>
                      <input
                        type="range"
                        min={0} max={1} step={0.05}
                        value={narrationPreviewVolume}
                        onChange={(e) => setNarrationPreviewVolume(Number(e.target.value))}
                        title="Narration level while previewing here. Does not change the render."
                        aria-label="Narration preview volume"
                        className="w-16 h-1 accent-[oklch(0.62_0.13_145)]"
                      />
                      </div>
                    </div>

                    <div className="relative h-5 rounded-md flex items-center"
                      style={{
                        background: bgmPreviewUrl && bgmVolume > 0 ? "oklch(0.62 0.15 60 / 0.16)" : "var(--bg-track)",
                        border: `1px solid ${bgmPreviewUrl && bgmVolume > 0 ? "oklch(0.62 0.15 60 / 0.35)" : "var(--bd-6)"}`,
                        opacity: bgmPreviewUrl ? 1 : 0.5,
                      }}>
                      {/* Where the track starts over. The worker loops the
                          music to cover the narration, so the row runs the
                          whole length either way; these say it is the same
                          piece coming round again rather than one long one. */}
                      {bgmPreviewUrl && bgmDuration && bgmVolume > 0 &&
                        Array.from({ length: Math.min(200, Math.floor(timelineTotal / bgmDuration)) }, (_, i) => (
                          <span
                            key={i}
                            className="absolute top-0 bottom-0 w-px pointer-events-none"
                            style={{ left: (i + 1) * bgmDuration * pxPerSecond, background: "oklch(0.66 0.14 60 / 0.5)" }}
                          />
                        ))}
                      <div className="sticky left-0 z-10 h-full flex items-center gap-2 px-2 rounded-md"
                        style={{ background: bgmPreviewUrl && bgmVolume > 0
                          ? "linear-gradient(oklch(0.62 0.15 60 / 0.16), oklch(0.62 0.15 60 / 0.16)), var(--bg-panel)"
                          : "var(--bg-panel)" }}>
                      <button
                        type="button"
                        disabled={!bgmPreviewUrl || assembling}
                        onClick={() => {
                          if (bgmVolume > 0) {
                            bgmLevelBeforeMute.current = bgmVolume;
                            setBgmVolume(0);
                          } else {
                            setBgmVolume(bgmLevelBeforeMute.current || 0.15);
                          }
                        }}
                        title={!bgmPreviewUrl ? "No music added" : bgmVolume > 0 ? "Mute the music" : "Unmute the music"}
                        className="shrink-0 flex items-center disabled:cursor-not-allowed transition-opacity hover:opacity-80"
                        style={{ color: bgmPreviewUrl && bgmVolume > 0 ? "oklch(0.66 0.14 60)" : "var(--c-38)" }}
                      >
                        {bgmPreviewUrl && bgmVolume > 0 ? <Volume2 size={11} /> : <VolumeX size={11} />}
                      </button>
                      <span className="text-[9px] font-medium leading-none whitespace-nowrap"
                        style={{ color: bgmPreviewUrl && bgmVolume > 0 ? "oklch(0.66 0.14 60)" : "var(--c-38)" }}>
                        {!bgmPreviewUrl
                          ? "Music · none added"
                          : bgmVolume > 0
                            ? `Music · ${Math.round(bgmVolume * 100)}%${
                                bgmDuration && timelineTotal > bgmDuration
                                  ? ` · loops ×${Math.ceil(timelineTotal / bgmDuration)}`
                                  : ""}`
                            : "Music · muted"}
                      </span>
                      </div>
                      {/* This one is real: the same value the worker mixes the
                          bed at, so what you hear is what gets rendered. */}
                      <div className="sticky right-0 z-10 ml-auto h-full flex items-center px-2 rounded-md"
                        style={{ background: bgmPreviewUrl && bgmVolume > 0
                          ? "linear-gradient(oklch(0.62 0.15 60 / 0.16), oklch(0.62 0.15 60 / 0.16)), var(--bg-panel)"
                          : "var(--bg-panel)" }}>
                      <input
                        type="range"
                        min={0} max={0.6} step={0.01}
                        value={bgmVolume}
                        disabled={!bgmPreviewUrl || assembling}
                        onChange={(e) => setBgmVolume(Number(e.target.value))}
                        title="Music level in the finished video"
                        aria-label="Music volume"
                        className="w-16 h-1 accent-[oklch(0.66_0.14_60)] disabled:opacity-30"
                      />
                      </div>
                    </div>
                  </div>
                  </div>
                </div>
              </div>

            </div>
            )}

            {/* Assembly controls */}
            <div className="rounded-2xl p-5 space-y-4" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              {showPreview && previewUrl && !previewLoadError && (
                <video
                  key={previewUrl}
                  src={previewUrl}
                  controls
                  // Size to the clip's own aspect ratio: width fills up to
                  // the panel, height is capped so a 9:16 portrait render
                  // doesn't blow up — the video keeps its true shape and
                  // centers instead of stretching.
                  className="mx-auto block max-h-[70vh] rounded-xl"
                  style={{ background: "var(--bg-page-2)", maxWidth: "100%" }}
                  onError={() => setPreviewLoadError(true)}
                  onLoadedMetadata={() => setPreviewLoadError(false)}
                />
              )}
              {showPreview && previewLoadError && (
                <div
                  className="w-full rounded-xl p-5 text-center space-y-1"
                  style={{ background: "var(--bg-page-2)", border: "1px solid var(--bd-card)" }}
                >
                  <p className="text-sm font-medium" style={{ color: "var(--c-78)" }}>
                    Preview unavailable
                  </p>
                  <p className="text-xs" style={{ color: "var(--c-50)" }}>
                    The cached preview file may have expired. Click Reassemble to rebuild it.
                  </p>
                </div>
              )}

              {/* In-progress preview — visible while assembling, only
                  after the worker has uploaded mixed.mp4. The video is
                  watchable but is missing the final-burn pass (captions
                  + logo bake + upscale), so we label it clearly so the
                  user knows the cosmetic touch-ups are still rendering. */}
              {assembling && inProgressPreviewUrl && (
                <div className="space-y-2">
                  <video
                    key={inProgressPreviewUrl}
                    src={inProgressPreviewUrl}
                    controls
                    className="mx-auto block max-h-[70vh] rounded-xl"
                    style={{ background: "var(--bg-page-2)", maxWidth: "100%" }}
                  />
                  <p className="text-sm text-center font-medium leading-snug" style={{ color: "var(--accent-amber-text)" }}>
                    Preview — finishing up
                  </p>
                </div>
              )}

              {assembling && (() => {
                /* Stage-aware progress: the worker emits short status strings
                   for each phase via setProgress(); we match the current one
                   to a known stage and render every stage with a done/doing/
                   pending indicator + an overall % bar.

                   `paused` freezes the animations the moment the user clicks
                   Stop. Without this the per-step spinner + indeterminate
                   stripe keep moving while we wait the few seconds for the
                   worker to acknowledge — visually indistinguishable from
                   normal progress, which makes the Stop click feel ignored.
                   Active when stopRequested (user clicked Stop),
                   finalizeRequested (user clicked Use this version), or
                   the worker has already transitioned to "stopped". */
                const paused = stopRequested || finalizeRequested || project?.assembly_status === "stopped";
                const stopped = project?.assembly_status === "stopped";
                // Matchers are tightened so each one only catches its own
                // worker progress string. The old "Downloading" prefix
                // greedily swallowed bgm and logo downloads too, which
                // collapsed them into the voiceover stage and hid that they
                // were happening. The worker emits the exact strings shown
                // below (assemble.ts), so anchor to them precisely.
                // Stage list only includes stages that map to a real
                // worker pass after the assemble pipeline refactor:
                //   - Logo overlay was baked into normalizeClip — the
                //     "Downloading channel logo…" status is folded into
                //     the clips stage match because it's a brief prelude
                //     to clip processing, not its own pass.
                //   - Burning captions was baked into normalizeClip too,
                //     so the standalone "Burn captions" stage is gone.
                //   - "Generate captions" never had a worker progress
                //     line of its own; the only meaningful caption-prep
                //     wait is the optional translate call, kept as its
                //     own stage when captions translation is needed.
                //   - join only matches the final visuals concat now;
                //     "Joining per-beat audio…" lands in voiceover.
                // Five high-level stages. The previous 9-step layout
                // exposed pipeline internals (transcribe, translate,
                // download bgm, restore-from-checkpoint) that the
                // user can't act on and that change run-to-run based
                // on whether captions/translation/BGM are configured.
                // Collapsing into Prepare / Build clips / Mix audio /
                // Burn captions / Upload keeps the count stable and
                // the labels meaningful regardless of options.
                const stages = [
                  // Prepare: queue claim, voiceover ready, transcribe,
                  // translate, channel-logo download (the latter is
                  // an early-stage prereq, not part of clip encoding).
                  { key: "prepare",    label: "Prepare",         match: (s: string) => (
                    s.startsWith("Loading") || s === "Queued…" || s === "Starting…"
                    || s.startsWith("Preparing") || s.startsWith("Prepared") || s.startsWith("Downloading voiceover") || s === "Joining per-beat audio…"
                    || s.startsWith("Transcribing") || s.startsWith("Translating")
                  ) },
                  // Build clips: per-beat encode pass + the post-encode
                  // "Finalizing…" debounce the worker emits when a
                  // worker pool finishes its last beat.
                  { key: "clips",      label: "Build clips",     match: (s: string) => s.startsWith("Processing") || s.startsWith("Finalizing") },
                  // Mix audio: join clips, freeze-pad, BGM + logo
                  // download, and the actual mix pass. Logo download
                  // lives here now (used to be a Stage B prereq) so
                  // both BGM and logo prep land in one user-visible
                  // step. The freeze-pad only fires in legacy mode
                  // with trailing silence; folding it in keeps step
                  // counts run-stable.
                  { key: "mix",        label: "Mix audio",       match: (s: string) => (
                    s === "Joining clips…" || s.startsWith("Padding video") || s.startsWith("Restoring joined") || s.startsWith("Restoring padded")
                    || s.startsWith("Downloading background music") || s.startsWith("Downloading channel logo")
                    || s.startsWith("Mixing") || s.startsWith("Restoring mixed")
                  ) },
                  // Stage F removed in the post-Coconut refactor.
                  // Captions are baked per-beat during Build clips;
                  // logo composites at Mix audio; there's no final-
                  // burn pass anymore. mixed.mp4 IS the final video,
                  // which uploads directly from Stage D's output.
                  { key: "upload",     label: "Upload",          match: (s: string) => s.startsWith("Uploading") },
                ];
                // Monotonic stage index: once we've seen progress to
                // a later stage, don't ever fall back to an earlier
                // one. The worker occasionally writes transient
                // status lines that don't match any rule (e.g. a
                // "Validating…" / "Cleaning up…" between stages),
                // which would otherwise drop findIndex to -1 and
                // make the progress bar visibly jump back to step 1
                // before snapping forward on the next matching line.
                const i = stages.findIndex((s) => s.match(assembleStatus));
                if (i > lastStageIdxRef.current) lastStageIdxRef.current = i;
                else if (i === -1 && lastStageIdxRef.current === -1) lastStageIdxRef.current = 0;
                const currentIdx = lastStageIdxRef.current >= 0 ? lastStageIdxRef.current : 0;
                const pct = Math.round((currentIdx / stages.length) * 100);

                return (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs" style={{ color: "var(--c-45)" }}>
                        <span>Step {currentIdx + 1} of {stages.length}</span>
                        <span>{pct}%</span>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                        <div className="h-full transition-all duration-500"
                          style={{ width: `${pct}%`, background: "oklch(0.72 0.25 285)" }} />
                      </div>
                    </div>

                    <ul className="space-y-2">
                      {stages.map((s, i) => {
                        const done = i < currentIdx;
                        const doing = i === currentIdx;
                        // While the in-progress preview is showing,
                        // the user already knows the early stages
                        // completed — they're watching the video.
                        // Collapse the list to only the still-active
                        // and pending steps so the panel focuses on
                        // what they're waiting for (Finalize, Upload).
                        // The overall % bar + "Step X of N" header
                        // above keep showing total progress.
                        if (inProgressPreviewUrl && done) return null;
                        /* Per-stage progress: parse "X of N" out of the status
                           when possible (clips stage). Otherwise we show an
                           indeterminate animated stripe so the user still sees
                           the stage is actively working. */
                        const clipMatch = doing ? assembleStatus.match(/(\d+)\s+of\s+(\d+)/i) : null;
                        const stagePct = done
                          ? 100
                          : doing && clipMatch
                          ? Math.round((parseInt(clipMatch[1], 10) / parseInt(clipMatch[2], 10)) * 100)
                          : 0;
                        const showIndeterminate = doing && !clipMatch;
                        // Active-step palette swaps to amber when paused so
                        // the row visually reads "halted here" rather than
                        // "still working." `pausedHere` only fires on the
                        // doing step; other steps keep their done/pending
                        // styling regardless.
                        const pausedHere = paused && doing;
                        return (
                          <li key={s.key} className="space-y-1">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                                style={{
                                  background: done ? "oklch(0.55 0.15 145 / 0.15)" : pausedHere ? "oklch(0.65 0.18 60 / 0.15)" : doing ? "oklch(0.72 0.25 285 / 0.15)" : "var(--bg-track)",
                                  border: `1px solid ${done ? "oklch(0.55 0.15 145 / 0.4)" : pausedHere ? "oklch(0.65 0.18 60 / 0.5)" : doing ? "oklch(0.72 0.25 285 / 0.4)" : "var(--bd-7)"}`,
                                  color: done ? "oklch(0.7 0.15 145)" : pausedHere ? "var(--accent-amber-text)" : doing ? "var(--accent-purple-text)" : "var(--c-35)",
                                  fontSize: "9px",
                                }}>
                                {done ? "✓" : pausedHere ? (
                                  // Pause glyph: two short vertical bars.
                                  // Inline SVG so it inherits currentColor
                                  // and doesn't pull in an icon dep.
                                  <svg width="7" height="8" viewBox="0 0 6 8" fill="currentColor"><rect x="0" y="0" width="2" height="8" rx="0.5" /><rect x="4" y="0" width="2" height="8" rx="0.5" /></svg>
                                ) : doing ? (
                                  <span className="w-2 h-2 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" />
                                ) : i + 1}
                              </span>
                              <span className="flex-1" style={{ color: done ? "var(--c-55)" : doing ? "var(--c-65)" : "var(--c-40)", fontWeight: doing ? 600 : 400 }}>
                                {/* The load stage bundles three meaningfully
                                   different states (Queued… / Starting… /
                                   Loading project data…) under one static
                                   label, so a user sitting in a queue can't
                                   tell whether the worker is busy with
                                   someone else's project or just slow to
                                   pick up theirs. When this is the active
                                   stage, surface the raw worker status
                                   instead of the catch-all label. Other
                                   stages keep their polished labels — their
                                   raw status strings are less readable. */}
                                {doing && s.key === "load" ? (assembleStatus || s.label) : s.label}
                              </span>
                              {doing && clipMatch && (
                                <span className="text-[10px]" style={{ color: "var(--c-55)" }}>{stagePct}%</span>
                              )}
                            </div>
                            <div className="ml-6 h-1 rounded-full overflow-hidden relative" style={{ background: "var(--bg-track)" }}>
                              {showIndeterminate && !pausedHere ? (
                                <div className="progress-indeterminate h-full"
                                  style={{ background: "oklch(0.72 0.25 285)" }} />
                              ) : pausedHere ? (
                                // Frozen stripe — solid amber at a fixed
                                // fill so the user can still see this is
                                // the active step, just not animating.
                                <div className="h-full"
                                  style={{ width: "30%", background: "oklch(0.72 0.18 60)" }} />
                              ) : (
                                <div className="h-full transition-all duration-500"
                                  style={{
                                    width: `${stagePct}%`,
                                    background: done ? "oklch(0.7 0.15 145)" : "oklch(0.72 0.25 285)",
                                  }} />
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>

                    <p className="text-[11px] text-center leading-snug" style={{ color: paused ? "oklch(0.7 0.15 60)" : "var(--c-45)" }}>
                      {/* While the worker is acknowledging an
                          interrupt, surface the right "…" line so
                          the click doesn't feel ignored. Once the
                          worker transitions to stopped/done, the
                          useEffect above sets assembleStatus to a
                          terminal line and we fall through. */}
                      {finalizeRequested && !stopped
                        ? "Stopping to confirm preview…"
                        : stopRequested && !stopped
                        ? "Stopping…"
                        : (assembleStatus || "Working…")}
                    </p>

                    {project?.assembly_status === "stopped" ? (
                      // Two stopped flavors:
                      //   - Stopped via "Use this version":
                      //     assembly_finalize_preview_requested stays
                      //     true after the worker's stop, signaling
                      //     the user wants to ship the preview. Show
                      //     Continue instead of Resume — clicking it
                      //     promotes the preview to assembled_url and
                      //     marks the assembly done without running
                      //     any remaining work.
                      //   - Stopped via Stop: the usual Resume path.
                      finalizeRequested ? (
                        <div className="flex gap-2">
                          <button onClick={() => setCancelAssemblyConfirmOpen(true)}
                            disabled={cancellingAssembly || committingPreview}
                            className="flex-1 py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-40"
                            style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}>
                            Cancel
                          </button>
                          <button onClick={commitPreview}
                            disabled={cancellingAssembly || committingPreview}
                            className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                            {committingPreview ? "Continuing…" : "Continue"}
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button onClick={() => setCancelAssemblyConfirmOpen(true)}
                            disabled={cancellingAssembly}
                            className="flex-1 py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-40"
                            style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}>
                            Cancel
                          </button>
                          <button onClick={resumeAssembly}
                            disabled={cancellingAssembly}
                            className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                            Resume
                          </button>
                        </div>
                      )
                    ) : inProgressPreviewUrl ? (
                      // Two-button row whenever the in-progress preview
                      // is available: "Use this version" promotes the
                      // preview to the final assembled video and skips
                      // the remaining final-burn re-encode (saves 5-25
                      // min on long projects); Stop preserves the
                      // checkpoint for later Resume. Disabled-state
                      // labels reflect whichever click is in flight.
                      <div className="flex gap-2">
                        <button onClick={stopAssembly} disabled={stopRequested || finalizeRequested}
                          className="flex-1 py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-40"
                          style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}>
                          {stopRequested ? "Stopping…" : "Stop"}
                        </button>
                        <button onClick={finalizeWithPreview} disabled={finalizeRequested || stopRequested}
                          className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                          style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                          {finalizeRequested ? "Finalizing…" : "Export anyway"}
                        </button>
                      </div>
                    ) : (
                      <button onClick={stopAssembly} disabled={stopRequested}
                        className="w-full py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-40"
                        style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}>
                        {stopRequested ? "Stopping…" : "Stop"}
                      </button>
                    )}
                    <p className="text-[11px] text-center" style={{ color: "var(--c-35)" }}>Progress updates every ~5 seconds…</p>
                  </div>
                );
              })()}

              {showPreview && previewUrl && (
                <div className="mx-auto" style={{ maxWidth: previewMaxW }}>
                  <div className="flex gap-2">
                    <button onClick={() => setReassembleConfirmOpen(true)}
                      className="flex-1 py-2.5 rounded-xl text-xs font-medium transition-all"
                      style={previewLoadError
                        // When the preview can't load, Reassemble is the
                        // only path forward — promote it to the theme
                        // purple so it reads as the primary CTA.
                        ? { background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }
                        : { background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-card)" }}>
                      Reassemble
                    </button>
                    {/* Hide Export when the preview can't load — its
                        href points at the same URL the player just
                        failed on, so clicking it would 404 too.
                        Reassemble fills the row via flex-1.
                        The href goes through our export route (which
                        302s to a presigned attachment URL) instead of
                        the raw R2 URL — the anchor `download`
                        attribute is ignored cross-origin, so linking
                        R2 directly opened the video in the tab
                        instead of downloading it. */}
                    {!previewLoadError && (
                      <a
                        href={`/api/projects/${projectId}/export-video?url=${encodeURIComponent(previewUrl)}&filename=${encodeURIComponent(`${(project?.channel_name as string | undefined)?.trim() || "video"}.mp4`)}`}
                        className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-center transition-all"
                        style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                        ↓ Export
                      </a>
                    )}
                  </div>
                  <button
                    onClick={() => router.push(`/projects/${projectId}/thumbnails`)}
                    disabled={previewLoadError}
                    title={previewLoadError ? "Reassemble the video before continuing — the cached preview can't be loaded." : undefined}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)", marginTop: "50px", marginBottom: "20px" }}
                  >
                    Generate Thumbnail →
                  </button>
                </div>
              )}

              {!showPreview && !assembling && uploadFailedPreview && (
                <div className="space-y-2">
                  <div className="rounded-xl p-3" style={{ background: "oklch(0.6 0.22 25 / 0.08)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}>
                    <p className="text-xs font-semibold" style={{ color: "oklch(0.7 0.2 25)" }}>
                      Upload to cloud failed
                    </p>
                    <p className="text-xs mt-1" style={{ color: "var(--c-55)" }}>
                      Your assembled video is preserved on the worker. Retry just the upload — no need to re-render.
                    </p>
                    {project?.assembly_error && (
                      <p className="text-[10px] mt-1.5 font-mono break-all" style={{ color: "var(--c-40)" }}>
                        {project.assembly_error as string}
                      </p>
                    )}
                  </div>
                  <button onClick={retryUpload} disabled={assembling}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 transition-all"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                    {assembling ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Uploading…
                      </span>
                    ) : "Retry Upload"}
                  </button>
                  <button onClick={() => assembleVideo()} disabled={assembling}
                    className="w-full py-2 rounded-xl text-xs font-medium disabled:opacity-60 transition-all"
                    style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", color: "var(--c-55)" }}>
                    {assembling ? "Queuing…" : "Or reassemble from scratch"}
                  </button>
                </div>
              )}

              {!showPreview && !assembling && !uploadFailedPreview && (
                <>
                  {reassembleMode && (
                    <p className="text-xs text-center py-1" style={{ color: "var(--c-50)" }}>
                      Reassembling — review the settings above, then click <strong>Assemble</strong> to start.
                    </p>
                  )}
                  {!hasVoiceover && (
                    <p className="text-xs text-center py-1" style={{ color: "var(--c-40)" }}>
                      Generate a voiceover on the Generate page first.
                    </p>
                  )}
                  <div className="flex gap-2">
                    {reassembleMode && (
                      <button onClick={() => setReassembleMode(false)} disabled={assembling}
                        className="flex-1 py-2.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                        style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", color: "var(--c-55)" }}>
                        Cancel
                      </button>
                    )}
                    <button onClick={() => assembleVideo()} disabled={!hasVoiceover || assembling}
                      className={`${reassembleMode ? "flex-1" : "w-full"} py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all`}
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                      {assembling ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Queuing…
                        </span>
                      ) : reassembleMode ? "Assemble" : "Assemble Final Video"}
                    </button>
                  </div>
                </>
              )}
            </div>

          </div>{/* end left column */}

        </div>
      </main>

      <Dialog open={reassembleConfirmOpen} onOpenChange={(open) => { if (!clearingAssembled) setReassembleConfirmOpen(open); }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Reassemble video?</DialogTitle>
            <DialogDescription>
              This will <strong>permanently delete</strong> the current assembled video from storage and clear the preview. You&apos;ll then be able to choose the voiceover and adjust the captions / aspect ratio before starting a fresh run. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setReassembleConfirmOpen(false)}
              disabled={clearingAssembled}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{ background: "transparent", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
            >
              Cancel
            </button>
            <button
              onClick={confirmReassemble}
              disabled={clearingAssembled}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-60"
              style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
            >
              {clearingAssembled ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Deleting…
                </span>
              ) : "Delete & reassemble"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bgmDisclaimerOpen} onOpenChange={setBgmDisclaimerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Background music disclaimer</DialogTitle>
            <DialogDescription>
              We do not take responsibility for copyright claims on background music. Please ensure you have the rights to use any track you upload.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setBgmDisclaimerOpen(false)}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              Got it
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelAssemblyConfirmOpen} onOpenChange={(open) => { if (!cancellingAssembly) setCancelAssemblyConfirmOpen(open); }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Cancel this assembly?</DialogTitle>
            <DialogDescription>
              This will <strong>discard the in-progress assembly</strong> — all intermediate work (transcription, encoded clips, joined / padded / mixed video) will be deleted from storage and you won&apos;t be able to Resume. Your previously assembled video (if any) is kept. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setCancelAssemblyConfirmOpen(false)}
              disabled={cancellingAssembly}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{ background: "transparent", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
            >
              Keep
            </button>
            <button
              onClick={cancelAssembly}
              disabled={cancellingAssembly}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-60"
              style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
            >
              {cancellingAssembly ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Cancelling…
                </span>
              ) : "Yes, cancel"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showUpgradeModal && (
        <SubscriptionModal
          email={userEmail}
          defaultPlan="pro"
          hideTryDemo
          onClose={() => setShowUpgradeModal(false)}
          onSuccess={() => setShowUpgradeModal(false)}
        />
      )}
    </div>
  );
}
