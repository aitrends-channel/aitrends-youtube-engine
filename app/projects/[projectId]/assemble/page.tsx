"use client";

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { StepCostCard } from "@/components/StepCostCard";
import { CostTipsModal } from "@/components/CostTipsModal";
import { StepBalanceCard } from "@/components/StepBalanceCard";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import { Volume2, VolumeX, Play, Pause, ChevronDown, ChevronRight, Ban, Check, X, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { Beat, ProjectElement, ProjectText, ProjectSound } from "@/lib/types";
import useSWR from "swr";
import { FullVoiceoverPreview } from "@/components/voiceover/FullVoiceoverPreview";
import { presignedUpload } from "@/lib/upload-client";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { SubscriptionModal } from "@/components/SubscriptionModal";
import { requiredTierForResolution, tierForPlan, tierRank, tierLabel } from "@/lib/plans-gating";
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

/** The shapes the worker ships, drawn by its scripts/make-elements.sh and
 *  copied into public/elements so the browser shows the same files. */
const ELEMENTS = [
  // The furniture people actually put on a video, each in the colour its
  // platform uses: a grey pill reads as a caption rather than as a button.
  { id: "subscribe",  label: "Subscribe" },
  { id: "subscribed", label: "Subscribed" },
  { id: "like",       label: "Like" },
  { id: "share",      label: "Share" },
  { id: "follow",     label: "Follow" },
  { id: "comment",    label: "Comment" },
  { id: "new",        label: "New" },
  { id: "live",       label: "Live" },
  // A mark rather than a word: it needs no translating, and it is what people
  // actually leave in a corner.
  { id: "bell",       label: "Bell" },
  { id: "bell-ring",  label: "Bell ringing" },
  { id: "youtube",    label: "YouTube" },
  { id: "instagram",  label: "Instagram" },
  { id: "tiktok",     label: "TikTok" },
  { id: "facebook",   label: "Facebook" },
  { id: "x",          label: "X" },
  { id: "whatsapp",   label: "WhatsApp" },
  { id: "heart",      label: "Heart" },
  { id: "thumbs-up",  label: "Thumbs up" },
] as const;

const ELEMENT_DEFAULTS = { x: 0.7, y: 0.1, size: 0.14 };

/** Every treatment the worker can draw. Not a font list: variety in an editor
 *  like CapCut is mostly typeface, and the worker ships one face, so a preset
 *  naming a font it does not have would render as the same face renamed. */
const TEXT_STYLES = [
  { id: "plain",         label: "Plain" },
  { id: "thin",          label: "Thin" },
  { id: "outline",       label: "Outline" },
  { id: "heavy",         label: "Heavy" },
  { id: "outline-white", label: "White edge" },
  { id: "glow",          label: "Glow" },
  { id: "glow-warm",     label: "Warm glow" },
  { id: "shadow",        label: "Shadow" },
  { id: "shadow-soft",   label: "Soft drop" },
  { id: "shadow-hard",   label: "Hard drop" },
  { id: "poster",        label: "Poster" },
  { id: "lift",          label: "Lift" },
  { id: "side",          label: "Side" },
  { id: "glow-cool",     label: "Cool glow" },
  { id: "edge-red",      label: "Red edge" },
  { id: "faded",         label: "Faded" },
] as const;

type TextStyleId = typeof TEXT_STYLES[number]["id"];

/**
 * The same treatment in CSS, for the preview and the template tiles.
 *
 * Widths are in em so a style holds its proportions at any size, which is how
 * the worker does it too: there the stroke is a fraction of the font size, so
 * the two stay in step from a caption to a title card.
 */
function textStyleCss(style: string, bgColour?: string | null, bgOpacity = 0.55): React.CSSProperties {
  const panel: React.CSSProperties = bgColour
    ? { background: hexToRgba(bgColour, bgOpacity), padding: "0.12em 0.25em" }
    // What box and box-light meant, for a row written before the columns did.
    : style === "box" ? { background: "rgba(0,0,0,0.55)", padding: "0.12em 0.25em" }
    : style === "box-light" ? { background: "rgba(255,255,255,0.85)", padding: "0.12em 0.25em" }
    : {};
  return { ...panel, ...glyphCss(style) };
}

/** #RGB or #RRGGBB plus an alpha, because CSS cannot take ffmpeg's colour@a. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(0,0,0,${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha))})`;
}

function glyphCss(style: string): React.CSSProperties {
  switch (style) {
    case "thin":          return { WebkitTextStroke: "0.03em rgba(0,0,0,0.7)", paintOrder: "stroke fill" };
    case "outline":       return { WebkitTextStroke: "0.06em rgba(0,0,0,0.85)", paintOrder: "stroke fill" };
    case "heavy":         return { WebkitTextStroke: "0.12em rgba(0,0,0,0.9)", paintOrder: "stroke fill" };
    case "outline-white": return { WebkitTextStroke: "0.06em rgba(255,255,255,0.9)", paintOrder: "stroke fill" };
    case "glow":          return { WebkitTextStroke: "0.10em rgba(255,255,255,0.55)", paintOrder: "stroke fill" };
    case "glow-warm":     return { WebkitTextStroke: "0.10em rgba(255,212,0,0.6)", paintOrder: "stroke fill" };
    case "shadow":        return { textShadow: "0.05em 0.05em 0 rgba(0,0,0,0.75)" };
    case "shadow-soft":   return { textShadow: "0.025em 0.025em 0 rgba(0,0,0,0.45)" };
    case "shadow-hard":   return { textShadow: "0.09em 0.09em 0 rgba(0,0,0,0.95)" };
    case "lift":          return { textShadow: "0 0.07em 0 rgba(0,0,0,0.7)" };
    case "side":          return { textShadow: "0.07em 0 0 rgba(0,0,0,0.7)" };
    case "glow-cool":     return { WebkitTextStroke: "0.10em rgba(0,199,190,0.6)", paintOrder: "stroke fill" };
    case "edge-red":      return { WebkitTextStroke: "0.06em rgba(211,47,47,0.9)", paintOrder: "stroke fill" };
    // Both at once, which is the whole point of it.
    case "poster":        return {
      WebkitTextStroke: "0.055em rgba(0,0,0,0.95)", paintOrder: "stroke fill",
      textShadow: "0.09em 0.09em 0 rgba(0,0,0,0.6)",
    };
    // Opacity, not a paler colour, so it fades against whatever is behind it
    // rather than turning grey on a dark shot.
    case "faded":         return { opacity: 0.6 };
    default:          return {};
  }
}

/** What a text overlay can be. A short list rather than a colour well: these
 *  read on footage, and a free picker mostly produces text nobody can see. */
/**
 * How long each sound actually is, in seconds.
 *
 * Measured off the files in the worker's assets/sfx. Held here so a block can
 * be drawn at its real length before anything has been played: the browser
 * only learns a duration once it has fetched and decoded the audio, and a
 * timeline that resizes its blocks after the fact is worse than one that never
 * sized them.
 *
 * Decoded length, not the container's: an mp3 reports a duration that includes
 * encoder padding. Regenerating a sound changes its length, so this list is
 * refreshed the same way its ids are.
 */
const SOUND_SECONDS: Record<string, number> = {
  alert: 0.375, beep: 0.120, bell: 1.800, boom: 0.900, chime: 0.590,
  click: 0.045, ding: 1.100, glitch: 0.250, heartbeat: 0.840, impact: 0.500,
  notification: 0.550, page: 0.280, pop: 0.090, "reverse-whoosh": 0.600,
  riser: 1.200, shutter: 0.140, sparkle: 0.440, sweep: 0.800, swish: 0.320,
  thud: 0.260, tick: 0.030, whoosh: 0.500, "zoom-in": 0.600, "zoom-out": 0.600,
};

/**
 * Bar heights for the little waveform on a sound tile.
 *
 * Deterministic from the id, so a sound looks the same every render and two
 * sounds look different from each other. The heights are decorative and do not
 * come from the audio: drawing a true waveform means decoding two dozen files
 * to fill a picker. The bar COUNT is real, taken from the length, so a long
 * sound genuinely reads as longer than a short one.
 */
function waveformBars(id: string, seconds: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  const count = Math.max(6, Math.min(20, Math.round(6 + seconds * 7)));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    out.push(30 + (h % 70));
  }
  return out;
}

/** The natural length of a sound, or a fallback for one this list has not
 *  caught up with. */
const soundSeconds = (id: string): number => SOUND_SECONDS[id] ?? 0.5;

const TEXT_COLOURS = [
  // Forty, eight to a row, and the row is what makes it readable: neutrals
  // first because most text is one of them, then warm, green, blue and purple
  // runs, each going light to dark. A flat bag of forty swatches is a search;
  // a row you can predict is a choice.
  //
  // The same set serves the words and the panel behind them. Two palettes
  // would be two things to extend, and the pairing people reach for is dark
  // text on a light panel or the reverse, which needs both ends of one set.
  "#FFFFFF", "#EDEDED", "#C7C7C7", "#9A9A9A", "#6B6B6B", "#3F3F3F", "#1C1C1C", "#000000",
  "#FFEB3B", "#FFD400", "#FFB020", "#FF9500", "#FF6B35", "#FF3B30", "#D32F2F", "#7F1D1D",
  "#DCFCE7", "#A3E635", "#7ED957", "#34C759", "#1FA84A", "#2DD4BF", "#00C7BE", "#065F46",
  "#DBEAFE", "#60A5FA", "#3B82F6", "#0A84FF", "#0066CC", "#1E3A8A", "#0EA5E9", "#0C4A6E",
  "#F5D0FE", "#F472B6", "#FF2D95", "#EC4899", "#AF52DE", "#7C3AED", "#4338CA", "#8B5E3C",
];

/**
 * Ways a line is usually used, as a starting point.
 *
 * Placement, size and treatment together, because those are what somebody
 * would otherwise set one control at a time to arrive at the same four or five
 * arrangements. The words are a placeholder to be typed over, not a suggestion.
 *
 * x and y are the top-left corner, which is where drawtext puts a line, so a
 * template cannot centre itself: the render does not know how wide the words
 * are until it draws them. The left-hand positions here are chosen to look
 * deliberate rather than to look centred and miss.
 */
const TEXT_TEMPLATES: {
  id: string; group: "Bold" | "Classic" | "Subtle"; label: string; content: string;
  x: number; y: number; size: number; colour: string; style: TextStyleId;
  bg?: string; bgOpacity?: number;
}[] = [
  // Bold: made to be seen first, over footage that is not helping.
  { id: "callout",  group: "Bold", label: "Callout",  content: "50% off",
    x: 0.58, y: 0.14, size: 0.085, colour: "#FFD400", style: "heavy" },
  { id: "shout",    group: "Bold", label: "Shout",    content: "WATCH THIS",
    x: 0.07, y: 0.12, size: 0.12,  colour: "#FFFFFF", style: "heavy" },
  { id: "alert",    group: "Bold", label: "Alert",    content: "Don't miss it",
    x: 0.07, y: 0.14, size: 0.08,  colour: "#FF3B30", style: "outline" },
  { id: "neon",     group: "Bold", label: "Neon",     content: "NEW",
    x: 0.62, y: 0.12, size: 0.10,  colour: "#0A84FF", style: "glow" },

  // Classic: the arrangements a video uses without anyone noticing them.
  { id: "title",    group: "Classic", label: "Title",       content: "Your title",
    x: 0.07, y: 0.10, size: 0.11,  colour: "#FFFFFF", style: "outline" },
  { id: "sub",      group: "Classic", label: "Subtitle",    content: "Your subtitle",
    x: 0.07, y: 0.24, size: 0.055, colour: "#FFFFFF", style: "outline" },
  { id: "lower",    group: "Classic", label: "Lower third", content: "Name or source",
    x: 0.06, y: 0.80, size: 0.045, colour: "#FFFFFF", style: "plain", bg: "#000000", bgOpacity: 0.55 },
  { id: "banner",   group: "Classic", label: "Banner",      content: "Subscribe for more",
    x: 0.06, y: 0.88, size: 0.05,  colour: "#FFFFFF", style: "plain", bg: "#000000", bgOpacity: 0.7 },
  { id: "tag",      group: "Classic", label: "Tag",         content: "SPECIAL OFFER",
    x: 0.06, y: 0.14, size: 0.05,  colour: "#000000", style: "plain", bg: "#FFFFFF", bgOpacity: 0.85 },

  // Subtle: present without taking the shot over.
  { id: "quote",    group: "Subtle", label: "Quote",   content: "“Something said”",
    x: 0.08, y: 0.44, size: 0.055, colour: "#FFFFFF", style: "shadow" },
  { id: "caption",  group: "Subtle", label: "Note",    content: "A quiet note",
    x: 0.07, y: 0.78, size: 0.042, colour: "#FFFFFF", style: "shadow" },
  { id: "credit",   group: "Subtle", label: "Credit",  content: "Source: somewhere",
    x: 0.06, y: 0.90, size: 0.035, colour: "#FFFFFF", style: "plain" },
];

/**
 * How wide an element lands, as a fraction of the frame.
 *
 * Size sets width and the height follows the artwork, so one number does not
 * mean one size: the buttons are between one and a half and three and a half
 * times as wide as they are tall, and the icon tiles are square. At the
 * buttons' default a tile came out a third of the frame high, which is not a
 * corner badge, it is a watermark.
 */
const SQUARE_ELEMENTS = new Set([
  "bell", "bell-ring",
  "youtube", "instagram", "tiktok", "facebook", "x", "whatsapp",
  "heart", "thumbs-up",
]);

function defaultSizeFor(element: string): number {
  return SQUARE_ELEMENTS.has(element) ? 0.08 : ELEMENT_DEFAULTS.size;
}

/** The sound library, synthesised by the worker's scripts/make-sfx.sh and
 *  copied into public/sfx so the browser can play the same files. */
const SOUND_EFFECTS = [
  // Grouped the way somebody looks for them: movement, small clicks, tones
  // that rise, weight, and things that land well.
  { id: "whoosh",         label: "Whoosh",       hint: "Something passing the camera" },
  { id: "reverse-whoosh", label: "Reverse",      hint: "A whoosh played backwards, before a cut" },
  { id: "swish",          label: "Swish",        hint: "Shorter and higher, for a cut" },
  { id: "sweep",          label: "Sweep",        hint: "Long, for a full cross-fade" },
  { id: "page",           label: "Page",         hint: "Paper turning" },
  { id: "click",          label: "Click",        hint: "A tick, the length of a keystroke" },
  { id: "tick",           label: "Tick",         hint: "Quieter and drier than the click" },
  { id: "pop",            label: "Pop",          hint: "A rounded click with a pitch" },
  { id: "beep",           label: "Beep",         hint: "A flat tone, for a machine" },
  { id: "glitch",         label: "Glitch",       hint: "Noise chopped fast, for an error" },
  { id: "shutter",        label: "Shutter",      hint: "A camera taking the picture" },
  { id: "zoom-in",        label: "Zoom in",      hint: "A tone sweeping up" },
  { id: "zoom-out",       label: "Zoom out",     hint: "The same sweep, downward" },
  { id: "riser",          label: "Riser",        hint: "Noise climbing to a reveal" },
  { id: "impact",         label: "Impact",       hint: "A low hit with a short tail" },
  { id: "boom",           label: "Boom",         hint: "Sub-bass falling away" },
  { id: "thud",           label: "Thud",         hint: "Softer, for something landing" },
  { id: "heartbeat",      label: "Heartbeat",    hint: "Two low thuds, for tension" },
  { id: "chime",          label: "Chime",        hint: "Two tones, for a point made" },
  { id: "ding",           label: "Ding",         hint: "One bell note with a long tail" },
  { id: "sparkle",        label: "Sparkle",      hint: "Three rising notes" },
  { id: "bell",           label: "Bell",         hint: "A struck bell, ringing out" },
  { id: "notification",   label: "Notification", hint: "The two notes a phone plays" },
  { id: "alert",          label: "Alert",        hint: "Three flat beeps, for attention" },
] as const;

/**
 * How a caption looks, for the preview.
 *
 * The render writes an ASS subtitle file and lets libass draw it; this is the
 * same set of decisions in CSS. Font size is a fraction of the frame height in
 * both, so a caption that fits the preview fits the video.
 */
function captionCss(style: string, size: string): React.CSSProperties {
  // 3%, 4% and 5.2% of the frame height, matching buildAssStyle in the worker.
  const scale = size === "small" ? 0.030 : size === "large" ? 0.052 : size === "xl" ? 0.065 : 0.040;
  const base: React.CSSProperties = {
    fontFamily: "Arial, Helvetica, sans-serif",
    fontSize: `${scale * 100}cqh`,
    lineHeight: 1.25,
    textAlign: "center",
  };
  switch (style) {
    case "bold":
      return { ...base, color: "#ffff00", fontWeight: 700, WebkitTextStroke: "0.35cqh #000", paintOrder: "stroke fill" };
    case "boxed":
      return { ...base, color: "#fff", background: "oklch(0 0 0 / 0.5)", padding: "0.4cqh 0.9cqh", borderRadius: "0.3cqh" };
    case "banner":
      return { ...base, color: "#fff", background: "#000", padding: "0.5cqh 1.1cqh" };
    case "highlight":
      return { ...base, color: "#000", fontWeight: 700, background: "#ffff00", padding: "0.5cqh 1.1cqh" };
    case "cinema":
      return { ...base, color: "#fff", WebkitTextStroke: "0.6cqh #000", paintOrder: "stroke fill" };
    case "neon":
      return { ...base, color: "#00ffff", fontWeight: 700, WebkitTextStroke: "0.45cqh #002a70", paintOrder: "stroke fill" };
    case "shadow":
      return { ...base, color: "#fff", textShadow: "0.35cqh 0.35cqh 0.5cqh oklch(0 0 0 / 0.9)" };
    case "soft":
      return { ...base, color: "oklch(1 0 0 / 0.7)", WebkitTextStroke: "0.15cqh oklch(0 0 0 / 0.7)", paintOrder: "stroke fill" };
    case "minimal":
      return { ...base, color: "#fff", WebkitTextStroke: "0.18cqh #000", paintOrder: "stroke fill" };
    default:
      return { ...base, color: "#fff", WebkitTextStroke: "0.35cqh #000", paintOrder: "stroke fill", textShadow: "0.2cqh 0.2cqh 0.3cqh oklch(0 0 0 / 0.8)" };
  }
}

/**
 * One caption, drawn the way the render will draw it.
 *
 * Shared by the captions card and the playback preview, which showed the same
 * caption two different ways before this existed: one animated, one not. Sizes
 * itself in container units, so it must sit inside an element with
 * container-type set and a definite height.
 */
function CaptionOverlay({ text, style, size, position, animation, loop = true }: {
  text: string;
  style: string;
  size: string;
  position: string;
  animation: string;
  /** The picker loops so two options can be compared; playback plays each line
   *  once, because a caption that keeps re-animating on screen reads as stuck. */
  loop?: boolean;
}) {
  const words = text.trim() ? text.trim().split(/\s+/).slice(0, CAPTION_WORDS_PER_LINE) : ["Captions", "appear", "here"];
  const rep = loop ? "infinite alternate both" : "1 normal both";
  const lineRep = loop ? "infinite" : "1";
  const css = captionCss(style, size);
  const place: React.CSSProperties = position === "top" ? { top: "3%" }
    : position === "middle" ? { top: "50%", transform: "translateY(-50%)" }
    : { bottom: "3%" };

  let body: React.ReactNode;
  if (animation === "typewriter") {
    // Per letter rather than per word, which is the only difference between
    // this and reveal.
    const letters = words.join(" ").split("");
    const per = 2.6 / letters.length;
    body = letters.map((ch, i) => (
      <span key={i} style={{
        animation: `caption-word-in 0.05s linear ${(i * per).toFixed(2)}s ${rep}`,
        opacity: 0,
      }}>{ch}</span>
    ));
  } else if (animation === "karaoke" || animation === "reveal") {
    const per = 2.6 / words.length;
    body = words.map((word, i) => (
      <span key={i} style={{
        animation: `${animation === "karaoke" ? "caption-word-lit" : "caption-word-in"} 0.25s ease-out ${(i * per).toFixed(2)}s ${rep}`,
        opacity: animation === "karaoke" ? 0.45 : 0,
      }}>{word}{i < words.length - 1 ? " " : ""}</span>
    ));
  } else {
    body = words.join(" ");
  }

  const lineAnimation = animation === "fade" ? `caption-fade 3s ease-in-out ${lineRep}`
    : animation === "pop" ? `caption-pop 3s ease-in-out ${lineRep}`
    : animation === "slide" ? `caption-slide 3s ease-out ${lineRep}`
    : animation === "grow" ? `caption-grow 3s ease-in-out ${lineRep} alternate`
    : animation === "tilt" ? `caption-tilt 3s ease-out ${lineRep}`
    : animation === "flash" ? `caption-flash 3s ease-out ${lineRep}`
    : undefined;

  return (
    <div className="absolute inset-x-0 flex justify-center px-[6%] pointer-events-none" style={place}>
      {/* Re-keyed on the choice so switching restarts the loop rather than
          joining it halfway. */}
      <span key={`${animation}-${text}`} style={{ ...css, animation: lineAnimation }}>{body}</span>
    </div>
  );
}

/** A frame inside a picker tile: a still, or a clip's first frame when the
 *  project has no stills at all. Both take the same transforms, so every
 *  animation above works either way. */
function TileFrame({ url, isClip, className, style, frameKey }: {
  url: string;
  isClip: boolean;
  className?: string;
  style?: React.CSSProperties;
  frameKey?: string;
}) {
  if (isClip) {
    // preload="metadata" plus a #t fragment: one frame, not the whole clip
    // times however many tiles are on screen.
    return <video key={frameKey} src={`${url}#t=0.1`} muted playsInline preload="metadata" className={className} style={style} />;
  }
  /* eslint-disable-next-line @next/next/no-img-element */
  return <img key={frameKey} src={url} alt="" className={className} style={style} />;
}

/** Words per caption line, matching the worker's own grouping. Change one and
 *  the preview stops showing the lines the render will draw. */
