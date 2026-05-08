import { z } from "zod";

export const StyleDNASchema = z.object({
  sentenceRhythm: z.string(),
  flowPattern: z.string(),
  repetitionStyle: z.string(),
  tone: z.string(),
  transitions: z.string(),
  curiosityGaps: z.string(),
  emotionalTriggers: z.array(z.string()),
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
  retentionTechniques: z.array(z.string()),
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
  colorPalette: z.array(z.string()),
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
  emotionTriggers: z.array(z.string()),
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

// Split schemas for phased generation
export const ImagePromptsSchema = z.object({
  beats: z.array(z.object({
    beatNumber: z.number(),
    scriptSegment: z.string(),
    imagePrompt: z.string(),
    camera: z.string(),
    lighting: z.string(),
    mood: z.string(),
    action: z.string(),
  })),
});

export const VideoPromptsSchema = z.object({
  beats: z.array(z.object({
    beatNumber: z.number(),
    videoPrompt: z.string(),
  })),
});

export const ThumbnailsOutputSchema = z.object({
  thumbnails: z.array(ThumbnailConceptSchema),
});

export type ChannelAnalysisOutput = z.infer<typeof ChannelAnalysisSchema>;
export type VideoIdeasOutput = z.infer<typeof VideoIdeasSchema>;
export type VisualProfileOutput = z.infer<typeof VisualProfileSchema>;
export type ThumbnailAnalysisOutput = z.infer<typeof ThumbnailAnalysisSchema>;
export type BeatOutput = z.infer<typeof BeatSchema>;
export type PromptsOutput = z.infer<typeof PromptsOutputSchema>;
