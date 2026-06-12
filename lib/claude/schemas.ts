import { z } from "zod";

// Claude occasionally returns array fields as a comma/newline-separated string
// or an object with numeric keys. Normalise to string[] before validation.
function coerceStringArray(val: unknown): unknown {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON */ }
    return val.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (val && typeof val === "object") {
    return Object.values(val);
  }
  return val;
}

const stringArray = z.preprocess(coerceStringArray, z.array(z.string()));

export const StyleDNASchema = z.object({
  sentenceRhythm: z.string(),
  flowPattern: z.string(),
  repetitionStyle: z.string(),
  tone: z.string(),
  transitions: z.string(),
  curiosityGaps: z.string(),
  emotionalTriggers: stringArray,
  directAddress: z.string(),
  detailLevel: z.string(),
});

export const ChannelAnalysisSchema = z.object({
  niche: z.string(),
  targetAudience: z.string(),
  hookStyle: z.string(),
  scriptFlow: z.string(),
  sentenceStyle: z.string(),
  emotionalPacingCurve: z.string(),
  retentionTechniques: stringArray,
  wordsPerSecond: z.number(),
  targetWordCount: z.number(),
  styleDNA: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        try { return JSON.parse(val); } catch { return val; }
      }
      return val;
    },
    StyleDNASchema
  ),
});

export const VideoIdeasSchema = z.object({
  ideas: z.array(z.string()).min(1),
});

export const VisualProfileSchema = z.object({
  artStyle: z.string(),
  colorPalette: stringArray,
  lightingStyle: z.string(),
  cameraStyle: z.string(),
  composition: z.string(),
  detailLevel: z.string(),
  mood: z.string(),
});

export const ThumbnailAnalysisSchema = z.object({
  textStyle: z.string(),
  composition: z.string(),
  colorContrast: z.string(),
  emotionTriggers: stringArray,
});

export const BeatSchema = z.object({
  beatNumber: z.number(),
  scriptSegment: z.string(),
  imagePrompt: z.string(),
  camera: z.string(),
  lighting: z.string(),
  mood: z.string(),
  action: z.string(),
  videoPrompt: z.string().optional(),
});

export const ThumbnailConceptSchema = z.object({
  position: z.number(),
  title: z.string(),
  visualConcept: z.string(),
  textOverlay: z.string(),
  emotionTrigger: z.string(),
  stylePrompt: z.string(),
});

export const PromptsOutputSchema = z.object({
  beats: z.array(BeatSchema),
  thumbnails: z.array(ThumbnailConceptSchema),
});

// Split schemas for phased generation. Critical fields keep .min(1):
//   - imagePrompt drives image generation; a blank one is unusable.
//   - scriptSegment is spoken by TTS and feeds the resume word-count
//     math; a blank or placeholder one would be voiced aloud or break
//     coverage tracking.
// The 4 metadata fields (camera/lighting/mood/action) are UI tags only
// (chips on the beat card + DOCX export). A blank one used to sink the
// entire chunk's beats via a top-level safeParse failure. They now
// preprocess blanks/missing to "unspecified" so one stray empty field
// no longer discards 30-40 paid-for beats. The route additionally
// validates beats one-by-one and salvages the good ones.
const blankToUnspecified = (v: unknown) =>
  typeof v === "string" && v.trim() ? v : "unspecified";

export const ImageBeatSchema = z.object({
  beatNumber: z.number(),
  scriptSegment: z.string().min(1),
  imagePrompt: z.string().min(1),
  camera: z.preprocess(blankToUnspecified, z.string()),
  lighting: z.preprocess(blankToUnspecified, z.string()),
  mood: z.preprocess(blankToUnspecified, z.string()),
  action: z.preprocess(blankToUnspecified, z.string()),
});

export const ImagePromptsSchema = z.object({
  beats: z.array(ImageBeatSchema),
});

export const VideoPromptsSchema = z.object({
  beats: z.array(z.object({
    beatNumber: z.number(),
    videoPrompt: z.string().min(1),
  })),
});

export const ThumbnailsOutputSchema = z.object({
  // Belt-and-braces with the Anthropic input_schema's minItems/maxItems —
  // a second guard so a bad model can't sneak fewer than 5 through.
  thumbnails: z.array(ThumbnailConceptSchema).length(5),
});

export type ChannelAnalysisOutput = z.infer<typeof ChannelAnalysisSchema>;
export type VideoIdeasOutput = z.infer<typeof VideoIdeasSchema>;
export type VisualProfileOutput = z.infer<typeof VisualProfileSchema>;
export type ThumbnailAnalysisOutput = z.infer<typeof ThumbnailAnalysisSchema>;
export type BeatOutput = z.infer<typeof BeatSchema>;
export type PromptsOutput = z.infer<typeof PromptsOutputSchema>;