const CAPTION_WORDS_PER_LINE = 7;

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
  // Promoted to its own layer for the length of the seam: without it the
  // browser repaints the whole frame on every step of the blend.
  return { willChange: "transform, opacity, filter", ...seamOutStyle(kind, p, pct) };
}

function seamOutStyle(kind: string, p: number, pct: string): React.CSSProperties {
  switch (kind) {
    case "dissolve":     return { opacity: 1 - p };
    // Two halves: out to the colour by the midpoint, then the layer goes.
    case "fade-black":   return { filter: `brightness(${Math.max(0, 1 - p * 2).toFixed(3)})`, opacity: p < 0.5 ? 1 : 0 };
    case "fade-white":   return { filter: `brightness(${(1 + Math.min(p * 2, 1) * 5).toFixed(3)})`, opacity: p < 0.5 ? 1 : 0 };
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

/**
 * The layer underneath, during a seam. Through-black and through-white pass
 * through a flat colour at the midpoint, and the outgoing layer leaves there.
 * Unless the incoming one has been taken to the same colour to meet it, the
 * frame pops from black straight to a full-brightness shot, halfway through.
 */
function seamUnderStyle(kind: string, p: number): React.CSSProperties | undefined {
  const q = Math.max(0, Math.min(1, p * 2 - 1));   // 0 until the midpoint, then 0 -> 1
  switch (kind) {
    case "fade-black": return { filter: `brightness(${q.toFixed(3)})`, willChange: "filter" };
    case "fade-white": return { filter: `brightness(${(1 + (1 - q) * 5).toFixed(3)})`, willChange: "filter" };
    default:           return undefined;
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
const RANDOM_POOL = [
  "zoom-in", "zoom-out", "pan-right", "pan-left", "pan-up", "pan-down",
  "drift", "drift-left", "diagonal",
];

const CAPTION_STYLES = [
  { id: "classic",   label: "Classic",   hint: "White, black outline" },
  { id: "bold",      label: "Bold",      hint: "Yellow, bold" },
  { id: "boxed",     label: "Boxed",     hint: "White on a dark box" },
  { id: "banner",    label: "Banner",    hint: "White on a solid bar" },
  { id: "highlight", label: "Highlight", hint: "Black on yellow" },
  { id: "cinema",    label: "Cinema",    hint: "Heavy outline, no shadow" },
  { id: "neon",      label: "Neon",      hint: "Cyan with a glow" },
  { id: "shadow",    label: "Shadow",    hint: "No outline, soft shadow" },
  { id: "minimal",   label: "Minimal",   hint: "White, thin outline" },
  { id: "soft",      label: "Soft",      hint: "Held back, for support text" },
] as const;

/** How a caption arrives. The last two work word by word and need the
 *  transcript's timings, which exist once a voiceover has been made. */
const CAPTION_ANIMATIONS = [
  { id: "none",       label: "None",       hint: "Cuts in with the words" },
  { id: "fade",       label: "Fade",       hint: "Fades in and out" },
  { id: "pop",        label: "Pop",        hint: "Arrives with a small scale" },
  { id: "slide",      label: "Slide",      hint: "Comes up into place" },
  { id: "grow",       label: "Grow",       hint: "Creeps outward the whole line" },
  { id: "tilt",       label: "Tilt",       hint: "Straightens as it arrives" },
  { id: "flash",      label: "Flash",      hint: "Lands in yellow, settles" },
  { id: "karaoke",    label: "Karaoke",    hint: "Each word brightens as it is spoken" },
  { id: "reveal",     label: "Reveal",     hint: "The line builds word by word" },
  { id: "typewriter", label: "Typewriter", hint: "Letter by letter, in time with the speech" },
] as const;

/** The three that need the transcript's word timings. */
const WORD_TIMED_CAPTIONS = ["karaoke", "reveal", "typewriter"];

const CAPTION_SIZES     = [{ id: "small", label: "S" }, { id: "medium", label: "M" }, { id: "large", label: "L" }, { id: "xl", label: "XL" }] as const;
const CAPTION_POSITIONS = [{ id: "bottom", label: "Bottom" }, { id: "middle", label: "Middle" }, { id: "top", label: "Top" }] as const;

/** How long an audio file is, from the browser's own decoder. Null when it
 *  cannot be read, which the API accepts: only trim and stretch need it. */
function measureAudioSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (v: number | null) => { URL.revokeObjectURL(url); resolve(v); };
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    audio.onerror = () => done(null);
    audio.src = url;
  });
}

/**
 * The id an optimistic row carries until the server hands back a real one.
 *
 * Prefixed rather than a bare uuid so a row that is still in flight is
 * recognisable: nothing should ever PATCH or DELETE one of these, because the
 * server has never heard of it.
 */
/** The placed-sound panel's width. Named because the drag clamp needs it. */
const PLACED_PANEL_W = 250;

const tempRowId = () => `tmp-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const isTempRow = (id: string | null | undefined) => typeof id === "string" && id.startsWith("tmp-");

/** A sound or element the customer uploaded, as /api/me/assets returns it. */
interface CustomAsset {
  id: string;
  kind: "sound" | "element";
  name: string;
  url: string;
  durationSec: number | null;
}

/** How an uploaded asset is referred to wherever a built-in id would go. */
const customRef = (id: string) => `custom:${id}`;
const isCustomRef = (ref: string) => ref.startsWith("custom:");

const ASSET_ACCEPT: Record<"sound" | "element", string> = {
  sound: "audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,.mp3,.wav,.m4a,.ogg",
  element: "image/png,image/webp,image/gif,.png,.webp,.gif",
};

/**
 * The All / Custom switch above a library.
 *
 * Its own component because both the Sound tab and the Elements tab need it and
 * they are 200 lines apart.
 */
function LibraryTabs({ value, onChange, customCount }: {
  value: "all" | "custom";
  onChange: (v: "all" | "custom") => void;
  customCount: number;
}) {
  return (
    <div className="flex gap-1 p-0.5 rounded-lg mb-2" style={{ background: "var(--bg-input)" }}>
      {([["all", "All"], ["custom", "Custom"]] as const).map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className="flex-1 py-1 rounded-md text-[11px] font-medium transition-all"
          style={value === id
            ? { background: "oklch(0.72 0.25 285 / 0.18)", color: "var(--accent-purple-text)" }
            : { color: "var(--c-50)" }}
        >
          {label}
          {id === "custom" && customCount > 0 && (
            <span className="ml-1 text-[10px]" style={{ color: "var(--c-40)" }}>{customCount}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * The x on an uploaded tile.
 *
 * A sibling of the tile rather than a child of it, because the tile is a button
 * and a button cannot contain one. stopPropagation matters as much: without it
 * a click would remove the asset and audition it on the way out.
 */
function RemoveAssetButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      title={`Remove ${name}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onRemove(); }}
      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center transition-all opacity-60 hover:opacity-100"
      style={{ background: "var(--bg-card)", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
    >
      <X size={9} strokeWidth={3} />
    </button>
  );
}

/**
 * The Custom pane: what this account has uploaded, and the way to add more.
 *
 * The whole pane is the drop target rather than a dashed box inside it. A box
 * that is only a box until you have uploaded something is a control that gets
 * in the way once you have, and the pane already has the shape and the edges to
 * be the target itself.
 *
 * Uploads render as the same tiles the built-in library uses, passed in as
 * children, so an uploaded sound drags onto the timeline and auditions on click
 * exactly like a shipped one, and carries its own x to remove it.
 */
function CustomAssetPane({ kind, assets, canUpload, busy, error, onFiles, onUpgrade, children }: {
  kind: "sound" | "element";
  assets: CustomAsset[];
  canUpload: boolean;
  busy: boolean;
  error: string | null;
  onFiles: (files: FileList | null) => void;
  onUpgrade: () => void;
  children?: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const noun = kind === "sound" ? "sound effects" : "elements";
  const empty = assets.length === 0;

  return (
    <div
      onDragOver={(e) => { if (canUpload) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => {
        setOver(false);
        if (!canUpload) return;
        e.preventDefault();
        onFiles(e.dataTransfer.files);
      }}
      className="rounded-xl transition-all"
      style={{
        // Only while something is being dragged over it. At rest the pane has
        // no border of its own, so it reads as part of the tab.
        outline: over ? "1px dashed oklch(0.72 0.25 285 / 0.6)" : "none",
        outlineOffset: "4px",
        background: over ? "oklch(0.72 0.25 285 / 0.06)" : "transparent",
        // The whole pane is the target, not just the strip its tiles happen to
        // fill. Without a floor the div collapses to the height of two tiles
        // and most of the visible area under the tabs stops accepting a drop,
        // which reads as the feature being broken rather than as the box being
        // small.
        minHeight: 200,
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ASSET_ACCEPT[kind]}
        className="hidden"
        onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }}
      />

      {!canUpload ? (
        <div className="flex flex-col items-center justify-center text-center" style={{ minHeight: 200 }}>
          <p className="text-xs font-medium" style={{ color: "var(--c-70)" }}>Custom {noun} are part of Max</p>
          <p className="text-[11px] mt-1" style={{ color: "var(--c-45)" }}>Upgrade to use your own</p>
          <button
            type="button"
            onClick={onUpgrade}
            className="mt-3 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all hover:opacity-90"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
          >
            Upgrade to Max
          </button>
        </div>
      ) : (
        <>
          {empty ? (
            <button
              type="button"
              onClick={() => !busy && inputRef.current?.click()}
              disabled={busy}
              className="w-full text-center cursor-pointer disabled:cursor-default flex flex-col items-center justify-center"
              style={{ minHeight: 200 }}
            >
              <p className="text-xs font-medium" style={{ color: "var(--c-70)" }}>
                {busy ? "Uploading…" : `Drop your ${noun} here`}
              </p>
              <p className="text-[11px] mt-1" style={{ color: "var(--c-45)" }}>
                {busy ? "Hold on" : "or click to choose from your device"}
              </p>
            </button>
          ) : (
            <>
              {children}
              <div className="flex items-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => !busy && inputRef.current?.click()}
                  disabled={busy}
                  className="text-[11px] underline underline-offset-2 disabled:opacity-40"
                  style={{ color: "var(--c-50)" }}
                >
                  {busy ? "Uploading…" : "Add more"}
                </button>
                <span className="text-[11px]" style={{ color: "var(--c-35)" }}>or drop them anywhere here</span>
              </div>
            </>
          )}
        </>
      )}

      {error && (
        <p className="text-[11px] mt-2 px-2 py-1.5 rounded-lg"
          style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.2 25)" }}>{error}</p>
      )}
    </div>
  );
}

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
      captions_animation?: string | null;
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
    if (typeof cap.captions_animation === "string" && cap.captions_animation) setCaptionsAnimation(cap.captions_animation);
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

  // Tier gate for 1440p (Pro) and 2160p (Max). We look up app_metadata.plan
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
  const [upgradePlan, setUpgradePlan] = useState<string>("heclus_pro");
  const openUpgrade = useCallback((plan: string) => {
    setUpgradePlan(plan);
    setShowUpgradeModal(true);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const client = createSupabaseBrowserClient();
    client.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      const meta = (data.user?.app_metadata ?? {}) as { plan?: unknown };
      // isAdminUser folds in both the app_metadata.is_admin flag AND
      // the legacy hardcoded ADMIN_EMAILS backstop — otherwise the
      // founder admin (recognised by email) would rank as starter and
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
  const userTier = tierForPlan(userPlan);
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
  const [captionsAnimation, setCaptionsAnimation] = useState("none");
  // Closed by default: both are picked once, and their headers name the choice.
  const [captionStyleOpen, setCaptionStyleOpen] = useState(false);
  const [captionAnimOpen, setCaptionAnimOpen] = useState(false);
  const [captionLangOpen, setCaptionLangOpen] = useState(false);
  const [captionPlacementOpen, setCaptionPlacementOpen] = useState(false);
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
  const [effectsTab, setEffectsTab] = useState<"effects" | "transitions" | "filters" | "sound" | "elements" | "text">("effects");

  // The All / Custom switch inside the Sound and Elements tabs, and the
  // account's own uploads. One state for both libraries: they are the same
  // choice, and carrying it across reads as the tab remembering rather than
  // forgetting.
  const [libTab, setLibTab] = useState<"all" | "custom">("all");
  const [customAssets, setCustomAssets] = useState<CustomAsset[]>([]);
  const [canUploadAssets, setCanUploadAssets] = useState(false);
  const [assetBusy, setAssetBusy] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);
  const customSounds = customAssets.filter((a) => a.kind === "sound");
  const customElements = customAssets.filter((a) => a.kind === "element");
  // Built-ins and uploads as one list, so the drag, place and resize handlers
  // below never learn the difference. A built-in is served from /public; an
  // upload from R2.
  const elementLibrary = [
    ...ELEMENTS.map((e) => ({ id: e.id, label: e.label, src: `/elements/${e.id}.png` })),
    ...customElements.map((a) => ({ id: customRef(a.id), label: a.name, src: a.url })),
  ];
  /** Where an element's artwork lives, whichever kind it is. Built-ins ship in
   *  /public; an upload is served from R2. */
  const elementSrc = (id: string) =>
    elementLibrary.find((e) => e.id === id)?.src ?? `/elements/${id}.png`;
  /** How long a sound runs, built-in or uploaded. The module-level
   *  soundSeconds only knows the ones we ship. */
  const secondsFor = (id: string): number =>
    customAssets.find((a) => customRef(a.id) === id)?.durationSec ?? soundSeconds(id);
  const soundLibrary: { id: string; label: string; hint?: string }[] = [
    ...SOUND_EFFECTS.map((x) => ({ id: x.id, label: x.label, hint: x.hint })),
    // No hint on an upload: the customer named it and knows what it is.
    ...customSounds.map((a) => ({ id: customRef(a.id), label: a.name })),
  ];

  const loadCustomAssets = useCallback(async () => {
    try {
      const r = await fetch("/api/me/assets", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      setCustomAssets(Array.isArray(d.assets) ? d.assets : []);
      setCanUploadAssets(!!d.canUpload);
    } catch { /* the library still works without uploads */ }
  }, []);
  useEffect(() => { loadCustomAssets(); }, [loadCustomAssets]);

  /**
   * Upload, then register.
   *
   * The file goes straight to R2 with a presigned PUT, which is what keeps a
   * 5 MB sound off a route handler; /api/me/assets then records it. A sound is
   * measured here rather than server side because the browser already has to
   * decode it to play a preview, and the length is what sizes its block on the
   * timeline.
   */
  const uploadCustomAssets = useCallback(async (kind: "sound" | "element", files: FileList | null) => {
    if (!files?.length) return;
    setAssetError(null);
    setAssetBusy(true);
    try {
      for (const file of Array.from(files)) {
        const presign = await fetch("/api/upload/presign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: "assets",
            folder: kind === "sound" ? "sfx" : "elements",
            filename: file.name,
            contentType: file.type || "application/octet-stream",
          }),
        });
        const pres = await presign.json().catch(() => ({}));
        if (!presign.ok) throw new Error(pres.error ?? "Could not start the upload");

        const put = await fetch(pres.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);

        const durationSec = kind === "sound" ? await measureAudioSeconds(file) : null;
        // The key, not the URL: the server derives the URL itself and refuses
        // anything outside this account's folder.
        const storageKey = new URL(pres.publicUrl).pathname.replace(/^\//, "");
        const reg = await fetch("/api/me/assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            name: file.name.replace(/\.[^.]+$/, "").slice(0, 60),
            storageKey,
            mime: file.type,
            bytes: file.size,
            durationSec,
          }),
        });
        const out = await reg.json().catch(() => ({}));
        if (!reg.ok) throw new Error(out.error ?? "Could not save the upload");
      }
      await loadCustomAssets();
    } catch (e) {
      setAssetError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setAssetBusy(false);
    }
  }, [loadCustomAssets]);

  const deleteCustomAsset = useCallback(async (id: string) => {
    try {
      await fetch(`/api/me/assets?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadCustomAssets();
    } catch { /* the row stays; the next load will show it */ }
  }, [loadCustomAssets]);
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
  /** Every effect currently sounding, so the transport can silence all of them.
   *
   *  A set, not a single element, because two cues can legitimately overlap:
   *  the render mixes them with amix, and a placed sound landing on a beat that
   *  carries its own is the normal case rather than a mistake. What must not
   *  overlap is auditioning, which is a different thing and asks for it
   *  explicitly. */
  const sfxAudioRef = useRef<Set<HTMLAudioElement>>(new Set());
  /** Which sound is being auditioned, so its tile can offer to stop it. Only
   *  ever one, because auditioning is exclusive. */
  const [auditioning, setAuditioning] = useState<string | null>(null);

  /** Silence every effect sounding. Safe to call when none is. */
  const stopSound = useCallback(() => {
    for (const a of sfxAudioRef.current) {
      a.onended = null;
      try { a.pause(); a.currentTime = 0; } catch { /* already finished */ }
    }
    sfxAudioRef.current.clear();
    setAuditioning(null);
  }, []);

  const playIndexRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const playable = beats.filter((b) => !!b.voiceoverUrl);

  // How wide a second is. Stepped rather than continuous: a slider over pixels
  // per second invites fiddling, and six steps cover ten minutes to one beat.
  const timelineTotal = beats.reduce((sum, b) => sum + beatSeconds(b).seconds, 0);
  /** What one beat's block is drawn at: its own length, or the floor that keeps
   *  a half-second beat clickable. */
  const beatTileWidth = useCallback((b: Beat) =>
    Math.max(pxPerSecond < 12 ? 4 : narrow ? 12 : 20, beatSeconds(b).seconds * pxPerSecond),
  [pxPerSecond, narrow]);
  /** The strip is as wide as the picture row actually comes out, gaps included,
   *  rather than as wide as the time axis says it should be. */
  const stripWidth = Math.max(
    320,
    beats.reduce((sum, b) => sum + beatTileWidth(b), 0) + Math.max(0, beats.length - 1),
  );
  // True while any beat is still guessing, so the panel can say so rather than
  // presenting an estimate as a measurement.
  const timelineEstimated = beats.some((b) => beatSeconds(b).estimated);

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
    // An effect fired by the last cue outlives the transport otherwise, and
    // keeps sounding after the playhead has stopped.
    stopSound();
    setPlaying(false);
    setPlayingBeat(null);
  }, [stopSound]);

  // Stop when the page goes away, or the audio keeps playing over a step the
  // user has already left.
  useEffect(() => stopPlayback, [stopPlayback]);

  /** Hear a sound the way the render will mix it: its own level against the
   *  project's, and its own pitch. preservesPitch off is what makes playback
   *  rate a pitch shift rather than a speed change.
   *
   *  Auditioning is exclusive: clicking down a library stacked every sound on
   *  top of the last, which is a chord rather than an audition, and dragging a
   *  volume slider fired one per step.
   *
   *  Playback is not. Cues overlap in the render, and a placed sound sitting on
   *  a beat that carries its own is ordinary rather than a mistake. Making the
   *  transport exclusive silenced whichever of the two fired first, which is
   *  why a custom sound placed at 0s appeared not to play at all: beat one's
   *  swish landed on the same frame and cut it off. */
  const playSound = useCallback((id: string, volume = 1, pitch = 1, exclusive = true) => {
    if (exclusive) stopSound();
    if (exclusive) setAuditioning(id);
    // A built-in ships in /public; an upload is served from R2. Resolved here
    // rather than by the callers, all of which pass an id and nothing else.
    const custom = isCustomRef(id) ? customAssets.find((x) => customRef(x.id) === id) : null;
    const a = new Audio(custom ? custom.url : `/sfx/${id}.mp3`);
    // Exactly what the render mixes: the sound's own level against the
    // project's. Anything else here is a preview that lies.
    a.volume = Math.max(0, Math.min(1, volume * sfxVolume));
    type PitchyAudio = HTMLAudioElement & { preservesPitch?: boolean; mozPreservesPitch?: boolean };
    const p = a as PitchyAudio;
    p.preservesPitch = false;
    p.mozPreservesPitch = false;
    a.playbackRate = Math.max(0.5, Math.min(2, pitch));
    // Cleared on its own end so the ref never holds a finished element, and a
    // later stop cannot rewind something that already stopped.
    a.onended = () => {
      sfxAudioRef.current.delete(a);
      // Back to a play glyph when it finishes on its own, so the tile never
      // sits offering to stop something that already stopped.
      if (exclusive) setAuditioning((cur) => (cur === id ? null : cur));
    };
    sfxAudioRef.current.add(a);
    void a.play().catch(() => { /* autoplay rules */ });
  }, [sfxVolume, customAssets, stopSound]);

  const playFrom = useCallback((index: number, startAt = 0) => {
    const beat = playable[index];
    if (!beat?.voiceoverUrl) { stopPlayback(); setPlayhead(0); setPlayingBeat(null); return; }
    playIndexRef.current = index;
    setPlayingBeat(beat.beatNumber);

    // Whatever was sounding stops first. This is the only place a voiceover
    // element is created, so this is the only place it can be leaked.
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* already gone */ }
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current = null;
    }
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }

    // Where this block starts, measured the same way its width is, so the
    // playhead and the strip agree.
    const offset = playable.slice(0, index).reduce((sum, b) => sum + beatSeconds(b).seconds, 0);
    const span = beatSeconds(beat).seconds;

    // The beat's own sound, at its start, at the level the render will use. The
    // same file the worker mixes, so what is heard here is what is heard there.
    if (beat.soundEffect && startAt <= 0.01 && sfxVolume > 0) {
      playSound(beat.soundEffect, beat.soundVolume ?? 1, beat.soundPitch ?? 1, false);
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

    // audio.currentTime only advances once per audio buffer, which is several
    // frames apart, so a playhead read straight off it repeats a value and then
    // jumps — and a seam driven by it renders in steps rather than a blend.
    // Carry it on the frame clock between updates and resync when it moves.
    let clockTime = -1;
    let clockAt = 0;
    const tick = () => {
      const d = audio.duration;
      let share = 0;
      if (d && Number.isFinite(d)) {
        const ct = audio.currentTime;
        const now = performance.now();
        if (ct !== clockTime) { clockTime = ct; clockAt = now; }
        // Capped so a stalled audio clock cannot run the seam ahead of itself.
        const drift = audio.paused ? 0 : Math.min((now - clockAt) / 1000, 0.25);
        share = Math.min(1, Math.max(0, (ct + drift) / d));
      }
      setPlayhead(offset + share * span);
      rafRef.current = requestAnimationFrame(tick);
    };
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [playable, stopPlayback, narrationPreviewVolume, sfxVolume, playSound]);

  // Click anywhere on the timeline and the playhead goes there. This is most
  // of what makes it a timeline rather than a strip of pictures: a tester
  // looked at it and did not recognise one, having found nothing that behaves
  // the way an editor's does.
  const locate = useCallback((seconds: number) => {
    const t = Math.max(0, Math.min(timelineTotal, seconds));
    let acc = 0;
    for (let i = 0; i < playable.length; i++) {
      const span = beatSeconds(playable[i]).seconds;
      if (t < acc + span || i === playable.length - 1) {
        return { t, index: i, within: span > 0 ? Math.max(0, Math.min(1, (t - acc) / span)) : 0 };
      }
      acc += span;
    }
    return { t, index: 0, within: 0 };
  }, [playable, timelineTotal]);

  const seekTo = useCallback((seconds: number, commit = true) => {
    const { t, index, within } = locate(seconds);
    setPlayhead(t);
    setShowFinished(false);
    const landedOn = playable[index];
    if (playing && commit) {
      playFrom(index, within);
    } else if (playing && !commit) {
      // Mid-drag: hold the sound while the playhead moves, and let the release
      // decide where playback resumes.
      if (audioRef.current) { try { audioRef.current.pause(); } catch { /* ignore */ } }
    } else if (landedOn) {
      // Not playing: point the preview at the beat under the playhead, which
      // is what a scrub is for when the audio is stopped.
      setTimelineBeat(landedOn.beatNumber);
    }
  }, [playable, playing, playFrom, locate]);

  const togglePlay = useCallback(() => {
    if (playing) { stopPlayback(); return; }
    if (playable.length === 0) { toast.info("No voiceover to play yet."); return; }
    // Play means play the edit. With a render on screen the frame was showing
    // the finished file while the narration ran underneath it, which is two
    // videos at once and neither of them what was asked for.
    setShowFinished(false);
    setPlaying(true);
    // Resume from the marker. Restarting at zero after a pause is the one
    // thing a transport must not do.
    const from = playhead >= timelineTotal - 0.05 ? 0 : playhead;
    const { index, within } = locate(from);
    setPlayhead(from);

    // Muted means volume zero, which is exactly what the worker is told, so
    // there is nothing to start.
    if (bgmPreviewUrl && bgmVolume > 0) {
      const bed = new Audio(bgmPreviewUrl);
      bed.loop = true;              // shorter than the video is the normal case
      bed.volume = Math.max(0, Math.min(1, bgmVolume));
      timelineBgmRef.current = bed;
      void bed.play().catch(() => { /* the narration still plays without it */ });
    }

    playFrom(index, within);
  }, [playing, playable.length, playFrom, stopPlayback, bgmPreviewUrl, bgmVolume, playhead, timelineTotal, locate]);

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

  const [shuffling, setShuffling] = useState(false);
  const [pickedSound, setPickedSound] = useState<string | null>(null);
  const [pickedElement, setPickedElement] = useState<string | null>(null);
  const [selectedElement, setSelectedElement] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [selectedSound, setSelectedSound] = useState<string | null>(null);

  /** Where the placed-sound panel sits, in viewport coordinates.
   *
   *  Viewport rather than an offset inside the timeline, because the timeline
   *  scrolls sideways and is only a couple of hundred pixels tall: a panel
   *  confined to it can be scrolled away from the block it belongs to, and
   *  cannot be moved somewhere that is simply out of the way.
   *
   *  Null means it has never been dragged, and it anchors under its block. Once
   *  moved it stays put, including across selections, so somebody who parked it
   *  clear of a crowded lane does not have to move it again for the next
   *  sound. */
  const [soundPanelPos, setSoundPanelPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!selectedSound || soundPanelPos) return;
    const el = document.querySelector(`[data-overlay="${selectedSound}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSoundPanelPos({ x: r.left, y: r.bottom + 6 });
  }, [selectedSound, soundPanelPos]);
  /** A sound following the pointer, so a drop lands where it looked. */
  const [draggingSound, setDraggingSound] = useState<{ id: string; x: number; y: number } | null>(null);
  /** Which of the text panel's option sets is open. One at a time: three grids
   *  unfolded at once is the tall panel these sections exist to avoid. */
  const [textSection, setTextSection] = useState<"style" | "colour" | "bg" | null>(null);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const [editConfirmOpen, setEditConfirmOpen] = useState(false);
  /** Set when Edit is confirmed: the render on screen is no longer what the
   *  page describes, so it leaves the preview and the only thing left of it is
   *  a download. Cleared when a new render arrives. */
  const [renderStale, setRenderStale] = useState(false);
  /** The render the mode was last set against. A genuinely new render should
   *  put the page back into Final mode; the same one arriving again, from SWR
   *  or from a reload, should not quietly undo an Edit. */
  const [seenRender, setSeenRender] = useState<string | null>(null);
  /** Watch the finished video in the preview, or go back to editing it. */
  const [showFinished, setShowFinished] = useState(true);

  // Elements are their own objects on their own timeline, so they are fetched
  // and written apart from the beats.
  const { data: elementData, mutate: mutateElements } = useSWR<{ elements: ProjectElement[] }>(
    `/api/projects/${projectId}/elements`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false },
  );
  const projectElements: ProjectElement[] = elementData?.elements ?? [];

  const addElement = useCallback(async (el: {
    element: string; start_sec: number; end_sec: number; x: number; y: number; size: number; lane?: number;
  }) => {
    const tempId = tempRowId();
    const optimistic: ProjectElement = { id: tempId, ...el, lane: el.lane ?? 0 };
    void mutateElements((cur) => ({ elements: [...(cur?.elements ?? []), optimistic] }), { revalidate: false });
    setSelectedElement(tempId);
    try {
      const res = await fetch(`/api/projects/${projectId}/elements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(el),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? "Could not add it");
      const realId = out.element?.id as string | undefined;
      if (abortedRows.current.delete(tempId)) {
        if (realId) void fetch(`/api/projects/${projectId}/elements?id=${realId}`, { method: "DELETE" }).catch(() => {});
        return;
      }
      void mutateElements((cur) => ({
        elements: (cur?.elements ?? []).map((x) => x.id === tempId ? (out.element as ProjectElement) : x),
      }), { revalidate: false });
      setSelectedElement((cur) => cur === tempId ? (realId ?? null) : cur);
    } catch (err) {
      void mutateElements((cur) => ({ elements: (cur?.elements ?? []).filter((x) => x.id !== tempId) }), { revalidate: false });
      setSelectedElement((cur) => cur === tempId ? null : cur);
      toast.error(err instanceof Error ? err.message : "Could not add it");
    }
  }, [projectId, mutateElements]);

  // Optimistic: dragging one is a continuous gesture and a round trip per
  // frame would make it crawl. The write is debounced behind it.
  const elementPatch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateElement = useCallback((id: string, patch: Partial<ProjectElement>, commit = true) => {
    if (isTempRow(id)) commit = false;
    void mutateElements((cur) => cur && ({
      elements: cur.elements.map((el) => el.id === id ? { ...el, ...patch } : el),
    }), { revalidate: false });
    if (!commit) return;
    if (elementPatch.current) clearTimeout(elementPatch.current);
    elementPatch.current = setTimeout(() => {
      void fetch(`/api/projects/${projectId}/elements`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      }).catch(() => { /* the next drag re-sends it */ });
    }, 250);
  }, [projectId, mutateElements]);

  const { data: textData, mutate: mutateTexts } = useSWR<{ texts: ProjectText[] }>(
    `/api/projects/${projectId}/texts`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false },
  );
  const projectTexts: ProjectText[] = textData?.texts ?? [];

  const addText = useCallback(async (t: {
    content: string; start_sec: number; end_sec: number; x: number; y: number;
    size: number; colour?: string; style?: string; lane?: number;
  }) => {
    const tempId = tempRowId();
    const optimistic: ProjectText = {
      id: tempId, content: t.content, start_sec: t.start_sec, end_sec: t.end_sec,
      x: t.x, y: t.y, size: t.size,
      colour: t.colour ?? "#ffffff",
      style: (t.style ?? "plain") as ProjectText["style"],
      bg_colour: null, bg_opacity: 1, lane: t.lane ?? 0,
    };
    void mutateTexts((cur) => ({ texts: [...(cur?.texts ?? []), optimistic] }), { revalidate: false });
    setSelectedText(tempId);
    try {
      const res = await fetch(`/api/projects/${projectId}/texts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(t),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? "Could not add it");
      const realId = out.text?.id as string | undefined;
      if (abortedRows.current.delete(tempId)) {
        if (realId) void fetch(`/api/projects/${projectId}/texts?id=${realId}`, { method: "DELETE" }).catch(() => {});
        return;
      }
      void mutateTexts((cur) => ({
        texts: (cur?.texts ?? []).map((x) => x.id === tempId ? (out.text as ProjectText) : x),
      }), { revalidate: false });
      setSelectedText((cur) => cur === tempId ? (realId ?? null) : cur);
    } catch (err) {
      void mutateTexts((cur) => ({ texts: (cur?.texts ?? []).filter((x) => x.id !== tempId) }), { revalidate: false });
      setSelectedText((cur) => cur === tempId ? null : cur);
      toast.error(err instanceof Error ? err.message : "Could not add it");
    }
  }, [projectId, mutateTexts]);

  // Optimistic and debounced, like the elements: typing and dragging are both
  // continuous, and a round trip per keystroke would make either crawl.
  const textPatch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateText = useCallback((id: string, patch: Partial<ProjectText>, commit = true) => {
    if (isTempRow(id)) commit = false;
    void mutateTexts((cur) => cur && ({
      texts: cur.texts.map((t) => t.id === id ? { ...t, ...patch } : t),
    }), { revalidate: false });
    if (!commit) return;
    if (textPatch.current) clearTimeout(textPatch.current);
    textPatch.current = setTimeout(() => {
      void fetch(`/api/projects/${projectId}/texts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      }).catch(() => { /* the next edit re-sends it */ });
    }, 350);
  }, [projectId, mutateTexts]);

  const removeText = useCallback(async (id: string) => {
    void mutateTexts((cur) => cur && ({ texts: cur.texts.filter((t) => t.id !== id) }), { revalidate: false });
    setSelectedText((cur) => (cur === id ? null : cur));
    // Still in flight: the server has no id to delete yet, and refetching would
    // bring the row back the moment the insert lands. Flag it for the add path.
    if (isTempRow(id)) { abortedRows.current.add(id); return; }
    await fetch(`/api/projects/${projectId}/texts?id=${id}`, { method: "DELETE" }).catch(() => {});
    await mutateTexts();
  }, [projectId, mutateTexts]);

  // Placed sounds: same shape as the elements and texts beside them.
  const { data: soundData, mutate: mutateSounds } = useSWR<{ sounds: ProjectSound[] }>(
    `/api/projects/${projectId}/sounds`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false },
  );
  const projectSounds: ProjectSound[] = soundData?.sounds ?? [];

  const addSound = useCallback(async (snd: {
    sound: string; at_sec: number; volume?: number; pitch?: number; lane?: number;
  }) => {
    // Drawn before the write, not after it. A drop is the end of a gesture, and
    // waiting on a POST and then a refetch put a visible gap between letting go
    // and the block appearing, which reads as a missed drop and invites a
    // second one. The row is swapped for the server's when it lands.
    const tempId = tempRowId();
    const optimistic: ProjectSound = {
      id: tempId, sound: snd.sound, at_sec: snd.at_sec,
      volume: snd.volume ?? 1, pitch: snd.pitch ?? 1,
      duration_sec: null, lane: snd.lane ?? 0,
    };
    void mutateSounds((cur) => ({ sounds: [...(cur?.sounds ?? []), optimistic] }), { revalidate: false });
    setSelectedSound(tempId);
    try {
      const res = await fetch(`/api/projects/${projectId}/sounds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snd),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? "Could not add it");
      const realId = out.sound?.id as string | undefined;
      // Deleted while the insert was in flight: undo it on the server rather
      // than leaving a row the customer already removed.
      if (abortedRows.current.delete(tempId)) {
        if (realId) void fetch(`/api/projects/${projectId}/sounds?id=${realId}`, { method: "DELETE" }).catch(() => {});
        return;
      }
      void mutateSounds((cur) => ({
        sounds: (cur?.sounds ?? []).map((x) => x.id === tempId ? (out.sound as ProjectSound) : x),
      }), { revalidate: false });
      // Only if they have not clicked something else in the meantime.
      setSelectedSound((cur) => cur === tempId ? (realId ?? null) : cur);
    } catch (err) {
      // Take it back off, or a block sits there that no longer exists anywhere.
      void mutateSounds((cur) => ({ sounds: (cur?.sounds ?? []).filter((x) => x.id !== tempId) }), { revalidate: false });
      setSelectedSound((cur) => cur === tempId ? null : cur);
      toast.error(err instanceof Error ? err.message : "Could not add it");
    }
  }, [projectId, mutateSounds]);

  // Temp rows deleted before their insert came back. The add path checks this
  // and removes the real row the server just created, which is the only way a
  // drop-then-immediately-delete does not leave one behind.
  const abortedRows = useRef<Set<string>>(new Set());

  const soundPatch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateSound = useCallback((id: string, patch: Partial<ProjectSound>, commit = true) => {
    // A row still in flight has no server id to PATCH. Draw the change and let
    // the insert carry it: dragging a block the instant it lands is exactly
    // when this happens.
    if (isTempRow(id)) commit = false;
    void mutateSounds((cur) => cur && ({
      sounds: cur.sounds.map((x) => x.id === id ? { ...x, ...patch } : x),
    }), { revalidate: false });
    if (!commit) return;
    if (soundPatch.current) clearTimeout(soundPatch.current);
    soundPatch.current = setTimeout(() => {
      void fetch(`/api/projects/${projectId}/sounds`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      }).catch(() => { /* the next drag re-sends it */ });
    }, 250);
  }, [projectId, mutateSounds]);

  const removeSound = useCallback(async (id: string) => {
    void mutateSounds((cur) => cur && ({ sounds: cur.sounds.filter((x) => x.id !== id) }), { revalidate: false });
    setSelectedSound((cur) => (cur === id ? null : cur));
    // Still in flight: the server has no id to delete yet, and refetching would
    // bring the row back the moment the insert lands. Flag it for the add path.
    if (isTempRow(id)) { abortedRows.current.add(id); return; }
    await fetch(`/api/projects/${projectId}/sounds?id=${id}`, { method: "DELETE" }).catch(() => {});
    await mutateSounds();
  }, [projectId, mutateSounds]);

  // Placed sounds during playback.
  //
  // A beat's sound fires when its beat starts, which is the only moment the
  // playback loop knows about. A placed one sits at an arbitrary second, so it
  // has to be watched for: as the playhead passes it, it plays once.
  //
  // Once, hence the set. The playhead updates every frame, so without it a
  // sound at 4.0s would retrigger about sixty times a second while the head sat
  // on it. The set clears on stop and on any jump backwards, which is what a
  // seek looks like from here, so scrubbing back over a sound plays it again.
  const firedSounds = useRef<Set<string>>(new Set());
  const lastPlayhead = useRef(0);
  useEffect(() => {
    if (!playing) { firedSounds.current.clear(); lastPlayhead.current = playhead; return; }
    if (playhead < lastPlayhead.current - 0.05) firedSounds.current.clear();
    lastPlayhead.current = playhead;
    if (sfxVolume <= 0) return;
    for (const snd of projectSounds) {
      if (firedSounds.current.has(snd.id)) continue;
      // A window, not an equality: at sixty frames a second the playhead lands
      // near a cue rather than on it, and a slow frame can step right over one.
      if (playhead >= snd.at_sec && playhead < snd.at_sec + 0.4) {
        firedSounds.current.add(snd.id);
        playSound(snd.sound, snd.volume, snd.pitch, false);
      }
    }
  }, [playhead, playing, projectSounds, sfxVolume, playSound]);

  // Track height. Enough for a block with a label in it and no more: five
  // sections stacked is what makes the timeline tall, so this number is
  // multiplied by everything.
  const LANE_H = 26;

  /**
   * Close gaps in a section's tracks.
   *
   * Dragging the last block off track 2 leaves an empty track 2 with track 3
   * still above it, and nothing ever cleans that up: the lane is a number on a
   * row, not a thing that exists. So the used lanes are renumbered to run from
   * zero with no holes, and the rows follow.
   *
   * Written back rather than only displayed. The worker draws from the stored
   * lane, so a timeline that quietly renumbered for the eye would stack the
   * render differently from the preview.
   */
  function compactLanes<T extends { id: string; lane: number }>(
    items: T[],
    patch: (id: string, p: { lane: number }) => void,
  ) {
    const used = [...new Set(items.map((x) => x.lane ?? 0))].sort((a, b) => a - b);
    // Already contiguous from zero: nothing to do, and saying so here is what
    // stops this from writing on every render.
    if (used.every((lane, i) => lane === i)) return;
    const moved = new Map(used.map((lane, i) => [lane, i]));
    for (const item of items) {
      const to = moved.get(item.lane ?? 0);
      if (to !== undefined && to !== item.lane) patch(item.id, { lane: to });
    }
  }
  const elementLaneCount = Math.min(10, Math.max(1, ...projectElements.map((el) => (el.lane ?? 0) + 1)) + (projectElements.length ? 1 : 0));
  const textLaneCount = Math.min(10, Math.max(1, ...projectTexts.map((t) => (t.lane ?? 0) + 1)) + (projectTexts.length ? 1 : 0));
  const soundLaneCount = Math.min(10, Math.max(1, ...projectSounds.map((x) => (x.lane ?? 0) + 1)) + (projectSounds.length ? 1 : 0));

  // After anything moves between tracks, close the gaps it left behind. Each
  // section on its own, since their tracks are unrelated.
  useEffect(() => {
    compactLanes(projectTexts, (id, p) => updateText(id, p));
  }, [projectTexts, updateText]);
  useEffect(() => {
    compactLanes(projectElements, (id, p) => updateElement(id, p));
  }, [projectElements, updateElement]);
  useEffect(() => {
    compactLanes(projectSounds, (id, p) => updateSound(id, p));
  }, [projectSounds, updateSound]);

  const removeElement = useCallback(async (id: string) => {
    void mutateElements((cur) => cur && ({ elements: cur.elements.filter((el) => el.id !== id) }), { revalidate: false });
    setSelectedElement((cur) => (cur === id ? null : cur));
    // Still in flight: the server has no id to delete yet, and refetching would
    // bring the row back the moment the insert lands. Flag it for the add path.
    if (isTempRow(id)) { abortedRows.current.add(id); return; }
    await fetch(`/api/projects/${projectId}/elements?id=${id}`, { method: "DELETE" }).catch(() => {});
    await mutateElements();
  }, [projectId, mutateElements]);
  /** What is under the pointer mid-drag, so it can be drawn following it. */
  const [draggingElement, setDraggingElement] = useState<{ id: string; x: number; y: number } | null>(null);
  /** A template following the pointer, so a drop lands where it looked. */
  const [draggingText, setDraggingText] = useState<{ id: string; x: number; y: number } | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  /** The strip itself, in timeline pixels, for dropping an element at a time. */
  const timelineStripRef = useRef<HTMLDivElement | null>(null);
  const elementRowsRef = useRef<HTMLDivElement | null>(null);
  const textRowsRef = useRef<HTMLDivElement | null>(null);
  const soundRowsRef = useRef<HTMLDivElement | null>(null);
  // Tuning per sound, for sounds not yet committed to a beat. A whoosh pitched
  // down and a chime left alone are two different settings, and coming back to
  // either should find it as it was left.
  const [soundShapes, setSoundShapes] = useState<Record<string, { volume: number; pitch: number }>>({});
  const [filterStrengths, setFilterStrengths] = useState<Record<string, number>>({});
  const [transitionLengths, setTransitionLengths] = useState<Record<string, number>>({});
  const [motionShapes, setMotionShapes] = useState<Record<string, { strength: string; seconds: number }>>({});

  // The effect, transition and filter live on the project, so they come back
  // on their own. The sound in hand, its untried tuning and which tab was open
  // are editing state with nowhere on the row to live — and losing them on
  // every reload made the tab feel like it forgot what you were doing.
  // Per project, in this browser, which is the scope of the decision.
  const localKey = `heclus:assemble:${projectId}`;
  const localLoaded = useRef(false);
  useEffect(() => {
    if (localLoaded.current) return;
    localLoaded.current = true;
    try {
      const raw = window.localStorage.getItem(localKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        tab?: string;
        pickedSound?: string | null;
        soundShapes?: Record<string, { volume: number; pitch: number }>;
        filterStrengths?: Record<string, number>;
        transitionLengths?: Record<string, number>;
        motionShapes?: Record<string, { strength: string; seconds: number }>;
        showFinished?: boolean;
        renderStale?: boolean;
        seenRender?: string | null;
      };
      if (saved.tab && ["effects", "transitions", "filters", "sound", "elements", "text"].includes(saved.tab)) {
        setEffectsTab(saved.tab as typeof effectsTab);
      }
      if (typeof saved.pickedSound === "string" || saved.pickedSound === null) {
        setPickedSound(saved.pickedSound);
      }
      if (saved.soundShapes && typeof saved.soundShapes === "object") setSoundShapes(saved.soundShapes);
      if (saved.filterStrengths && typeof saved.filterStrengths === "object") setFilterStrengths(saved.filterStrengths);
      if (saved.transitionLengths && typeof saved.transitionLengths === "object") setTransitionLengths(saved.transitionLengths);
      if (saved.motionShapes && typeof saved.motionShapes === "object") setMotionShapes(saved.motionShapes);
      // Which mode the page was in is editing state too. Coming back to a
      // project mid-edit and being handed the finished video instead was the
      // page forgetting what you were doing.
      if (typeof saved.showFinished === "boolean") setShowFinished(saved.showFinished);
      if (typeof saved.renderStale === "boolean") setRenderStale(saved.renderStale);
      if (typeof saved.seenRender === "string" || saved.seenRender === null) setSeenRender(saved.seenRender ?? null);
    } catch { /* private mode, cleared storage, corrupt value: start fresh */ }
  }, [localKey]);

  useEffect(() => {
    if (!localLoaded.current) return;
    try {
      window.localStorage.setItem(localKey, JSON.stringify({
        tab: effectsTab, pickedSound, soundShapes, filterStrengths, transitionLengths, motionShapes,
        showFinished, renderStale, seenRender,
      }));
    } catch { /* storage full or blocked: the page still works */ }
  }, [localKey, effectsTab, pickedSound, soundShapes, filterStrengths, transitionLengths, motionShapes,
      showFinished, renderStale, seenRender]);
  const shapeOf = (id: string | null) => (id ? soundShapes[id] : undefined) ?? { volume: 1, pitch: 1 };
  const tuneSound = (id: string, patch: { volume?: number; pitch?: number }) =>
    setSoundShapes((cur) => ({ ...cur, [id]: { ...shapeOf(id), ...patch } }));
  const [applyingSound, setApplyingSound] = useState(false);

  /** Both buttons write real values rather than a mode, so the render and the
   *  preview agree and a re-render produces the same video. */
  const applyTransitionToAll = useCallback(async (kind: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/beats/transition`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applyAll: kind }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not apply it");
      await mutate();
      toast.success(kind === "none" ? "Every cut is hard now" : "Applied to every cut");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not apply it");
    }
  }, [projectId, mutate]);

  const randomizeTransitions = useCallback(async () => {
    setShuffling(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/beats/transition`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ randomize: true }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? "Could not shuffle them");
      await mutate();
      toast.success(`${out.randomized ?? 0} cuts shuffled`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not shuffle them");
    } finally {
      setShuffling(false);
    }
  }, [projectId, mutate]);

  const setBeatTransition = useCallback(async (beatNumber: number, kind: string | null) => {
    await mutate((cur: unknown) => {
      const c = cur as { beats?: Beat[] } | undefined;
      if (!c?.beats) return cur;
      return { ...c, beats: c.beats.map((b) => b.beatNumber === beatNumber ? { ...b, transition: kind } : b) };
    }, { revalidate: false });
    try {
      const res = await fetch(`/api/projects/${projectId}/beats/transition`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beatNumber, transition: kind }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not set the transition");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not set the transition");
      await mutate();
    }
  }, [projectId, mutate]);

  /** Put the sound in hand on every beat, or take them all off. Without this
   *  the only way to use the tab was to select each beat in turn on a timeline
   *  that might be two hundred beats long. */
  const applySoundToAll = useCallback(async (sound: string | null, shape?: { volume: number; pitch: number }) => {
    setApplyingSound(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/beats/sound`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applyAll: sound, ...(sound ? shape : {}) }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? "Could not apply it");
      await mutate();
      toast.success(sound ? `On ${out.count ?? 0} transitions` : "Sounds cleared");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not apply it");
    } finally {
      setApplyingSound(false);
    }
  }, [projectId, mutate]);

  const tuneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tuneEverywhere = useCallback((sound: string, patch: { volume?: number; pitch?: number }) => {
    // Optimistic, so the sliders and the timeline agree immediately.
    void mutate((cur: unknown) => {
      const c = cur as { beats?: Beat[] } | undefined;
      if (!c?.beats) return cur;
      return { ...c, beats: c.beats.map((b) => b.soundEffect === sound ? {
        ...b,
        soundVolume: patch.volume ?? b.soundVolume ?? null,
        soundPitch: patch.pitch ?? b.soundPitch ?? null,
      } : b) };
    }, { revalidate: false });
    // Debounced: a slider fires on every pixel and this touches every beat
    // carrying the sound.
    if (tuneTimer.current) clearTimeout(tuneTimer.current);
    tuneTimer.current = setTimeout(() => {
      void fetch(`/api/projects/${projectId}/beats/sound`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tuneAll: sound, ...patch }),
      }).catch(() => { /* the next drag re-sends it */ });
    }, 400);
  }, [projectId, mutate]);

  const setBeatSound = useCallback(async (
    beatNumber: number,
    sound: string | null,
    shape?: { volume?: number; pitch?: number },
  ) => {
    await mutate((cur: unknown) => {
      const c = cur as { beats?: Beat[] } | undefined;
      if (!c?.beats) return cur;
      return { ...c, beats: c.beats.map((b) => b.beatNumber === beatNumber ? {
        ...b,
        soundEffect: sound,
        soundVolume: sound === null ? null : (shape?.volume ?? b.soundVolume ?? null),
        soundPitch: sound === null ? null : (shape?.pitch ?? b.soundPitch ?? null),
      } : b) };
    }, { revalidate: false });
    try {
      const res = await fetch(`/api/projects/${projectId}/beats/sound`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beatNumber, sound, ...shape }),
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
    ?? beats.find((b) => !b.videoUrl && b.imageUrl)
    ?? beats.find((b) => b.imageUrl || b.videoUrl)
    ?? null;
  // A beat that generated a clip previews as that clip: it is what gets
  // assembled, and a still of its first frame says nothing about the motion
  // that was paid for.
  const previewClipUrl = previewBeat?.videoUrl ?? null;
  const stillPreviewUrl = previewBeat?.imageUrl ?? null;
  const previewSrc = previewClipUrl ?? stillPreviewUrl;
  /** The frame every picker tile animates. A clip works as well as a still
   *  here: a video element takes the same transforms an image does. */
  const tileUrl = stillPreviewUrl ?? previewClipUrl;
  const tileIsClip = !stillPreviewUrl && !!previewClipUrl;
  // The shot after the previewed one. A transition is about two frames, and two
  // copies of the same one shows nothing.
  const nextPreviewUrl = (() => {
    const has = (b: Beat) => b.imageUrl ?? b.videoUrl ?? null;
    const at = previewBeat ? beats.findIndex((b) => b.beatNumber === previewBeat.beatNumber) : -1;
    const after = at >= 0 ? beats.slice(at + 1).find(has) : beats.filter(has)[1];
    return (after ? has(after) : null) ?? tileUrl;
  })();
  const nextIsClip = !!nextPreviewUrl && nextPreviewUrl === beats.find((b) => b.videoUrl === nextPreviewUrl)?.videoUrl;

  // The effect that beat will actually get: its own if it has one, otherwise
  // the project's. Watching the project setting animate on a beat that
  // overrides it would be a lie about what will be rendered.
  const previewMotion = previewBeat?.imageMotion ?? imageMotion;

  // Playback runs the transition where it will actually happen: in the last t
  // seconds of a beat, at the length the render uses. Without this the preview
  // cut hard between beats and the setting looked like it did nothing.
  const playbackSeam = (() => {
    if (!playing || playingBeat === null) return null;
    const idx = playable.findIndex((b) => b.beatNumber === playingBeat);
    if (idx < 0 || idx >= playable.length - 1) return null;
    const start = playable.slice(0, idx).reduce((sum, b) => sum + beatSeconds(b).seconds, 0);
    const span = beatSeconds(playable[idx]).seconds;
    // The same clamp the worker applies, so what plays is what renders.
    const shortest = Math.min(...playable.map((b) => beatSeconds(b).seconds));
    const t = Math.min(transitionSeconds, 2, shortest / 3);
    const remaining = start + span - playhead;
    if (t <= 0 || remaining > t || remaining < 0) return null;
    const next = playable[idx + 1];
    // The cut's own transition, not the project's. Every seam looked identical
    // during playback while this read the project setting, which made a
    // randomised video look like it had not been randomised at all.
    const kind = (playable[idx].transition ?? transition) as string;
    if (kind === "none") return null;
    return { p: Math.min(1, Math.max(0, (t - remaining) / t)), url: next.imageUrl ?? null, kind };
  })();

  // The caption the preview should be showing right now.
  //
  // A beat's narration is longer than one caption, so holding the first eight
  // words for its whole length looked stuck. There are no word timings on this
  // side, so the line advances by the beat's own progress: an approximation,
  // and a much closer one than not moving at all.
  /** The beats a transition sound lands on: the one arriving through each cut
   *  that has a transition. Mirrors the rule the route applies. */
  const transitionArrivals = beats
    .map((b, i) => ({ seam: (b.transition ?? transition), next: beats[i + 1] }))
    .filter((x) => x.next && x.seam && x.seam !== "none")
    .map((x) => x.next!);

  /** How many beats use each sound, for the counts on the buttons. */
  const usedCounts = beats.reduce<Record<string, number>>((acc, b) => {
    if (b.soundEffect) acc[b.soundEffect] = (acc[b.soundEffect] ?? 0) + 1;
    return acc;
  }, {});

  useEffect(() => {
    if (!selectedElement) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Not while typing: a caption field would lose its last character.
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void removeElement(selectedElement);
      }
      if (e.key === "Escape") setSelectedElement(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedElement, removeElement]);

  const previewCaption = (() => {
    if (!captionsEnabled) return "";
    const source = playingBeat !== null
      ? playable.find((b) => b.beatNumber === playingBeat)
      : previewBeat;
    const script = (source?.scriptSegment ?? "").trim();
    if (!script) return "";
    const words = script.split(/\s+/);
    if (playingBeat === null || words.length <= CAPTION_WORDS_PER_LINE) {
      return words.slice(0, CAPTION_WORDS_PER_LINE).join(" ");
    }
    const idx = playable.findIndex((b) => b.beatNumber === playingBeat);
    const start = playable.slice(0, idx).reduce((sum, b) => sum + beatSeconds(b).seconds, 0);
    const span = beatSeconds(playable[idx]).seconds || 1;
    const p = Math.max(0, Math.min(0.999, (playhead - start) / span));
    // By word position, not by equal slices of the beat. A line of seven words
    // out of twenty owns seven twentieths of the beat, and the last line is
    // usually short — dividing the beat into equal chunks left every line
    // drifting further from the words than the one before it. This is exactly
    // what the worker does when it has no transcript to work from.
    const spoken = Math.floor(p * words.length);
    const line = Math.floor(spoken / CAPTION_WORDS_PER_LINE);
    return words.slice(line * CAPTION_WORDS_PER_LINE, (line + 1) * CAPTION_WORDS_PER_LINE).join(" ");
  })();

  // Select a beat on the timeline and the grid edits that beat; select nothing
  // and it edits the project. One grid either way — a second copy of it for
  // per-beat work would be the same eight tiles asking to be kept in step.
  const editingBeat = timelineBeat !== null
    ? beats.find((b) => b.beatNumber === timelineBeat && (b.imageUrl || b.videoUrl)) ?? null
    : null;
  const editingMotion = editingBeat ? (editingBeat.imageMotion ?? imageMotion) : imageMotion;
  // A transition belongs to the cut after a beat, so selecting a beat selects
  // the cut that follows it.
  const editingTransition = editingBeat ? (editingBeat.transition ?? transition) : transition;
  /** The cuts that carry their own, and what they were given. With any of
   *  these and no beat selected the tab has no single answer, so it says
   *  "mixed" rather than showing the project's and looking like the shuffle
   *  did nothing. */
  const ownCuts = beats.filter((b) => b.transition);
  const mixedCuts = !editingBeat && ownCuts.length > 0;
  const mixedKinds = [...new Set(ownCuts.map((b) => b.transition as string))];
  // Walks the kinds actually in use so the preview shows the variety rather
  // than one of them forever.
  const mixedPreview = mixedKinds.length ? mixedKinds[randomPreviewStep % mixedKinds.length] : "none";

  useEffect(() => {
    const cycling = previewMotion === "random"
      || (effectsTab === "transitions" && mixedKinds.length > 1);
    if (!cycling) return;
    const t = setInterval(() => setRandomPreviewStep((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, [previewMotion, effectsTab, mixedKinds.length]);

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
          captions_animation: captionsAnimation,
          image_motion: imageMotion,
          image_motion_seconds: imageMotionSeconds || null,
          image_motion_strength: imageMotionStrength,
          transition,
          transition_seconds: transition === "none" ? null : transitionSeconds,
          video_filter: videoFilter,
          video_filter_strength: videoFilterStrength,
          sfx_volume: sfxVolume,
          // These were only written when Assemble was clicked, so moving the
          // logo or the music level and then reloading lost the change. They
          // are settings like the rest and save like the rest.
          logo_x: logoX,
          logo_y: logoY,
          logo_size: logoSize,
          background_music_volume: bgmVolume,
          video_resolution: selectedResolution,
        }),
      }).catch(() => { /* non-blocking — Assemble click is the safety net */ });
    }, 500);
    return () => clearTimeout(t);
  }, [trimSilence, captionsEnabled, captionsLanguage, captionsStyle, captionsSize, captionsPosition, captionsAnimation, imageMotion, imageMotionSeconds, imageMotionStrength, transition, transitionSeconds, videoFilter, videoFilterStrength, sfxVolume, logoX, logoY, logoSize, bgmVolume, selectedResolution, projectId]);
  const [assembling, setAssembling] = useState(false);

  // A press anywhere that is not the selected overlay drops the selection,
  // taking its outline and handles with it.
  //
  // On the document, in the capture phase, rather than on the preview frame.
  // An overlay stops the event to run its own drag, so nothing bubbled to the
  // frame from one, and a handler on the frame only sees presses that reach
  // that particular div. This sees every press and decides from the target.
  //
  // The controls are exempt: the panel is where the words are typed and the
  // style is picked, and deselecting on a press there would close the thing
  // being edited.
  useEffect(() => {
    if (!selectedText && !selectedElement && !selectedSound) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest) return;
      if (el.closest("[data-overlay-keep]")) return;
      const id = el.closest("[data-overlay]")?.getAttribute("data-overlay");
      if (id && (id === selectedText || id === selectedElement || id === selectedSound)) return;
      setSelectedElement(null);
      setSelectedText(null);
      setSelectedSound(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [selectedText, selectedElement, selectedSound]);

  // Backspace removes whatever is selected, text or element.
  //
  // Not while typing: the content field is a text input and the same key is
  // how you correct a word in it, so a keystroke aimed at the words must never
  // delete the line they belong to. Same for any other field on the page.
  useEffect(() => {
    if (!selectedText && !selectedElement && !selectedSound) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if (assembling) return;
      e.preventDefault();
      if (selectedText) void removeText(selectedText);
      else if (selectedSound) void removeSound(selectedSound);
      else if (selectedElement) void removeElement(selectedElement);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedText, selectedElement, selectedSound, assembling, removeText, removeElement, removeSound]);

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
  /** Final mode: a render exists and the page is showing it. Nothing on the
   *  timeline can be changed here, because none of it is in the video on
   *  screen — Edit is the way back. */
  const finalMode = showPreview && showFinished && !renderStale;
  /** Nothing on the timeline can be touched while a render is running either:
   *  the clips are already being encoded from the settings as they were. */
  const timelineLocked = finalMode || assembling;

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
    // Wait for the restore, or this fires first on mount with the defaults and
    // overwrites the mode that was just read back.
    if (!previewUrl || !localLoaded.current) return;
    if (seenRender === previewUrl) return;
    setSeenRender(previewUrl);
    setRenderStale(false);
    setShowFinished(true);
  }, [previewUrl, seenRender]);

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
          captionsAnimation,
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
          captionsAnimation,
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

  /**
   * One element tile: drag it onto the preview or the timeline to place it.
   *
   * Shared with the Custom tab for the same reason the sound tile is: an
   * uploaded element should behave like a shipped one, not merely resemble it.
   */
  const renderElementTile = (el: { id: string; label: string; src: string }) => (
            <button
              key={el.id}
              type="button"
              disabled={assembling}
              title={`Drag ${el.label} onto the preview`}
              onPointerDown={(e) => {
                if (assembling) return;
                e.preventDefault();
                setPickedElement(el.id);
                setDraggingElement({ id: el.id, x: e.clientX, y: e.clientY });
                const move = (ev: PointerEvent) => setDraggingElement({ id: el.id, x: ev.clientX, y: ev.clientY });
                const up = (ev: PointerEvent) => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                  setDraggingElement(null);
                  const frame = previewFrameRef.current;
                  const strip = timelineStripRef.current;
                  // Dropped on the preview: it lands where it was
                  // dropped and runs from the playhead.
                  if (frame) {
                    const r = frame.getBoundingClientRect();
                    if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
                      void addElement({
                        element: el.id,
                        start_sec: playhead,
                        end_sec: Math.min(timelineTotal || playhead + 3, playhead + 3),
                        x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)),
                        y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)),
                        size: defaultSizeFor(el.id),
                      });
                      return;
                    }
                  }
                  // Dropped on the timeline: it lands at that moment,
                  // in the corner, for placing later.
                  if (strip) {
                    const r = strip.getBoundingClientRect();
                    if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 40 && ev.clientY <= r.bottom + 40) {
                      const at = Math.max(0, (ev.clientX - r.left) / pxPerSecond);
                      // The track it was dropped over, measured from
                      // the element rows rather than the whole strip.
                      const rowsTop = elementRowsRef.current?.getBoundingClientRect().top ?? ev.clientY;
                      const lane = Math.max(0, Math.min(9, Math.floor((ev.clientY - rowsTop) / LANE_H)));
                      void addElement({
                        element: el.id,
                        start_sec: at,
                        end_sec: Math.min(timelineTotal || at + 3, at + 3),
                        x: ELEMENT_DEFAULTS.x,
                        y: ELEMENT_DEFAULTS.y,
                        size: defaultSizeFor(el.id),
                        lane,
                      });
                    }
                  }
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
              className="h-[60px] rounded-lg flex items-center justify-center p-2 transition-all disabled:opacity-40 cursor-grab"
              style={pickedElement === el.id
                ? {
                    background: "oklch(0.72 0.25 285 / 0.18)",
                    border: "1px solid oklch(0.72 0.25 285)",
                  }
                // Transparent rather than absent, so the tile does not resize
                // by a pixel the moment it is selected.
                : { border: "1px solid transparent" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={el.src} alt={el.label} className="h-11 w-auto" />
            </button>
  );

  /**
   * The controls for one placed sound: what it is, when, how loud, how high.
   *
   * Rendered at the block on the timeline rather than in the panel above. The
   * panel is four hundred pixels from the thing being edited, and a level
   * slider you cannot see the block of is a slider you adjust by guesswork.
   */
  const renderPlacedSoundControls = (snd: ProjectSound) => {
    const name = soundLibrary.find((x) => x.id === snd.sound)?.label ?? snd.sound;
    const sounding = auditioning === snd.sound;
    return (
      <>
        <div className="flex items-center justify-between gap-2">
          {/* The title is the handle. Dragging from anywhere would fight the
              sliders, and a bar with nothing on it would cost a row of height
              for no information. */}
          <p
            className="text-[11px] font-semibold min-w-0 truncate cursor-grab active:cursor-grabbing select-none"
            style={{ color: "var(--c-85)" }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const startX = e.clientX;
              const startY = e.clientY;
              const from = soundPanelPos ?? { x: startX, y: startY };
              const move = (m: PointerEvent) => {
                // Clamped to the viewport, leaving a corner of the panel always
                // reachable: dragged fully off screen it could not be dragged
                // back, and it does not close on its own.
                const x = Math.max(8 - PLACED_PANEL_W + 60, Math.min(window.innerWidth - 60, from.x + (m.clientX - startX)));
                const y = Math.max(8, Math.min(window.innerHeight - 40, from.y + (m.clientY - startY)));
                setSoundPanelPos({ x, y });
              };
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
          >
            {name}
            <span className="font-normal" style={{ color: "var(--c-45)" }}>{` · ${fmtClock(snd.at_sec)}`}</span>
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button"
              onClick={() => sounding ? stopSound() : playSound(snd.sound, snd.volume, snd.pitch)}
              disabled={assembling}
              className="text-[11px] underline underline-offset-2 disabled:opacity-40" style={{ color: "var(--c-50)" }}>
              {sounding ? "Pause" : "Play"}
            </button>
            <button type="button" onClick={() => void removeSound(snd.id)} disabled={assembling}
              className="text-[11px] underline underline-offset-2 disabled:opacity-40" style={{ color: "var(--c-50)" }}>
              Remove
            </button>
          </div>
        </div>
        {/* Level and pitch, the two things a placed sound has beyond when it
            happens. Committed on release, so a drag is not a write per frame. */}
        {([["Volume", "volume", 0, 2, snd.volume],
           ["Pitch", "pitch", 0.5, 2, snd.pitch]] as const).map(([label, key, lo, hi, val]) => (
          <div key={key} className="flex items-center gap-2">
            <span className="shrink-0 w-12 text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
              {label}
            </span>
            <input
              type="range" min={lo} max={hi} step={0.05}
              value={val}
              disabled={assembling}
              onChange={(e) => updateSound(snd.id, { [key]: Number(e.target.value) }, false)}
              onPointerUp={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                updateSound(snd.id, { [key]: v });
                playSound(snd.sound, key === "volume" ? v : snd.volume, key === "pitch" ? v : snd.pitch);
              }}
              className="flex-1 min-w-0 accent-[oklch(0.65_0.15_145)] disabled:opacity-40"
            />
            <span className="shrink-0 w-9 text-right text-[10px] font-mono tabular-nums" style={{ color: "var(--c-55)" }}>
              {key === "volume" ? `${Math.round(val * 100)}%` : `${val.toFixed(2)}x`}
            </span>
          </div>
        ))}
      </>
    );
  };

  /**
   * One sound tile: audition on click, drag onto the timeline to place it.
   *
   * Lifted out of the library grid so the Custom tab renders the same control
   * rather than a second list that looks similar and behaves differently. An
   * uploaded sound is a sound.
   */
  const renderSoundTile = (snd: { id: string; label: string; hint?: string }) => {
            const active = editingBeat
              ? editingBeat.soundEffect === snd.id
              : pickedSound === snd.id;
            // Sounding right now, so the glyph offers to stop it rather than
            // to start it again.
            const sounding = auditioning === snd.id;
            return (
              <button
                key={snd.id}
                type="button"
                disabled={assembling}
                // An upload has no hint; its name is the description.
                title={`${snd.hint ?? snd.label} · drag onto the timeline to place it`}
                // Dragging places the sound at a moment; clicking
                // still auditions it and still sets the selected
                // beat's sound. A tile that only did one of those
                // would lose the other.
                onPointerDown={(e) => {
                  if (assembling) return;
                  setDraggingSound({ id: snd.id, x: e.clientX, y: e.clientY });
                  const move = (ev: PointerEvent) => setDraggingSound({ id: snd.id, x: ev.clientX, y: ev.clientY });
                  const up = (ev: PointerEvent) => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                    setDraggingSound(null);
                    const view = timelineViewportRef.current;
                    const strip = timelineStripRef.current;
                    if (!view || !strip) return;
                    const v = view.getBoundingClientRect();
                    if (ev.clientX < v.left || ev.clientX > v.right || ev.clientY < v.top || ev.clientY > v.bottom) return;
                    // Timed off the strip, which is as wide as the
                    // whole video, and hit-tested against the
                    // viewport, which is what is on screen.
                    const r = strip.getBoundingClientRect();
                    const own = shapeOf(snd.id);
                    const rowsTop = soundRowsRef.current?.getBoundingClientRect().top ?? ev.clientY;
                    void addSound({
                      sound: snd.id,
                      at_sec: Math.max(0, (ev.clientX - r.left) / pxPerSecond),
                      volume: own.volume,
                      pitch: own.pitch,
                      lane: Math.max(0, Math.min(9, Math.floor((ev.clientY - rowsTop) / LANE_H))),
                    });
                  };
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }}
                onClick={() => {
                  // Always playable, even with nothing selected: a
                  // greyed-out row of names reads as broken, and
                  // hearing the library is how anyone decides which
                  // one they want. With a beat selected it is also
                  // the choice.
                  // This sound's own tuning: what it was left at,
                  // or untouched if it has never been tuned. A beat
                  // already carrying it keeps what is on the beat.
                  const own = shapeOf(snd.id);
                  const onThisBeat = editingBeat?.soundEffect === snd.id;
                  const volume = onThisBeat ? (editingBeat!.soundVolume ?? 1) : own.volume;
                  const pitch = onThisBeat ? (editingBeat!.soundPitch ?? 1) : own.pitch;
                  // A second click on the one that is sounding stops it.
                  // Restarting from the top was all a click could do, which
                  // made a long sound impossible to cut short.
                  if (sounding) stopSound();
                  else playSound(snd.id, volume, pitch);
                  setPickedSound(active ? null : snd.id);
                  if (editingBeat) {
                    setBeatSound(
                      editingBeat.beatNumber,
                      active ? null : snd.id,
                      active ? undefined : { volume: own.volume, pitch: own.pitch },
                    );
                  }
                }}
                className="w-full p-1.5 rounded-lg text-left text-[11px] transition-all disabled:opacity-40 flex items-center gap-1.5"
                style={active ? {
                  background: "oklch(0.72 0.25 285 / 0.18)",
                  border: "1px solid oklch(0.72 0.25 285)",
                  color: "var(--accent-purple-text)",
                } : {
                  background: "var(--bg-input)",
                  border: "1px solid var(--bd-card)",
                  color: "var(--c-60)",
                }}
              >
                {/* Laid out as a file rather than a word: something to press,
                    a name, a waveform, and how long it runs. A span and not a
                    button, because the tile is already one and clicking
                    anywhere on it auditions. */}
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                  style={active
                    ? { background: "oklch(0.72 0.25 285 / 0.35)", color: "var(--accent-purple-text)" }
                    : { background: "var(--bd-card)", color: "var(--c-55)" }}
                >
                  {sounding
                    ? <Pause size={9} fill="currentColor" strokeWidth={0} />
                    : <Play size={9} fill="currentColor" strokeWidth={0} />}
                </span>
                <span className="min-w-0 flex-1 flex flex-col gap-1">
                  <span className="flex items-center gap-1">
                    <span className="truncate flex-1">{snd.label}</span>
                    {active && <Check size={11} className="shrink-0" />}
                    {/* How many other beats already use it, so the tab shows
                        the shape of the whole video rather than only what was
                        last clicked. */}
                    {!active && usedCounts[snd.id] > 0 && (
                      <span className="shrink-0 text-[9px] tabular-nums px-1 rounded"
                        style={{ color: "var(--c-38)", background: "var(--bd-card)" }}>
                        {usedCounts[snd.id]}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-[3px]">
                    <span className="flex items-center gap-[1.5px] h-2.5 flex-1 overflow-hidden">
                      {waveformBars(snd.id, secondsFor(snd.id)).map((h, i) => (
                        <span
                          key={i}
                          className="w-[2px] rounded-full shrink-0"
                          style={{ height: `${h}%`, background: "currentColor", opacity: active ? 0.55 : 0.3 }}
                        />
                      ))}
                    </span>
                    <span className="shrink-0 text-[9px] tabular-nums" style={{ opacity: 0.55 }}>
                      {secondsFor(snd.id).toFixed(1)}s
                    </span>
                  </span>
                </span>
              </button>
            );
  };

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
                      const needs = requiredTierForResolution(p);
                      const locked = !!needs && tierRank(userTier) < tierRank(needs);
                      const active = selectedResolution === p;
                      return (
                        <button
                          key={p}
                          onClick={() => {
                            if (locked) {
                              // Pop the SubscriptionModal so the user
                              // can upgrade in-place rather than just
                              // being told "no" by a toast, and land on
                              // the tier this preset actually needs.
                              openUpgrade(needs === "max" ? "heclus_max" : "heclus_pro");
                              return;
                            }
                            setSelectedResolution(p);
                          }}
                          disabled={assembling}
                          title={locked && needs
                            ? `${tierLabel(needs)} plan unlocks ${p} (${dimsFor(aspectRatio, p).label}), click to upgrade`
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
                          {needs && (
                            <span
                              className="text-[8px] px-1 py-px rounded leading-none uppercase font-bold tracking-wide"
                              style={{
                                // Max sits above Pro, so it gets the warmer
                                // badge rather than repeating Pro's purple.
                                background: needs === "max" ? "oklch(0.72 0.19 55)" : "oklch(0.72 0.25 285)",
                                color: "white",
                              }}
                            >
                              {tierLabel(needs)}
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

            {/* Two collapsed rows, side by side. Both are closed most of the
                time and their summaries are one line each, so stacking them
                spent a screen of height on two sentences. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
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
                          ? `On · ${captionsStyle}, ${captionsSize}, ${captionsPosition}${captionsAnimation === "none" ? "" : `, ${captionsAnimation}`}`
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
                    {/* What the choices add up to, on one of the project's own
                        frames. Style, size and position are three lists of
                        words otherwise, and nobody can tell "classic" from
                        "minimal" by reading them. Sized in container units, so
                        the caption occupies the same fraction of this box as it
                        will of the video. */}
                    {/* On a wide screen the frame leaves half the card empty, so what is currently selected reads out beside it. Read-only on purpose: the controls for these are below, and a second set of them here would be two places to change the same thing. */}
                    <div className="lg:flex lg:gap-4 lg:items-start">
                    {tileUrl && (
                      <div
                        className="relative w-full max-w-[320px] rounded-lg overflow-hidden"
                        style={{
                          aspectRatio: aspectRatio === "9:16" ? "9 / 16" : aspectRatio === "1:1" ? "1 / 1" : "16 / 9",
                          containerType: "size",
                          border: "1px solid var(--bd-card)",
                        }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <TileFrame url={tileUrl} isClip={tileIsClip}
                          className="absolute inset-0 w-full h-full object-cover"
                          style={{ filter: gradeCss(videoFilter, videoFilterStrength) }} />
                        <CaptionOverlay
                          text={previewBeat?.scriptSegment ?? ""}
                          style={captionsStyle}
                          size={captionsSize}
                          position={captionsPosition}
                          animation={captionsAnimation}
                        />
                      </div>
                    )}
                    <dl className="hidden lg:block lg:flex-1 min-w-0 space-y-1.5 text-xs">
                      {([
                        ["Style", CAPTION_STYLES.find((x) => x.id === captionsStyle)?.label ?? captionsStyle],
                        ["Size", CAPTION_SIZES.find((x) => x.id === captionsSize)?.label ?? captionsSize],
                        ["Position", CAPTION_POSITIONS.find((x) => x.id === captionsPosition)?.label ?? captionsPosition],
                        ["Animation", CAPTION_ANIMATIONS.find((x) => x.id === captionsAnimation)?.label ?? captionsAnimation],
                        ["Language", CAPTION_LANGUAGES.find((x) => x.code === captionsLanguage)?.label ?? captionsLanguage],
                      ] as [string, string][]).map(([label, value]) => (
                        <div key={label} className="flex items-baseline justify-between gap-3">
                          <dt style={{ color: "var(--c-40)" }}>{label}</dt>
                          <dd className="truncate" style={{ color: "var(--c-65)" }}>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    </div>
                    <div>
                      <button
                        type="button"
                        onClick={() => setCaptionStyleOpen((v) => !v)}
                        aria-expanded={captionStyleOpen}
                        className="w-full flex items-center justify-between gap-2 mb-2"
                      >
                        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Style</span>
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs truncate" style={{ color: "var(--c-55)" }}>
                            {CAPTION_STYLES.find((x) => x.id === captionsStyle)?.label ?? captionsStyle}
                          </span>
                          <span style={{ color: "var(--c-45)" }}>
                            {captionStyleOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </span>
                        </span>
                      </button>
                      <div className={`grid grid-cols-2 xl:grid-cols-3 gap-1.5 ${captionStyleOpen ? "" : "hidden"}`}>
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

                    <div>
                      <button
                        type="button"
                        onClick={() => setCaptionPlacementOpen((v) => !v)}
                        aria-expanded={captionPlacementOpen}
                        className="w-full flex items-center justify-between gap-2 mb-2"
                      >
                        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Size & position</span>
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs truncate" style={{ color: "var(--c-55)" }}>
                            {CAPTION_SIZES.find((x) => x.id === captionsSize)?.label ?? captionsSize}
                            {" · "}
                            {CAPTION_POSITIONS.find((x) => x.id === captionsPosition)?.label ?? captionsPosition}
                          </span>
                          <span style={{ color: "var(--c-45)" }}>
                            {captionPlacementOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </span>
                        </span>
                      </button>
                    <div className={`flex gap-4 ${captionPlacementOpen ? "" : "hidden"}`}>
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
                    </div>

                    <div>
                      <button
                        type="button"
                        onClick={() => setCaptionAnimOpen((v) => !v)}
                        aria-expanded={captionAnimOpen}
                        className="w-full flex items-center justify-between gap-2 mb-2"
                      >
                        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Animation</span>
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs truncate" style={{ color: "var(--c-55)" }}>
                            {CAPTION_ANIMATIONS.find((x) => x.id === captionsAnimation)?.label ?? captionsAnimation}
                          </span>
                          <span style={{ color: "var(--c-45)" }}>
                            {captionAnimOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </span>
                        </span>
                      </button>
                      <div className={`grid grid-cols-2 xl:grid-cols-3 gap-1.5 ${captionAnimOpen ? "" : "hidden"}`}>
                        {CAPTION_ANIMATIONS.map((a) => (
                          <button key={a.id} onClick={() => setCaptionsAnimation(a.id)} disabled={assembling}
                            title={a.hint}
                            className="py-2 px-3 rounded-xl text-left transition-all disabled:opacity-40"
                            style={captionsAnimation === a.id ? {
                              background: "oklch(0.72 0.25 285 / 0.15)",
                              border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                            } : {
                              background: "var(--bg-input)",
                              border: "1px solid var(--bd-card)",
                            }}>
                            <p className="text-xs font-medium" style={{ color: captionsAnimation === a.id ? "var(--accent-purple-text)" : "var(--c-60)" }}>{a.label}</p>
                          </button>
                        ))}
                      </div>
                      {WORD_TIMED_CAPTIONS.includes(captionsAnimation) && captionsLanguage !== "source" && (
                        <p className="text-xs mt-1.5" style={{ color: "var(--c-38)" }}>
                          Translated captions no longer line up with the spoken words, so this renders as a fade.
                        </p>
                      )}
                    </div>
                    <div>
                      <button
                        type="button"
                        onClick={() => setCaptionLangOpen((v) => !v)}
                        aria-expanded={captionLangOpen}
                        className="w-full flex items-center justify-between gap-2 mb-2"
                      >
                        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Language</span>
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs truncate" style={{ color: "var(--c-55)" }}>
                            {CAPTION_LANGUAGES.find((x) => x.code === captionsLanguage)?.label ?? captionsLanguage}
                          </span>
                          <span style={{ color: "var(--c-45)" }}>
                            {captionLangOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </span>
                        </span>
                      </button>
                      <div className={`flex flex-wrap gap-1.5 ${captionLangOpen ? "" : "hidden"}`}>
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
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setExportConfirmOpen(true); }}
                    disabled={!hasVoiceover || assembling}
                    title={hasVoiceover ? "Render the finished video" : "Generate a voiceover first"}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-40"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                  >
                    {assembling ? "Rendering…" : showPreview ? "Re-render" : "Render"}
                  </button>
                  {showPreview && previewUrl && !renderStale && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (showFinished) setEditConfirmOpen(true);
                        else setShowFinished(true);
                      }}
                      title={showFinished ? "Go back to editing" : "Watch the assembled video"}
                      className="px-3 py-1.5 rounded-xl text-xs font-semibold transition-all"
                      style={showFinished
                        ? { background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-70)" }
                        : { background: "oklch(0.72 0.25 285 / 0.18)", border: "1px solid oklch(0.72 0.25 285 / 0.45)", color: "var(--accent-purple-text)" }}
                    >
                      {showFinished ? "Edit" : "Watch"}
                    </button>
                  )}
                  {/* Only once there is something to download. The href goes
                      through our route, which redirects to a presigned
                      attachment URL: an anchor's download attribute is ignored
                      cross-origin, so linking R2 opened the video in the tab. */}
                  {showPreview && previewUrl && !previewLoadError && (
                    <a
                      href={`/api/projects/${projectId}/export-video?url=${encodeURIComponent(previewUrl)}&filename=${encodeURIComponent(`${(project?.channel_name as string | undefined)?.trim() || "video"}.mp4`)}`}
                      onClick={(e) => e.stopPropagation()}
                      title={renderStale ? "Download the last assembled video" : "Download the finished video"}
                      className="px-3 py-1.5 rounded-xl text-xs font-semibold transition-all"
                      style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-70)" }}
                    >
                      {renderStale ? "↓ Export previous" : "↓ Export"}
                    </a>
                  )}
                  <span style={{ color: "var(--c-45)" }}>
                    {effectsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </span>
                </div>
              </div>
              {draggingSound && (
                <span
                  className="fixed z-50 pointer-events-none inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                  style={{
                    left: draggingSound.x,
                    top: draggingSound.y,
                    transform: "translate(-50%, -50%)",
                    background: "oklch(0.65 0.15 145 / 0.3)",
                    border: "1px solid oklch(0.65 0.15 145)",
                    color: "var(--c-80)",
                  }}
                >
                  <Volume2 size={10} />
                  {soundLibrary.find((x) => x.id === draggingSound.id)?.label ?? draggingSound.id}
                </span>
              )}
              {draggingText && (() => {
                const tpl = TEXT_TEMPLATES.find((t) => t.id === draggingText.id);
                if (!tpl) return null;
                return (
                  <span
                    className="fixed z-50 pointer-events-none font-bold whitespace-nowrap"
                    style={{
                      left: draggingText.x,
                      top: draggingText.y,
                      transform: "translate(-50%, -50%)",
                      color: tpl.colour,
                      fontSize: 20,
                      ...textStyleCss(tpl.style, tpl.bg, tpl.bgOpacity),
                    }}
                  >
                    {tpl.content}
                  </span>
                );
              })()}
              {draggingElement && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={elementSrc(draggingElement.id)}
                  alt=""
                  className="fixed z-50 pointer-events-none"
                  style={{
                    left: draggingElement.x,
                    top: draggingElement.y,
                    transform: "translate(-50%, -50%)",
                    width: 120,
                    opacity: 0.85,
                    filter: "drop-shadow(0 4px 10px oklch(0 0 0 / 0.5))",
                  }}
                />
              )}
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
                      ref={previewFrameRef}
                      className="relative w-full overflow-hidden"
                      style={{
                        aspectRatio: aspectRatio === "9:16" ? "9 / 16" : aspectRatio === "1:1" ? "1 / 1" : "16 / 9",
                        // The caption sizes itself against this box, so the
                        // containment goes here where the height is definite.
                        containerType: "size",
                      }}
                    >
                      {/* The finished render, in the frame the edit was made
                          in. Everything under it is still there and comes back
                          the moment it is toggled off. */}
                      {showPreview && previewUrl && !previewLoadError && showFinished && !renderStale ? (
                        <video
                          key={previewUrl}
                          src={previewUrl}
                          controls
                          className="absolute inset-0 w-full h-full object-contain"
                          style={{ background: "black" }}
                          onError={() => setPreviewLoadError(true)}
                          onLoadedMetadata={() => setPreviewLoadError(false)}
                        />
                      ) : (
                      <>
                      {/* The grade goes on the picture, not on the frame: it
                          covers both shots through a seam, and the caption and
                          the logo above it stay ungraded, which is where the
                          render puts them. */}
                      <div className="absolute inset-0" style={{ filter: gradeCss(videoFilter, videoFilterStrength) }}>
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
                        <img src={playbackSeam.url} alt="" className="absolute inset-0 w-full h-full object-cover"
                          style={seamUnderStyle(playbackSeam.kind, playbackSeam.p)} />
                      )}
                      {effectsTab === "transitions" && (mixedCuts ? mixedPreview : editingTransition) !== "none" && !playing && tileUrl && nextPreviewUrl ? (
                        <>
                          <TileFrame url={nextPreviewUrl} isClip={nextIsClip} className="absolute inset-0 w-full h-full object-cover" />
                          <TileFrame
                            url={tileUrl}
                            isClip={tileIsClip}
                            frameKey={`seam-${mixedCuts ? mixedPreview : editingTransition}`}
                            className="absolute inset-0 w-full h-full object-cover"
                            style={{
                              animation: SEAM_ANIMATION[mixedCuts ? mixedPreview : editingTransition],
                              ...(SEAM_MASK[mixedCuts ? mixedPreview : editingTransition] ?? {}),
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
                          style={playbackSeam ? seamStyle(playbackSeam.kind, playbackSeam.p) : previewAnimation ? {
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
                        style={playbackSeam ? seamStyle(playbackSeam.kind, playbackSeam.p) : previewAnimation ? {
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

                      {/* What the render will draw over the picture: the
                          caption, and the logo where it was placed. Both sit
                          outside the graded layer, and both follow the same
                          numbers the worker uses — the caption sized as a
                          fraction of the frame, the logo positioned and sized
                          as fractions of the width. */}
                      {captionsEnabled && (
                        <CaptionOverlay
                          text={previewCaption}
                          style={captionsStyle}
                          size={captionsSize}
                          position={captionsPosition}
                          animation={captionsAnimation}
                          loop={!playing}
                        />
                      )}
                      {/* Every element on screen at this moment, over the
                          picture and under the logo, exactly as the render
                          stacks them. Draggable because a position typed
                          as two numbers is a position nobody gets right. */}
                      {[...projectElements]
                        .sort((a, b) => (a.lane ?? 0) - (b.lane ?? 0))
                        .filter((el) => playhead >= el.start_sec && playhead < el.end_sec)
                        .map((el) => {
                          // Not gated on the tab any more: the overlay only
                          // draws when the page is off the finished render, and
                          // an element you can see on the preview is one you
                          // expect to be able to drag, whichever tab is open.
                          const editable = !assembling;
                          const picked = selectedElement === el.id;
                          return (
                            <div
                              key={el.id}
                              data-overlay={el.id}
                              className="absolute touch-none"
                              style={{
                                left: `${el.x * 100}%`,
                                top: `${el.y * 100}%`,
                                width: `${el.size * 100}%`,
                                outline: picked && editable ? "1px dashed oklch(0.72 0.25 285)" : undefined,
                                outlineOffset: 2,
                              }}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={elementSrc(el.element)}
                                alt=""
                                draggable={false}
                                onPointerDown={!editable ? undefined : (ev) => {
                                  ev.preventDefault();
                                  ev.stopPropagation();
                                  setSelectedElement(el.id);
                                  const frame = previewFrameRef.current;
                                  if (!frame) return;
                                  const r = frame.getBoundingClientRect();
                                  // Where inside it the drag began, so it stays
                                  // under the pointer rather than jumping its
                                  // own corner there.
                                  const grabX = (ev.clientX - r.left) / r.width - el.x;
                                  const grabY = (ev.clientY - r.top) / r.height - el.y;
                                  const at = (m: PointerEvent) => ({
                                    x: Math.max(0, Math.min(1, (m.clientX - r.left) / r.width - grabX)),
                                    y: Math.max(0, Math.min(1, (m.clientY - r.top) / r.height - grabY)),
                                  });
                                  const move = (m: PointerEvent) => updateElement(el.id, at(m), false);
                                  const up = (m: PointerEvent) => {
                                    window.removeEventListener("pointermove", move);
                                    window.removeEventListener("pointerup", up);
                                    updateElement(el.id, at(m));
                                  };
                                  window.addEventListener("pointermove", move);
                                  window.addEventListener("pointerup", up);
                                }}
                                className="block w-full h-auto touch-none"
                                style={{
                                  cursor: editable ? "grab" : "default",
                                  filter: "drop-shadow(0 2px 6px oklch(0 0 0 / 0.5))",
                                }}
                              />
                              {editable && picked && (
                                <span
                                  onPointerDown={(ev) => {
                                    ev.stopPropagation();
                                    ev.preventDefault();
                                    setSelectedElement(el.id);
                                    const frame = previewFrameRef.current;
                                    if (!frame) return;
                                    const r = frame.getBoundingClientRect();
                                    const left = el.x * r.width;
                                    const sizeAt = (m: PointerEvent) =>
                                      Math.max(0.05, Math.min(0.8, (m.clientX - r.left - left) / r.width));
                                    const move = (m: PointerEvent) => updateElement(el.id, { size: sizeAt(m) }, false);
                                    const up = (m: PointerEvent) => {
                                      window.removeEventListener("pointermove", move);
                                      window.removeEventListener("pointerup", up);
                                      updateElement(el.id, { size: sizeAt(m) });
                                    };
                                    window.addEventListener("pointermove", move);
                                    window.addEventListener("pointerup", up);
                                  }}
                                  className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 rounded-full cursor-nwse-resize touch-none"
                                  style={{ background: "oklch(0.72 0.25 285)", border: "2px solid white" }}
                                />
                              )}
                            </div>
                          );
                        })}
                      {/* Text on the preview, over the picture and under the
                          logo, the way the render stacks it. Only the lines
                          whose span covers the playhead: drawing the rest would
                          show a frame the video never has. */}
                      {[...projectTexts]
                        .sort((a, b) => (a.lane ?? 0) - (b.lane ?? 0))
                        .filter((t) => playhead >= t.start_sec && playhead < t.end_sec)
                        .map((t) => {
                          const editable = !assembling;
                          const picked = selectedText === t.id;
                          return (
                            <div
                              key={t.id}
                              data-overlay={t.id}
                              className="absolute touch-none whitespace-nowrap"
                              style={{
                                left: `${t.x * 100}%`,
                                top: `${t.y * 100}%`,
                                // cqh, not px: the preview box declares
                                // containerType size, so the text scales with
                                // the frame exactly as the render scales it
                                // against the video height.
                                fontSize: `${t.size * 100}cqh`,
                                lineHeight: 1.1,
                                fontWeight: 700,
                                color: t.colour,
                                cursor: editable ? "grab" : "default",
                                outline: picked && editable ? "1px dashed oklch(0.72 0.25 285)" : undefined,
                                outlineOffset: 3,
                                ...textStyleCss(t.style, t.bg_colour, t.bg_opacity),
                              }}
                              onPointerDown={!editable ? undefined : (ev) => {
                                ev.preventDefault();
                                ev.stopPropagation();
                                setSelectedText(t.id);
                                const frame = previewFrameRef.current;
                                if (!frame) return;
                                const r = frame.getBoundingClientRect();
                                // Where inside the line the drag began, so it
                                // stays under the pointer rather than jumping
                                // its own corner there.
                                const grabX = (ev.clientX - r.left) / r.width - t.x;
                                const grabY = (ev.clientY - r.top) / r.height - t.y;
                                const move = (m: PointerEvent) => {
                                  updateText(t.id, {
                                    x: Math.max(0, Math.min(1, (m.clientX - r.left) / r.width - grabX)),
                                    y: Math.max(0, Math.min(1, (m.clientY - r.top) / r.height - grabY)),
                                  }, false);
                                };
                                const up = (m: PointerEvent) => {
                                  window.removeEventListener("pointermove", move);
                                  window.removeEventListener("pointerup", up);
                                  updateText(t.id, {
                                    x: Math.max(0, Math.min(1, (m.clientX - r.left) / r.width - grabX)),
                                    y: Math.max(0, Math.min(1, (m.clientY - r.top) / r.height - grabY)),
                                  });
                                };
                                window.addEventListener("pointermove", move);
                                window.addEventListener("pointerup", up);
                              }}
                            >
                              {t.content}
                              {picked && editable && (
                                <>
                                  {/* Drag the corner to size it. Vertical
                                      distance from the top of the line, because
                                      a font is a height and the render sizes it
                                      against the frame height too. */}
                                  <span
                                    onPointerDown={(ev) => {
                                      ev.preventDefault();
                                      ev.stopPropagation();
                                      const frame = previewFrameRef.current;
                                      if (!frame) return;
                                      const r = frame.getBoundingClientRect();
                                      const topPx = t.y * r.height;
                                      const sizeAt = (m: PointerEvent) => Math.max(0.02, Math.min(0.2,
                                        ((m.clientY - r.top) - topPx) / r.height / 1.1));
                                      const move = (m: PointerEvent) => updateText(t.id, { size: sizeAt(m) }, false);
                                      const up = (m: PointerEvent) => {
                                        window.removeEventListener("pointermove", move);
                                        window.removeEventListener("pointerup", up);
                                        updateText(t.id, { size: sizeAt(m) });
                                      };
                                      window.addEventListener("pointermove", move);
                                      window.addEventListener("pointerup", up);
                                    }}
                                    className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 rounded-full cursor-nwse-resize touch-none"
                                    style={{ background: "oklch(0.72 0.25 285)", border: "2px solid white" }}
                                  />
                                  {/* Removing the line you are looking at,
                                      without going back to the panel to find
                                      which of them it was. */}
                                  <button
                                    type="button"
                                    aria-label="Remove this text"
                                    onPointerDown={(ev) => { ev.preventDefault(); ev.stopPropagation(); }}
                                    onClick={(ev) => { ev.stopPropagation(); void removeText(t.id); }}
                                    className="absolute -top-2 -right-2 w-4 h-4 rounded-full flex items-center justify-center cursor-pointer"
                                    style={{ background: "oklch(0.58 0.22 25)", border: "2px solid white", color: "white" }}
                                  >
                                    <X size={8} strokeWidth={4} />
                                  </button>
                                </>
                              )}
                            </div>
                          );
                        })}
                      {(logoUploadedUrl || logoObjectUrl) && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={logoObjectUrl ?? logoUploadedUrl ?? undefined}
                          alt=""
                          className="absolute pointer-events-none"
                          style={{
                            left: `${logoX * 100}%`,
                            top: `${logoY * 100}%`,
                            width: `${logoSize * 100}%`,
                            opacity: 0.95,
                          }}
                        />
                      )}
                      </>
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
                    className={`${assembling ? "hidden" : "sm:hidden"} w-full flex items-center justify-between gap-3 py-1.5`}
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
                {assembling ? (
                  <div className="flex items-center gap-2 px-1 mb-3">
                    <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin"
                      style={{ color: "var(--accent-purple-text)" }} />
                    <p className="text-sm font-semibold">Rendering video</p>
                  </div>
                ) : (
                /* The tabs themselves stay live in final mode: looking at what
                   was set is not changing it. */
                <div className={`flex gap-1 p-1 rounded-xl mb-3 ${finalMode ? "pointer-events-auto" : ""}`}
                  style={{ background: "var(--bg-input)" }}>
                  {([["effects", "Effects"], ["transitions", "Transitions"], ["filters", "Filters"], ["sound", "Sound"], ["elements", "Elements"], ["text", "Text"]] as const).map(([id, label]) => (
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
                )}
                {assembling ? (
                <div className="space-y-4">
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
                </div>
                ) : (
                <div
                  className={finalMode ? "opacity-55 cursor-not-allowed" : ""}
                  onPointerDownCapture={finalMode ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
                  onClickCapture={finalMode ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
                >
                {effectsTab === "text" ? (
                <>
                  {projectTexts.length === 0 && (
                    <p className="text-xs mb-2" style={{ color: "var(--c-45)" }}>
                      Add a line, then drag it where you want it on the preview
                    </p>
                  )}
                  {/* Two ways in, the way an editor usually offers them: a
                      plain line to type into, or an arrangement already made.
                      A template is a placement, a size, a colour and a
                      treatment at once, which is four controls otherwise. */}
                  {([["Add heading", 0.11, "outline", "#FFFFFF", 0.10],
                     ["Add body text", 0.05, "shadow", "#FFFFFF", 0.72]] as const).map(
                    ([label, size, style, colour, y]) => (
                    <button
                      key={label}
                      type="button"
                      disabled={assembling}
                      onClick={() => void addText({
                        content: label === "Add heading" ? "Your heading" : "Your body text",
                        start_sec: playhead,
                        end_sec: Math.min(timelineTotal || playhead + 3, playhead + 3),
                        x: 0.07, y, size, colour, style,
                        lane: Math.min(9, projectTexts.length),
                      })}
                      className="w-full mb-2 px-3 py-2.5 rounded-lg font-bold transition-all disabled:opacity-40 cursor-pointer"
                      style={{
                        background: "var(--bg-input)",
                        border: "1px solid var(--bd-card)",
                        color: "var(--c-80)",
                        fontSize: label === "Add heading" ? 17 : 13,
                      }}
                    >
                      {label}
                    </button>
                  ))}

                  {(["Bold", "Classic", "Subtle"] as const).map((group) => (
                    <div key={group} className="mt-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wider mb-1.5"
                        style={{ color: "var(--c-40)" }}>
                        {group}
                      </p>
                      <div className="min-w-0 grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {TEXT_TEMPLATES.filter((t) => t.group === group).map((tpl) => (
                          <button
                            key={tpl.id}
                            type="button"
                            disabled={assembling}
                            title={`Drag ${tpl.label} onto the preview or the timeline`}
                            // A press starts a drag and a plain click still
                            // adds it at the template's own placement, so the
                            // tile works either way round.
                            onPointerDown={(e) => {
                              if (assembling) return;
                              e.preventDefault();
                              setDraggingText({ id: tpl.id, x: e.clientX, y: e.clientY });
                              const move = (ev: PointerEvent) => setDraggingText({ id: tpl.id, x: ev.clientX, y: ev.clientY });
                              const up = (ev: PointerEvent) => {
                                window.removeEventListener("pointermove", move);
                                window.removeEventListener("pointerup", up);
                                setDraggingText(null);
                                const common = {
                                  content: tpl.content, size: tpl.size,
                                  colour: tpl.colour, style: tpl.style,
                                  bg_colour: tpl.bg ?? null, bg_opacity: tpl.bgOpacity ?? 0.55,
                                };
                                const frame = previewFrameRef.current;
                                const strip = timelineStripRef.current;
                                // Dropped on the preview: it lands where it was
                                // dropped and runs from the playhead.
                                if (frame) {
                                  const r = frame.getBoundingClientRect();
                                  if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
                                    void addText({
                                      ...common,
                                      start_sec: playhead,
                                      end_sec: Math.min(timelineTotal || playhead + 3, playhead + 3),
                                      x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)),
                                      y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)),
                                      lane: Math.min(9, projectTexts.length),
                                    });
                                    return;
                                  }
                                }
                                // Dropped on the timeline: it lands at that
                                // moment, at the template's own placement.
                                //
                                // Hit-tested against the viewport and timed off
                                // the strip. The strip is as wide as the whole
                                // video, so when it is scrolled its box starts
                                // off-screen and a drop that looked like it
                                // landed on the timeline fell outside it.
                                const view = timelineViewportRef.current;
                                if (view && strip) {
                                  const v = view.getBoundingClientRect();
                                  const r = strip.getBoundingClientRect();
                                  if (ev.clientX >= v.left && ev.clientX <= v.right && ev.clientY >= v.top && ev.clientY <= v.bottom) {
                                    const at = Math.max(0, (ev.clientX - r.left) / pxPerSecond);
                                    // The track it was dropped over, measured
                                    // from the text rows rather than the whole
                                    // strip, which starts at the ruler.
                                    const rowsTop = textRowsRef.current?.getBoundingClientRect().top ?? ev.clientY;
                                    const lane = Math.max(0, Math.min(9, Math.floor((ev.clientY - rowsTop) / LANE_H)));
                                    void addText({
                                      ...common,
                                      start_sec: at,
                                      end_sec: Math.min(timelineTotal || at + 3, at + 3),
                                      x: tpl.x, y: tpl.y,
                                      lane,
                                    });
                                    return;
                                  }
                                }
                                // Dropped nowhere in particular: treat it as a
                                // click, which is what it looked like.
                                void addText({
                                  ...common,
                                  start_sec: playhead,
                                  end_sec: Math.min(timelineTotal || playhead + 3, playhead + 3),
                                  x: tpl.x, y: tpl.y,
                                  lane: Math.min(9, projectTexts.length),
                                });
                              };
                              window.addEventListener("pointermove", move);
                              window.addEventListener("pointerup", up);
                            }}
                            className="h-[62px] px-2 rounded-lg flex items-center justify-center overflow-hidden transition-all disabled:opacity-40 cursor-grab"
                            style={{ background: "oklch(0.18 0.01 285)", border: "1px solid var(--bd-card)" }}
                          >
                            {/* The line as it will look, on a dark tile. Six
                                buttons reading Title, Subtitle, Banner all look
                                identical; the thing itself does not. */}
                            <span className="truncate"
                              style={{
                                color: tpl.colour,
                                fontWeight: 700,
                                fontSize: `${Math.max(11, Math.round(tpl.size * 145))}px`,
                                ...textStyleCss(tpl.style, tpl.bg, tpl.bgOpacity),
                              }}>
                              {tpl.content}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}

                  {/* Every line, so one can be picked without hunting for it on
                      the preview, which is where a line placed off-playhead is
                      not drawn at all. */}
                  {projectTexts.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      {projectTexts.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setSelectedText(t.id === selectedText ? null : t.id)}
                          disabled={assembling}
                          className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs truncate transition-all disabled:opacity-40 cursor-pointer"
                          style={selectedText === t.id
                            ? { background: "oklch(0.72 0.25 285 / 0.18)", border: "1px solid oklch(0.72 0.25 285 / 0.45)", color: "var(--accent-purple-text)" }
                            : { background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-70)" }}
                        >
                          {t.content}
                          <span style={{ color: "var(--c-40)" }}>
                            {` · ${fmtClock(t.start_sec)} to ${fmtClock(t.end_sec)}`}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {selectedText && (() => {
                    const t = projectTexts.find((x) => x.id === selectedText);
                    if (!t) return null;
                    return (
                      <div data-overlay-keep className="mt-3 rounded-xl px-3 py-2.5 space-y-2.5"
                        style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold" style={{ color: "var(--accent-purple-text)" }}>
                            Selected line
                          </p>
                          <button type="button" onClick={() => void removeText(t.id)} disabled={assembling}
                            className="text-xs underline underline-offset-2 disabled:opacity-40" style={{ color: "var(--c-50)" }}>
                            Remove
                          </button>
                        </div>

                        <input
                          type="text"
                          value={t.content}
                          maxLength={200}
                          disabled={assembling}
                          onChange={(e) => updateText(t.id, { content: e.target.value })}
                          placeholder="Type your text…"
                          className="w-full px-2.5 py-1.5 rounded-lg text-xs outline-none disabled:opacity-40"
                          style={{ background: "var(--bg-card)", border: "1px solid var(--bd-card)", color: "var(--c-80)" }}
                        />

                        {/* Style, colour and background fold away.
                            Unfolded they are three grids of options for a
                            choice already made, and the panel is taller than
                            the preview it describes. The header carries the
                            current value, so folded still answers "what is it
                            set to". One open at a time, for the same reason. */}
                        {(() => {
                          const rowCls = "w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg transition-all disabled:opacity-40 cursor-pointer";
                          const rowStyle = { background: "var(--bg-card)", border: "1px solid var(--bd-card)" };
                          const labelCls = "text-[11px] uppercase tracking-wider font-semibold";
                          const styleName = TEXT_STYLES.find((x) => x.id === t.style)?.label ?? t.style;
                          const toggle = (k: "style" | "colour" | "bg") =>
                            setTextSection((cur) => (cur === k ? null : k));
                          return (
                            <div className="space-y-1.5">
                              <button type="button" disabled={assembling} className={rowCls} style={rowStyle}
                                onClick={() => toggle("style")}>
                                <span className={labelCls} style={{ color: "var(--c-40)" }}>Style</span>
                                <span className="flex items-center gap-1.5">
                                  {/* The name in its own treatment, so the row
                                      shows the thing rather than naming it. */}
                                  <span className="text-[11px] font-bold px-1.5 py-0.5 rounded"
                                    style={{ background: "oklch(0.18 0.01 285)", color: "#FFFFFF", ...glyphCss(t.style) }}>
                                    {styleName}
                                  </span>
                                  {textSection === "style" ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                </span>
                              </button>
                              {textSection === "style" && (
                                <div className="flex flex-wrap gap-1.5 px-0.5 pb-1">
                                  {TEXT_STYLES.map(({ id, label }) => (
                                    <button key={id} type="button" disabled={assembling}
                                      onClick={() => updateText(t.id, { style: id })}
                                      title={label}
                                      className="px-2 py-1 rounded-lg text-[11px] font-bold transition-all disabled:opacity-40 cursor-pointer"
                                      style={{
                                        background: "oklch(0.18 0.01 285)",
                                        border: `1px solid ${t.style === id ? "oklch(0.72 0.25 285)" : "var(--bd-card)"}`,
                                        color: "#FFFFFF",
                                        ...glyphCss(id),
                                      }}>
                                      {label}
                                    </button>
                                  ))}
                                </div>
                              )}

                              <button type="button" disabled={assembling} className={rowCls} style={rowStyle}
                                onClick={() => toggle("colour")}>
                                <span className={labelCls} style={{ color: "var(--c-40)" }}>Colour</span>
                                <span className="flex items-center gap-1.5">
                                  <span className="w-4 h-4 rounded"
                                    style={{ background: t.colour, border: "1px solid var(--bd-card)" }} />
                                  {textSection === "colour" ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                </span>
                              </button>
                              {textSection === "colour" && (
                                <div className="grid grid-cols-10 gap-1 px-0.5 pb-1">
                                  {TEXT_COLOURS.map((c) => (
                                    <button key={c} type="button" disabled={assembling}
                                      onClick={() => updateText(t.id, { colour: c })}
                                      aria-label={`Colour ${c}`}
                                      className="w-full aspect-square rounded-md transition-all disabled:opacity-40 cursor-pointer"
                                      style={{
                                        background: c,
                                        border: t.colour.toLowerCase() === c.toLowerCase()
                                          ? "2px solid oklch(0.72 0.25 285)"
                                          : "1px solid var(--bd-card)",
                                      }} />
                                  ))}
                                </div>
                              )}

                              <button type="button" disabled={assembling} className={rowCls} style={rowStyle}
                                onClick={() => toggle("bg")}>
                                <span className={labelCls} style={{ color: "var(--c-40)" }}>Background</span>
                                <span className="flex items-center gap-1.5">
                                  {t.bg_colour ? (
                                    <span className="w-4 h-4 rounded"
                                      style={{ background: hexToRgba(t.bg_colour, t.bg_opacity), border: "1px solid var(--bd-card)" }} />
                                  ) : (
                                    <span className="text-[11px]" style={{ color: "var(--c-50)" }}>None</span>
                                  )}
                                  {textSection === "bg" ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                </span>
                              </button>
                              {textSection === "bg" && (
                                <div className="px-0.5 pb-1 space-y-2">
                                  <div className="grid grid-cols-10 gap-1">
                                    {/* None first: most text wants none, and it
                                        is the only option that is an absence
                                        rather than a colour. */}
                                    <button type="button" disabled={assembling}
                                      onClick={() => updateText(t.id, { bg_colour: null })}
                                      aria-label="No background"
                                      className="w-full aspect-square rounded-md text-[9px] font-medium transition-all disabled:opacity-40 cursor-pointer"
                                      style={{
                                        background: "var(--bg-card)",
                                        border: `1px solid ${t.bg_colour ? "var(--bd-card)" : "oklch(0.72 0.25 285)"}`,
                                        color: "var(--c-55)",
                                      }}>
                                      None
                                    </button>
                                    {TEXT_COLOURS.map((c) => (
                                      <button key={`bg-${c}`} type="button" disabled={assembling}
                                        onClick={() => updateText(t.id, { bg_colour: c })}
                                        aria-label={`Background ${c}`}
                                        className="w-full aspect-square rounded-md transition-all disabled:opacity-40 cursor-pointer"
                                        style={{
                                          background: c,
                                          border: t.bg_colour?.toLowerCase() === c.toLowerCase()
                                            ? "2px solid oklch(0.72 0.25 285)"
                                            : "1px solid var(--bd-card)",
                                        }} />
                                    ))}
                                  </div>
                                  {/* Only once there is a panel to be more or
                                      less solid. */}
                                  {t.bg_colour && (
                                    <div className="flex items-center gap-2">
                                      <span className={labelCls} style={{ color: "var(--c-40)" }}>Opacity</span>
                                      <input
                                        type="range" min={0} max={1} step={0.05}
                                        value={t.bg_opacity}
                                        disabled={assembling}
                                        onChange={(e) => updateText(t.id, { bg_opacity: Number(e.target.value) }, false)}
                                        onPointerUp={(e) => updateText(t.id, { bg_opacity: Number((e.target as HTMLInputElement).value) })}
                                        className="flex-1 min-w-0 accent-[oklch(0.72_0.25_285)] disabled:opacity-40"
                                      />
                                      <span className="shrink-0 w-9 text-right text-[11px] font-mono tabular-nums" style={{ color: "var(--c-55)" }}>
                                        {Math.round(t.bg_opacity * 100)}%
                                      </span>
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Size stays open. It is one control, it is the
                                  one most often reached for, and folding it
                                  would cost a click to save no height. */}
                              <div className="flex items-center gap-2 px-2.5 pt-1">
                                <span className={labelCls} style={{ color: "var(--c-40)" }}>Size</span>
                                <input
                                  type="range" min={0.02} max={0.2} step={0.005}
                                  value={t.size}
                                  disabled={assembling}
                                  onChange={(e) => updateText(t.id, { size: Number(e.target.value) }, false)}
                                  onPointerUp={(e) => updateText(t.id, { size: Number((e.target as HTMLInputElement).value) })}
                                  className="flex-1 min-w-0 accent-[oklch(0.72_0.25_285)] disabled:opacity-40"
                                />
                                <span className="shrink-0 w-9 text-right text-[11px] font-mono tabular-nums" style={{ color: "var(--c-55)" }}>
                                  {Math.round(t.size * 100)}%
                                </span>
                              </div>
                            </div>
                          );
                        })()}

                        <p className="text-xs" style={{ color: "var(--c-38)" }}>
                          Drag it on the preview to move it, or its block on the timeline to retime it.
                        </p>
                      </div>
                    );
                  })()}
                </>
                ) : effectsTab === "elements" ? (
                <>
                  <LibraryTabs value={libTab} onChange={setLibTab} customCount={customElements.length} />
                  {libTab === "all" ? (
                  <>
                  {/* Only while the tab has nothing on it. Once elements are
                      placed the timeline below is showing them, and a count of
                      what is already visible is a line to read past. */}
                  {projectElements.length === 0 && (
                    <p className="text-xs mb-2" style={{ color: "var(--c-45)" }}>
                      Drag one onto the preview, or onto the timeline
                    </p>
                  )}
                  {/* A row that wraps, not a grid. These are different widths
                      by nature — a pill is three times the width of a tile — and
                      a column wide enough for the widest one leaves the square
                      ones swimming in it. Each takes the width its artwork needs
                      at a common height and the row wraps when it runs out. */}
                  <div className="min-w-0 flex flex-wrap gap-2">
                    {elementLibrary.map(renderElementTile)}
                  </div>
                  </>
                  ) : (
                    <CustomAssetPane
                      kind="element"
                      assets={customElements}
                      canUpload={canUploadAssets}
                      busy={assetBusy}
                      error={assetError}
                      onFiles={(f) => uploadCustomAssets("element", f)}
                      onUpgrade={() => openUpgrade("heclus_max")}
                    >
                      <div className="min-w-0 flex flex-wrap gap-2">
                        {customElements.map((a) => (
                          <div key={a.id} className="relative">
                            {renderElementTile({ id: customRef(a.id), label: a.name, src: a.url })}
                            <RemoveAssetButton name={a.name} onRemove={() => deleteCustomAsset(a.id)} />
                          </div>
                        ))}
                      </div>
                    </CustomAssetPane>
                  )}
                  {selectedElement && (() => {
                    const el = projectElements.find((x) => x.id === selectedElement);
                    if (!el) return null;
                    return (
                      <div className="mt-3 rounded-xl px-3 py-2.5 space-y-2"
                        style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold" style={{ color: "var(--accent-purple-text)" }}>
                            {elementLibrary.find((x) => x.id === el.element)?.label ?? el.element}
                            <span className="font-normal" style={{ color: "var(--c-40)" }}>
                              {` · ${fmtClock(el.start_sec)} to ${fmtClock(el.end_sec)}`}
                            </span>
                          </p>
                          <button type="button" onClick={() => removeElement(el.id)} disabled={assembling}
                            className="text-xs underline underline-offset-2 disabled:opacity-40" style={{ color: "var(--c-50)" }}>
                            Remove
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-[11px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                            Size
                          </span>
                          <input
                            type="range" min={0.05} max={0.8} step={0.01}
                            value={el.size}
                            disabled={assembling}
                            onChange={(ev) => updateElement(el.id, { size: Number(ev.target.value) })}
                            className="flex-1 min-w-0 accent-[oklch(0.72_0.25_285)] disabled:opacity-40"
                          />
                          <span className="shrink-0 text-[11px] font-mono tabular-nums" style={{ color: "var(--c-55)" }}>
                            {Math.round(el.size * 100)}%
                          </span>
                        </div>
                        <p className="text-xs" style={{ color: "var(--c-38)" }}>
                          Drag it on the preview to move it, its corner to resize, or its block on the timeline to retime it.
                        </p>
                      </div>
                    );
                  })()}
                </>
                ) : effectsTab === "sound" ? (
                <>
                  {/* The placed-sound editor used to live here. It is at the
                      block on the timeline now: see renderPlacedSoundControls.
                      Keeping a copy here as well would be two panels for one
                      sound, and the far one would win an argument about which
                      value is current. */}
                  {/* A sound belongs to a beat, not to the project: it is an
                      accent on a moment. So this tab needs one selected, and
                      says so rather than quietly doing nothing. */}
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-xs min-w-0 truncate" style={{ color: "var(--c-45)" }}>
                      {editingBeat
                        ? <>Plays at the start of <span style={{ color: "var(--accent-purple-text)" }}>beat {editingBeat.beatNumber}</span></>
                        : Object.keys(usedCounts).length
                          ? `${beats.filter((b) => b.soundEffect).length} beats have a sound`
                          : "Click one to hear it"}
                    </p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {(() => {
                        const inHand = editingBeat?.soundEffect ?? pickedSound;
                        // Already done when every arrival carries this sound,
                        // and there is at least one to carry it. Otherwise the
                        // button is an action rather than a state.
                        const applied = !!inHand
                          && transitionArrivals.length > 0
                          && transitionArrivals.every((b) => b.soundEffect === inHand);
                        return (
                          <button
                            type="button"
                            onClick={() => applySoundToAll(
                              inHand,
                              editingBeat
                                ? { volume: editingBeat.soundVolume ?? 1, pitch: editingBeat.soundPitch ?? 1 }
                                : shapeOf(pickedSound),
                            )}
                            disabled={assembling || applyingSound || !inHand}
                            title={transitionArrivals.length === 0
                              ? "No cuts have a transition yet"
                              : applied
                                ? `Already on all ${transitionArrivals.length} transitions`
                                : `Put this sound on ${transitionArrivals.length} beats that arrive through a transition`}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all disabled:opacity-40 flex items-center gap-1"
                            style={applied ? {
                              background: "oklch(0.72 0.25 285 / 0.18)",
                              border: "1px solid oklch(0.72 0.25 285 / 0.45)",
                              color: "var(--accent-purple-text)",
                            } : {
                              background: "var(--bg-input)",
                              border: "1px solid var(--bd-card)",
                              color: "var(--c-60)",
                            }}
                          >
                            {applied && <Check size={12} />}
                            {applyingSound ? "Applying…" : "Apply to all transitions"}
                          </button>
                        );
                      })()}
                      <button
                        type="button"
                        onClick={() => applySoundToAll(null)}
                        disabled={assembling || applyingSound || !beats.some((b) => b.soundEffect)}
                        title="Take the sounds off every beat"
                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all disabled:opacity-40"
                        style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
                      >
                        Clear all
                      </button>
                    </div>
                  </div>
                  <LibraryTabs value={libTab} onChange={setLibTab} customCount={customSounds.length} />
                  {libTab === "all" ? (
                  <div className="min-w-0 grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
                    {/* placed-sound editor renders above; tiles follow */}
                    {soundLibrary.map(renderSoundTile)}
                  </div>
                  ) : (
                    <CustomAssetPane
                      kind="sound"
                      assets={customSounds}
                      canUpload={canUploadAssets}
                      busy={assetBusy}
                      error={assetError}
                      onFiles={(f) => uploadCustomAssets("sound", f)}
                      onUpgrade={() => openUpgrade("heclus_max")}
                    >
                      {/* The library's own tile, so an upload auditions on
                          click and drags onto the timeline like any other. */}
                      <div className="min-w-0 grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
                        {customSounds.map((a) => (
                          <div key={a.id} className="relative">
                            {renderSoundTile({ id: customRef(a.id), label: a.name })}
                            <RemoveAssetButton name={a.name} onRemove={() => deleteCustomAsset(a.id)} />
                          </div>
                        ))}
                      </div>
                    </CustomAssetPane>
                  )}
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
                  {(() => {
                    // Whatever is in hand: the selected beat's sound, or the
                    // one just clicked. Tuning belongs to the sound, so it is
                    // here either way — with a beat selected it writes to that
                    // beat, without one it waits for Apply to all.
                    const sound = editingBeat?.soundEffect ?? pickedSound;
                    if (!sound) return null;
                    const onBeat = !!editingBeat?.soundEffect;
                    const own = shapeOf(sound);
                    // Beats already carrying this sound. With any, the panel is
                    // about them; with none it is a draft waiting to be applied.
                    const applied = beats.filter((b) => b.soundEffect === sound);
    const live = !onBeat && applied.length > 0;
                    // One number for all of them only if they agree; otherwise
                    // the panel says so rather than picking one at random.
                    const sameVolume = applied.every((b) => (b.soundVolume ?? 1) === (applied[0]?.soundVolume ?? 1));
                    const samePitch = applied.every((b) => (b.soundPitch ?? 1) === (applied[0]?.soundPitch ?? 1));
                    const volume = onBeat ? (editingBeat!.soundVolume ?? 1)
                      : live ? (applied[0].soundVolume ?? 1) : own.volume;
                    const pitch = onBeat ? (editingBeat!.soundPitch ?? 1)
                      : live ? (applied[0].soundPitch ?? 1) : own.pitch;
                    const setVolume = (v: number) => onBeat
                      ? setBeatSound(editingBeat!.beatNumber, sound, { volume: v })
                      : live ? tuneEverywhere(sound, { volume: v }) : tuneSound(sound, { volume: v });
                    const setPitch = (v: number) => onBeat
                      ? setBeatSound(editingBeat!.beatNumber, sound, { pitch: v })
                      : live ? tuneEverywhere(sound, { pitch: v }) : tuneSound(sound, { pitch: v });
                    const label = soundLibrary.find((x) => x.id === sound)?.label ?? sound;
                    return (
                      <div className="mt-3 space-y-2 rounded-xl px-3 py-2.5"
                        style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}>
                        {/* Level and pitch beside each other: two short rows
                            stacked left a panel taller than it needed to be. */}
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold" style={{ color: "var(--accent-purple-text)" }}>
                            {label}
                            <span className="font-normal" style={{ color: "var(--c-40)" }}>
                              {onBeat
                                ? ` · beat ${editingBeat!.beatNumber}`
                                : applied.length
                                  ? ` · ${applied.length} beats${sameVolume && samePitch ? "" : ", mixed"}`
                                  : " · not applied yet"}
                            </span>
                          </p>
                          <button
                            type="button"
                            // No audition floor here: this button exists to
                            // judge the level, and a floor that quietly lifts
                            // anything under half made the volume slider look
                            // like it did nothing.
                            onClick={() => playSound(sound, volume, pitch)}
                            title="Play it as tuned"
                            aria-label="Play it as tuned"
                            className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-opacity hover:opacity-85"
                            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
                          >
                            <Play size={12} className="ml-[1px]" />
                          </button>
                        </div>
                        {/* Label, slider and value on one line each: two rows
                            rather than six, which is what this panel is worth
                            in a column sized to the preview. */}
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                          {([
                            ["Volume", volume, 0, 2, 0.05, setVolume, `${Math.round(volume * 100)}%`],
                            ["Pitch", pitch, 0.5, 2, 0.05, setPitch, `${pitch.toFixed(2)}×`],
                          ] as [string, number, number, number, number, (v: number) => void, string][]).map(
                            ([label, value, min, max, step, onSet, shown]) => (
                              <div key={label} className="flex items-center gap-2 flex-1 min-w-0">
                                <span className="shrink-0 text-[11px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                                  {label}
                                </span>
                                <input
                                  type="range" min={min} max={max} step={step}
                                  value={value}
                                  disabled={assembling}
                                  onChange={(e) => onSet(Number(e.target.value))}
                                  className="flex-1 min-w-0 accent-[oklch(0.72_0.25_285)] disabled:opacity-40"
                                />
                                <span className="shrink-0 text-[11px] font-mono tabular-nums" style={{ color: "var(--c-55)" }}>
                                  {shown}
                                </span>
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  <div className="flex items-center gap-2 mt-4 pt-3" style={{ borderTop: "1px solid var(--bd-6)" }}>
                    <span className="shrink-0 text-[11px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                      Master
                    </span>
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={sfxVolume}
                      disabled={assembling}
                      onChange={(e) => setSfxVolume(Number(e.target.value))}
                      className="flex-1 min-w-0 accent-[oklch(0.72_0.25_285)] disabled:opacity-40"
                    />
                    <span className="shrink-0 text-[11px] font-mono tabular-nums" style={{ color: "var(--c-55)" }}>
                      {Math.round(sfxVolume * 100)}%
                    </span>
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
                        <button key={f.id}
                          onClick={() => {
                            setVideoFilter(f.id);
                            setVideoFilterStrength(filterStrengths[f.id] ?? 1);
                          }}
                          disabled={assembling}
                          className="text-left transition-all disabled:opacity-40">
                          <span className="block relative w-full aspect-video rounded-lg overflow-hidden"
                            style={{
                              background: "var(--bg-input)",
                              border: `1px solid ${active ? "oklch(0.72 0.25 285)" : "var(--bd-card)"}`,
                              boxShadow: active ? "0 0 0 2px oklch(0.72 0.25 285 / 0.25)" : "none",
                            }}>
                            {tileUrl ? (
                              <>
                                <TileFrame url={tileUrl} isClip={tileIsClip}
                                  className="absolute inset-0 w-full h-full object-cover"
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
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setVideoFilterStrength(v);
                            setFilterStrengths((cur) => ({ ...cur, [videoFilter]: v }));
                          }}
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
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-xs" style={{ color: "var(--c-45)" }}>
                      {editingBeat
                        ? <>The cut after <span style={{ color: "var(--accent-purple-text)" }}>beat {editingBeat.beatNumber}</span></>
                        : mixedCuts ? null : "Every cut between beats"}
                    </p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {editingBeat?.transition && (
                        <button type="button" onClick={() => setBeatTransition(editingBeat.beatNumber, null)}
                          disabled={assembling}
                          className="text-xs underline underline-offset-2 disabled:opacity-40 mr-1" style={{ color: "var(--c-50)" }}>
                          Follow project
                        </button>
                      )}
                      {(() => {
                        const mixed = beats.some((b) => b.transition);
                        const on = {
                          background: "oklch(0.72 0.25 285 / 0.18)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.45)",
                          color: "var(--accent-purple-text)",
                        };
                        const off = {
                          background: "var(--bg-input)",
                          border: "1px solid var(--bd-card)",
                          color: "var(--c-60)",
                        };
                        return (
                          <>
                            <button
                              type="button"
                              onClick={() => applyTransitionToAll(editingTransition)}
                              disabled={assembling}
                              title="Put this transition on every cut, clearing any set one at a time"
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all disabled:opacity-40"
                              style={mixed ? off : on}
                            >
                              Apply to all
                            </button>
                            <button
                              type="button"
                              onClick={randomizeTransitions}
                              disabled={assembling || shuffling}
                              title="A different transition at each cut, written down so it stays the same next time"
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all disabled:opacity-40"
                              style={mixed ? on : off}
                            >
                              {shuffling ? "Shuffling…" : "Randomize"}
                            </button>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="min-w-0 grid grid-cols-3 lg:grid-cols-4 gap-2">
                    {TRANSITIONS.map((tr) => {
                      const active = editingTransition === tr.id;
                      const anim = SEAM_ANIMATION[tr.id];
                      return (
                        <button key={tr.id}
                          onClick={() => {
                            const remembered = transitionLengths[tr.id];
                            if (remembered) setTransitionSeconds(remembered);
                            if (editingBeat) setBeatTransition(editingBeat.beatNumber, tr.id);
                            // Randomize writes a value onto every cut, and a cut's
                            // own beats the project's, so setting the project one
                            // alone would pick a transition and change nothing.
                            else if (mixedCuts) void applyTransitionToAll(tr.id);
                            else setTransition(tr.id);
                          }}
                          disabled={assembling}
                          title={tr.hint}
                          className="text-left transition-all disabled:opacity-40">
                          <span className="block relative w-full aspect-video rounded-lg overflow-hidden"
                            style={{
                              background: "var(--bg-input)",
                              border: `1px solid ${active ? "oklch(0.72 0.25 285)" : "var(--bd-card)"}`,
                              boxShadow: active ? "0 0 0 2px oklch(0.72 0.25 285 / 0.25)" : "none",
                            }}>
                            {tileUrl && nextPreviewUrl && (
                              <>
                                {/* The incoming shot underneath, the outgoing
                                    one over it doing whatever it does to
                                    leave. A cut has nothing to animate, so it
                                    shows the two halves meeting instead. */}
                                <TileFrame url={nextPreviewUrl} isClip={nextIsClip}
                                  className="absolute inset-0 w-full h-full object-cover"
                                  style={tr.id === "none" ? { clipPath: "inset(0 0 0 50%)" } : undefined} />
                                <TileFrame url={tileUrl} isClip={tileIsClip}
                                  className="absolute inset-0 w-full h-full object-cover"
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
                  {editingTransition !== "none" && (
                    <div className="mt-4">
                      <p className="text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--c-40)" }}>
                        Duration{editingBeat ? " · every cut" : ""}
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={0.2}
                          max={1.5}
                          step={0.1}
                          value={transitionSeconds}
                          disabled={assembling}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setTransitionSeconds(v);
                            setTransitionLengths((cur) => ({ ...cur, [editingTransition]: v }));
                          }}
                          className="flex-1 min-w-0 accent-[oklch(0.72_0.25_285)] disabled:opacity-40"
                        />
                        <span className="shrink-0 px-2 py-1 rounded-lg text-[11px] font-mono tabular-nums"
                          style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-65)" }}>
                          {transitionSeconds.toFixed(1)}s
                        </span>
                      </div>
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
                        onClick={() => {
                          const remembered = motionShapes[m.id];
                          if (remembered) {
                            setImageMotionStrength(remembered.strength);
                            setImageMotionSeconds(remembered.seconds);
                          }
                          if (editingBeat) setBeatMotion(editingBeat.beatNumber, m.id);
                          else setImageMotion(m.id);
                        }}
                        disabled={assembling}
                        title={m.hint}
                        className="group text-left transition-all disabled:opacity-40 flex flex-col">
                        <span
                          className="block relative w-full aspect-video rounded-lg overflow-hidden"
                          style={{
                            background: "var(--bg-input)",
                            border: `1px solid ${active ? "oklch(0.72 0.25 285)" : "var(--bd-card)"}`,
                            boxShadow: active ? "0 0 0 2px oklch(0.72 0.25 285 / 0.25)" : "none",
                          }}
                        >
                          {m.id === "none" || !tileUrl ? (
                            <span className="absolute inset-0 flex items-center justify-center" style={{ color: "var(--c-32)" }}>
                              <Ban size={16} />
                            </span>
                          ) : (
                            <TileFrame
                              url={tileUrl}
                              isClip={tileIsClip}
                              frameKey={m.id === "random" ? `r${randomPreviewStep}` : m.id}
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
                        {/* Fixed height under every tile. Two of these carry a
                            second line and the rest do not, and without a floor
                            the labels sat at different heights across the row. */}
                        <span className="block mt-1 min-h-[2.1rem]">
                          <span className="block text-[11px] truncate"
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
                        </span>
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
                        <button key={x.id}
                        onClick={() => {
                          setImageMotionStrength(x.id);
                          setMotionShapes((cur) => ({ ...cur, [editingMotion]: { strength: x.id, seconds: imageMotionSeconds } }));
                        }}
                        disabled={assembling}
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
                        onChange={(e) => {
                        const v = Number(e.target.value);
                        setImageMotionSeconds(v);
                        setMotionShapes((cur) => ({ ...cur, [editingMotion]: { strength: imageMotionStrength, seconds: v } }));
                      }}
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
                    disabled={playable.length === 0 || timelineLocked}
                    title={finalMode ? "Press Edit to work on the video" : playable.length === 0 ? "No voiceover generated yet" : playing ? "Pause" : "Play the narration"}
                    aria-label={playing ? "Pause" : "Play"}
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-opacity hover:opacity-85 disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
                  >
                    {playing ? <Pause size={13} /> : <Play size={13} className="ml-[1px]" />}
                  </button>
                  <span className="text-xs font-mono tabular-nums whitespace-nowrap" style={{ color: "var(--c-60)" }}>
                    {fmtClock(playhead)}
                    <span style={{ color: "var(--c-32)" }}> / {fmtClock(timelineTotal)}</span>
                  </span>
                  {timelineLocked && (
                    <span className="text-[11px] whitespace-nowrap" style={{ color: "var(--c-38)" }}>
                      {assembling ? "rendering…" : "final · press Edit to change it"}
                    </span>
                  )}
                  {/* Playback is the narration, and only the beats that have
                      one. Without this the audio stopped a minute into a
                      thirteen-minute strip and looked broken. */}
                  {playable.length < beats.length && (
                    <span className="text-[11px] whitespace-nowrap hidden sm:inline" style={{ color: "var(--c-38)" }}>
                      narration for {playable.length}/{beats.length}
                    </span>
                  )}
                </div>

                {/* Zoom, the way an editor does it: out to see the shape of
                    the whole video, in to work on one beat. */}
                <div className="flex items-center gap-2 justify-self-end">
                  {!timelineLocked && (
                    <span className="text-xs hidden lg:inline" style={{ color: "var(--c-38)" }}>Drag the ruler to scrub</span>
                  )}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPxPerSecond(ZOOM_STEPS[Math.max(0, zoomStep - 1)])}
                      disabled={zoomStep === 0 || timelineLocked}
                      aria-label="Zoom out"
                      className="w-6 h-6 rounded-md text-xs font-semibold transition-opacity hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
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
                      disabled={timelineLocked}
                      aria-label="Timeline zoom"
                      className="hidden sm:block w-20 accent-[oklch(0.72_0.25_285)] disabled:opacity-40 disabled:cursor-not-allowed"
                    />
                    <button
                      type="button"
                      onClick={() => setPxPerSecond(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, zoomStep + 1)])}
                      disabled={zoomStep === ZOOM_STEPS.length - 1 || timelineLocked}
                      aria-label="Zoom in"
                      className="w-6 h-6 rounded-md text-xs font-semibold transition-opacity hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={fitTimeline}
                      disabled={timelineLocked}
                      title={timelineLocked ? (assembling ? "Rendering…" : "Press Edit to work on the video") : "Compress the whole video into the width available"}
                      className="h-6 px-2 rounded-md text-[11px] font-medium transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
                    >
                      Fit
                    </button>
                  </div>
                </div>
              </div>

              <div
                ref={timelineViewportRef}
                className={`overflow-auto rounded-xl px-2 pt-1 pb-2 ${timelineLocked ? "cursor-not-allowed select-none" : ""}`}
                onPointerDownCapture={timelineLocked ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
                onClickCapture={timelineLocked ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
                style={{
                  background: "oklch(1 0 0 / 0.11)",
                  border: "1px solid oklch(1 0 0 / 0.13)",
                  opacity: timelineLocked ? 0.55 : 1,
                  // Text, elements, clips and sound stacked can run past a
                  // screen, and a timeline you have to scroll the page to see
                  // the end of is not a timeline. It scrolls inside itself now,
                  // both ways, and the ruler goes with it: a fixed header would
                  // need the rows to scroll in a separate box, which then has
                  // to be kept in step horizontally with the header.
                  maxHeight: "min(calc(50vh - 80px), 340px)",
                }}
              >
                <div ref={timelineStripRef} style={{ width: stripWidth }}>
                  {/* Ruler. Every five seconds, which keeps a ten-minute video
                      readable without a mark per second. Drag it to scrub:
                      the ticks say what this is, the dragging proves it. */}
                  <div
                    className="relative h-5 mb-1 cursor-ew-resize select-none"
                    style={{ borderBottom: "1px solid var(--bd-10)" }}
                    onPointerDown={(e) => {
                      const strip = e.currentTarget;
                      const scrub = (clientX: number, commit: boolean) => {
                        const rect = strip.getBoundingClientRect();
                        seekTo((clientX - rect.left) / pxPerSecond, commit);
                      };
                      scrub(e.clientX, false);
                      const move = (ev: PointerEvent) => scrub(ev.clientX, false);
                      const up = (ev: PointerEvent) => {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                        scrub(ev.clientX, true);
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

                  {/* Elements and text sit above the clips, not below them.
                      They are drawn over the picture, so the track order now
                      matches the stacking order: what is on top on screen is
                      on top here. */}
                  {/* Text on its own tracks, above the elements. Same block,
                      same drag, because retiming a line and retiming a button
                      are the same gesture. */}
                  {projectTexts.length > 0 && (
                    <div ref={textRowsRef} className="relative mt-[3px]" style={{ height: textLaneCount * LANE_H - 3 }}>
                      {Array.from({ length: textLaneCount }, (_, i) => (
                        <div key={i} className="absolute inset-x-0 rounded-md"
                          style={{
                            top: i * LANE_H, height: LANE_H - 3,
                            background: "oklch(0.75 0.17 60 / 0.06)",
                            borderLeft: "2px solid oklch(0.75 0.17 60 / 0.45)",
                            // Hatched like the sound tracks, but leaning the
                            // other way. Same angle in both would make the two
                            // sections read as one long striped band.
                            backgroundImage:
                              "repeating-linear-gradient(-45deg, oklch(0.75 0.17 60 / 0.08) 0 6px, transparent 6px 12px)",
                          }} />
                      ))}
                      {projectTexts.map((t) => {
                        const left = t.start_sec * pxPerSecond;
                        const width = Math.max(12, (t.end_sec - t.start_sec) * pxPerSecond);
                        const picked = selectedText === t.id;
                        const drag = (mode: "move" | "start" | "end") => (ev: React.PointerEvent) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          setSelectedText(t.id);
                          if (assembling) return;
                          const originX = ev.clientX;
                          const originY = ev.clientY;
                          const from = t.start_sec;
                          const to = t.end_sec;
                          const lane0 = t.lane ?? 0;
                          const at = (m: PointerEvent) => {
                            const delta = (m.clientX - originX) / pxPerSecond;
                            if (mode === "move") {
                              const span = to - from;
                              const start = Math.max(0, Math.min(timelineTotal - span, from + delta));
                              // Vertical movement changes the track, so one
                              // gesture both retimes and restacks.
                              const lane = Math.max(0, Math.min(9, lane0 + Math.round((m.clientY - originY) / LANE_H)));
                              return { start_sec: start, end_sec: start + span, lane };
                            }
                            if (mode === "start") {
                              // Never past its own end: a block dragged inside
                              // out is rejected by the table anyway.
                              return { start_sec: Math.max(0, Math.min(to - 0.3, from + delta)) };
                            }
                            return { end_sec: Math.max(from + 0.3, Math.min(timelineTotal, to + delta)) };
                          };
                          const move = (m: PointerEvent) => updateText(t.id, at(m), false);
                          const up = (m: PointerEvent) => {
                            window.removeEventListener("pointermove", move);
                            window.removeEventListener("pointerup", up);
                            updateText(t.id, at(m));
                          };
                          window.addEventListener("pointermove", move);
                          window.addEventListener("pointerup", up);
                        };
                        return (
                          <div
                            key={t.id}
                            className="absolute flex items-center gap-1 px-1.5 rounded-md touch-none cursor-grab overflow-hidden"
                            style={{
                              left, width,
                              top: (t.lane ?? 0) * LANE_H,
                              height: LANE_H - 3,
                              // Orange for words, green for sound, purple for
                              // the elements: the track a block is on says what
                              // kind of thing it is before its label is read.
                              background: picked ? "oklch(0.72 0.18 60 / 0.34)" : "oklch(0.72 0.18 60 / 0.18)",
                              border: `1px solid ${picked ? "oklch(0.75 0.17 60)" : "oklch(0.75 0.17 60 / 0.45)"}`,
                            }}
                            onPointerDown={drag("move")}
                          >
                            <span className="text-[10px] truncate pointer-events-none" style={{ color: "var(--c-70)" }}>
                              {t.content}
                            </span>
                            {/* Trim handles, wide enough to hit at any zoom. */}
                            <span onPointerDown={drag("start")}
                              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize touch-none" />
                            <span onPointerDown={drag("end")}
                              className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize touch-none" />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* Elements, on their own tracks below the text: they are
                      pictures over the video, so they belong nearer it than the
                      sound does. Each block is draggable along the strip and
                      trimmable at either end. */}
                  {projectElements.length > 0 && (
                    <div ref={elementRowsRef} className="relative mt-[3px]" style={{ height: elementLaneCount * LANE_H - 3 }}>
                      {/* One faint row per track, so an empty one still reads
                          as somewhere a block can be dropped. */}
                      {Array.from({ length: elementLaneCount }, (_, i) => (
                        <div key={i} className="absolute inset-x-0 rounded-md"
                          style={{
                            top: i * LANE_H, height: LANE_H - 3,
                            background: "oklch(0.72 0.25 285 / 0.05)",
                            borderLeft: "2px solid oklch(0.72 0.25 285 / 0.4)",
                          }} />
                      ))}
                      {projectElements.map((el) => {
                        const left = el.start_sec * pxPerSecond;
                        const width = Math.max(12, (el.end_sec - el.start_sec) * pxPerSecond);
                        const picked = selectedElement === el.id;
                        const drag = (mode: "move" | "start" | "end") => (ev: React.PointerEvent) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          setSelectedElement(el.id);
                          if (assembling) return;
                          const originX = ev.clientX;
                          const originY = ev.clientY;
                          const from = el.start_sec;
                          const to = el.end_sec;
                          const lane0 = el.lane ?? 0;
                          const at = (m: PointerEvent) => {
                            const delta = (m.clientX - originX) / pxPerSecond;
                            if (mode === "move") {
                              const span = to - from;
                              const start = Math.max(0, Math.min(timelineTotal - span, from + delta));
                              // Vertical movement changes the track, so one
                              // gesture both retimes and restacks.
                              const lane = Math.max(0, Math.min(9, lane0 + Math.round((m.clientY - originY) / LANE_H)));
                              return { start_sec: start, end_sec: start + span, lane };
                            }
                            if (mode === "start") {
                              const start = Math.max(0, Math.min(to - 0.3, from + delta));
                              return { start_sec: start, end_sec: to };
                            }
                            const end = Math.max(from + 0.3, Math.min(timelineTotal, to + delta));
                            return { start_sec: from, end_sec: end };
                          };
                          const move = (m: PointerEvent) => updateElement(el.id, at(m), false);
                          const up = (m: PointerEvent) => {
                            window.removeEventListener("pointermove", move);
                            window.removeEventListener("pointerup", up);
                            updateElement(el.id, at(m));
                          };
                          window.addEventListener("pointermove", move);
                          window.addEventListener("pointerup", up);
                        };
                        return (
                          <div
                            key={el.id}
                            onPointerDown={drag("move")}
                            title={`${elementLibrary.find((x) => x.id === el.element)?.label ?? el.element} · ${fmtClock(el.start_sec)} to ${fmtClock(el.end_sec)}`}
                            className="absolute h-8 rounded-md flex items-center gap-1.5 px-2 cursor-grab touch-none overflow-hidden"
                            style={{
                              left, width,
                              // Its own row when it overlaps another: two blocks
                              // on one line would hide each other, and stacking
                              // is what "layers" means on a timeline.
                              top: (el.lane ?? 0) * LANE_H,
                              background: picked ? "oklch(0.72 0.25 285 / 0.3)" : "oklch(0.72 0.25 285 / 0.16)",
                              border: `1px solid ${picked ? "oklch(0.72 0.25 285)" : "oklch(0.72 0.25 285 / 0.4)"}`,
                            }}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={elementSrc(el.element)} alt="" className="h-4 w-auto shrink-0 pointer-events-none" />
                            <span className="text-[10px] truncate pointer-events-none" style={{ color: "var(--c-70)" }}>
                              {elementLibrary.find((x) => x.id === el.element)?.label ?? el.element}
                            </span>
                            {/* Trim handles, wide enough to hit at any zoom. */}
                            <span onPointerDown={drag("start")}
                              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize touch-none"
                              style={{ background: "oklch(0.72 0.25 285 / 0.6)" }} />
                            <span onPointerDown={drag("end")}
                              className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize touch-none"
                              style={{ background: "oklch(0.72 0.25 285 / 0.6)" }} />
                            {/* Remove, on the block itself. Shown on the
                                selected one and on hover, because a × on every
                                block at once is a row of noise. Delete works
                                too, once one is selected. */}
                            {width > 44 && (
                              <button
                                type="button"
                                onPointerDown={(ev) => ev.stopPropagation()}
                                onClick={(ev) => { ev.stopPropagation(); void removeElement(el.id); }}
                                title="Remove this element"
                                aria-label="Remove this element"
                                className={`absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full flex items-center justify-center transition-opacity ${picked ? "" : "opacity-0 hover:opacity-100"}`}
                                style={{ background: "oklch(0 0 0 / 0.65)", color: "white" }}
                              >
                                <X size={9} strokeWidth={3} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
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
                            width: beatTileWidth(b),
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
                          {/* Its own transition, marked at the edge where that
                              cut happens. */}
                          {b.transition && (
                            <span className="absolute top-0 bottom-0 right-0 w-[3px]"
                              style={{ background: "oklch(0.62 0.15 60)" }} />
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

                  {/* Placed sounds, under the text. A moment rather than a
                      span: a sound has a length of its own that the timeline
                      does not get to change, so the block is a marker and only
                      moves sideways. */}
                  {projectSounds.length > 0 && (
                    <div ref={soundRowsRef} className="relative mt-[3px]" style={{ height: soundLaneCount * LANE_H - 3 }}>
                      {Array.from({ length: soundLaneCount }, (_, i) => (
                        <div key={i} className="absolute inset-x-0 rounded-md"
                          style={{
                            top: i * LANE_H, height: LANE_H - 3,
                            background: "oklch(0.65 0.15 145 / 0.05)",
                            borderLeft: "2px solid oklch(0.65 0.15 145 / 0.5)",
                            // Hatched, so an audio track is not mistaken for a
                            // picture track at a glance. The stripes are faint
                            // enough to read under a block sitting on them.
                            backgroundImage:
                              "repeating-linear-gradient(45deg, oklch(0.65 0.15 145 / 0.07) 0 6px, transparent 6px 12px)",
                          }} />
                      ))}
                      {projectSounds.map((snd) => {
                        const picked = selectedSound === snd.id;
                        const natural = secondsFor(snd.sound);
                        const plays = snd.duration_sec ?? natural;
                        // Drawn at what it plays for, with a floor so a 78ms
                        // tick is still something you can grab.
                        const width = Math.max(28, plays * pxPerSecond);
                        return (
                          <div
                            key={snd.id}
                            data-overlay={snd.id}
                            className="absolute flex items-center gap-1 px-1.5 rounded-md touch-none cursor-grab overflow-hidden"
                            style={{
                              left: snd.at_sec * pxPerSecond,
                              width,
                              top: (snd.lane ?? 0) * LANE_H,
                              height: LANE_H - 3,
                              background: picked ? "oklch(0.65 0.15 145 / 0.3)" : "oklch(0.65 0.15 145 / 0.16)",
                              border: `1px solid ${picked ? "oklch(0.65 0.15 145)" : "oklch(0.65 0.15 145 / 0.4)"}`,
                            }}
                            onPointerDown={(ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              setSelectedSound(snd.id);
                              if (assembling) return;
                              const originX = ev.clientX;
                              const originY = ev.clientY;
                              const from = snd.at_sec;
                              const lane0 = snd.lane ?? 0;
                              const at = (m: PointerEvent) => ({
                                at_sec: Math.max(0, Math.min(timelineTotal, from + (m.clientX - originX) / pxPerSecond)),
                                lane: Math.max(0, Math.min(9, lane0 + Math.round((m.clientY - originY) / LANE_H))),
                              });
                              const move = (m: PointerEvent) => updateSound(snd.id, at(m), false);
                              const up = (m: PointerEvent) => {
                                window.removeEventListener("pointermove", move);
                                window.removeEventListener("pointerup", up);
                                updateSound(snd.id, at(m));
                              };
                              window.addEventListener("pointermove", move);
                              window.addEventListener("pointerup", up);
                            }}
                          >
                            <Volume2 size={10} className="shrink-0 pointer-events-none" style={{ color: "oklch(0.75 0.15 145)" }} />
                            <span className="text-[10px] truncate pointer-events-none" style={{ color: "var(--c-70)" }}>
                              {soundLibrary.find((x) => x.id === snd.sound)?.label ?? snd.sound}
                            </span>
                            {picked && !assembling && (
                              <>
                                {/* The right edge sets how long it plays for.
                                    In from the file's own length is a trim; out
                                    past it is a stretch, which the worker does
                                    with atempo so a longer sound is not also a
                                    lower one. Four times is where slowing an
                                    effect stops sounding like the effect.
                                    Double-click restores the file's length. */}
                                <span
                                  onPointerDown={(ev) => {
                                    ev.preventDefault();
                                    ev.stopPropagation();
                                    const originX = ev.clientX;
                                    const at = (m: PointerEvent) => Math.max(0.05, Math.min(Math.min(30, natural * 4),
                                      plays + (m.clientX - originX) / pxPerSecond));
                                    const move = (m: PointerEvent) => updateSound(snd.id, { duration_sec: at(m) }, false);
                                    const up = (m: PointerEvent) => {
                                      window.removeEventListener("pointermove", move);
                                      window.removeEventListener("pointerup", up);
                                      // Back to null at full length, so a
                                      // regenerated sound gets its new length
                                      // rather than yesterday's number.
                                      // Null only at exactly the file's own
                                      // length, so a regenerated sound gets its
                                      // new length rather than yesterday's.
                                      const v = at(m);
                                      updateSound(snd.id, { duration_sec: Math.abs(v - natural) < 0.02 ? null : v });
                                    };
                                    window.addEventListener("pointermove", move);
                                    window.addEventListener("pointerup", up);
                                  }}
                                  onDoubleClick={(ev) => { ev.stopPropagation(); updateSound(snd.id, { duration_sec: null }); }}
                                  title="Drag to change how long it plays"
                                  className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize touch-none"
                                  style={{ background: "oklch(0.65 0.15 145 / 0.7)" }}
                                />
                                <button
                                  type="button"
                                  aria-label="Remove this sound"
                                  onPointerDown={(ev) => { ev.preventDefault(); ev.stopPropagation(); }}
                                  onClick={(ev) => { ev.stopPropagation(); void removeSound(snd.id); }}
                                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center cursor-pointer"
                                  style={{ background: "oklch(0.58 0.22 25)", border: "2px solid white", color: "white" }}
                                >
                                  <X size={8} strokeWidth={4} />
                                </button>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* The audio, stacked below the video the way an editor
                      stacks it. Two tracks because there are two things making
                      sound, and each says whether it is in the render. */}
                  <div className="mt-[3px] space-y-[3px]">
                    <div className="relative rounded-md flex items-center" data-track="audio"
                      style={{ height: 26, background: "oklch(0.55 0.15 145 / 0.18)", border: "1px solid oklch(0.55 0.15 145 / 0.35)" }}>
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
                      <span className="text-[10px] font-medium leading-none whitespace-nowrap" style={{ color: "oklch(0.62 0.13 145)" }}>
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

                    <div className="relative rounded-md flex items-center" data-track="audio"
                      style={{
                        height: 26,
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
                      <span className="text-[10px] font-medium leading-none whitespace-nowrap"
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
              {showPreview && previewLoadError && (
                <div
                  className="w-full rounded-xl p-5 text-center space-y-1"
                  style={{ background: "var(--bg-page-2)", border: "1px solid var(--bd-card)" }}
                >
                  <p className="text-sm font-medium" style={{ color: "var(--c-78)" }}>
                    Preview unavailable
                  </p>
                  <p className="text-xs" style={{ color: "var(--c-50)" }}>
                    The cached render may have expired. Render again to rebuild it.
                  </p>
                </div>
              )}


              {showPreview && previewUrl && (
                <div className="mx-auto" style={{ maxWidth: previewMaxW }}>
                  <button
                    onClick={() => router.push(`/projects/${projectId}/thumbnails`)}
                    disabled={previewLoadError}
                    title={previewLoadError ? "Render the video again before continuing — the cached render can't be loaded." : undefined}
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
                    <button onClick={() => setExportConfirmOpen(true)} disabled={!hasVoiceover || assembling}
                      className={`${reassembleMode ? "flex-1" : "w-full"} py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all`}
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                      {assembling ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Queuing…
                        </span>
                      ) : showPreview ? "Re-render" : "Render"}
                    </button>
                  </div>
                </>
              )}
            </div>

          </div>{/* end left column */}

        </div>
      </main>

      <Dialog open={editConfirmOpen} onOpenChange={setEditConfirmOpen}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Go back to editing?</DialogTitle>
            <DialogDescription>
              Changes only reach the video when you render again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setEditConfirmOpen(false)}
              className="px-4 py-2 rounded-xl text-sm font-medium"
              style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
            >
              Keep watching
            </button>
            <button
              onClick={() => { setEditConfirmOpen(false); setShowFinished(false); setRenderStale(true); }}
              className="px-4 py-2 rounded-xl text-sm font-semibold"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              Edit
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={exportConfirmOpen} onOpenChange={(open) => { if (!assembling) setExportConfirmOpen(open); }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Render this video?</DialogTitle>
            <DialogDescription>
              {beats.length} beats, {timelineTotal ? fmtClock(timelineTotal) : "unknown length"}, at{" "}
              {dimsFor(aspectRatio, selectedResolution).label}. Rendering takes a few minutes and costs credits.
            </DialogDescription>
          </DialogHeader>
          <div className="text-xs space-y-1" style={{ color: "var(--c-55)" }}>
            <p>
              {imageMotion === "none" ? "No movement" : `${IMAGE_MOTIONS.find((m) => m.id === imageMotion)?.label} effect`}
              {" · "}
              {transition === "none" ? "hard cuts" : `${TRANSITIONS.find((t) => t.id === transition)?.label.toLowerCase()} transitions`}
              {videoFilter === "none" ? "" : ` · ${VIDEO_FILTERS.find((f) => f.id === videoFilter)?.label.toLowerCase()} grade`}
            </p>
            <p>
              {captionsEnabled ? `Captions on · ${captionsStyle}` : "No captions"}
              {projectElements.length ? ` · ${projectElements.length} element${projectElements.length === 1 ? "" : "s"}` : ""}
              {projectTexts.length ? ` · ${projectTexts.length} text${projectTexts.length === 1 ? "" : "s"}` : ""}
              {projectSounds.length ? ` · ${projectSounds.length} placed sound${projectSounds.length === 1 ? "" : "s"}` : ""}
              {beats.some((b) => b.soundEffect) ? ` · ${beats.filter((b) => b.soundEffect).length} sound${beats.filter((b) => b.soundEffect).length === 1 ? "" : "s"}` : ""}
            </p>
          </div>
          <DialogFooter>
            <button
              onClick={() => setExportConfirmOpen(false)}
              disabled={assembling}
              className="px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-40"
              style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
            >
              Cancel
            </button>
            <button
              onClick={() => { setExportConfirmOpen(false); setShowFinished(true); void assembleVideo(); }}
              disabled={assembling || !hasVoiceover}
              className="px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-40"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              {assembling ? "Starting…" : "Render"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* The placed-sound controls, floating over everything.
          Portalled to the body and positioned in viewport coordinates, so no
          ancestor's transform or overflow can clip it and it can be parked
          anywhere on screen rather than inside the timeline it belongs to. */}
      {typeof document !== "undefined" && selectedSound && soundPanelPos && (() => {
        const snd = projectSounds.find((x) => x.id === selectedSound);
        if (!snd) return null;
        return createPortal(
          <div
            data-overlay-keep
            className="fixed rounded-xl px-3 py-2.5 space-y-2"
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              left: soundPanelPos.x,
              top: soundPanelPos.y,
              width: PLACED_PANEL_W,
              zIndex: 60,
              background: "var(--bg-card)",
              border: "1px solid oklch(0.65 0.15 145 / 0.5)",
              boxShadow: "0 8px 24px oklch(0 0 0 / 0.35)",
            }}
          >
            {renderPlacedSoundControls(snd)}
          </div>,
          document.body,
        );
      })()}

      {showUpgradeModal && (
        <SubscriptionModal
          email={userEmail}
          defaultPlan={upgradePlan}
          hideTryDemo
          onClose={() => setShowUpgradeModal(false)}
          onSuccess={() => setShowUpgradeModal(false)}
        />
      )}
    </div>
  );
}
