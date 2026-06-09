/**
 * Hand-written JSON Schema objects for Anthropic tool input_schema.
 * Avoids Zod v4's toJSONSchema Draft-2020-12 output (unevaluatedProperties,
 * $schema, $defs) which Anthropic does not fully support.
 */

export const channelAnalysisInputSchema = {
  type: "object" as const,
  properties: {
    niche: { type: "string" },
    targetAudience: { type: "string" },
    hookStyle: { type: "string" },
    scriptFlow: { type: "string" },
    sentenceStyle: { type: "string" },
    emotionalPacingCurve: { type: "string" },
    retentionTechniques: { type: "array", items: { type: "string" } },
    wordsPerSecond: { type: "number" },
    targetWordCount: { type: "number" },
    styleDNA: {
      type: "object",
      properties: {
        sentenceRhythm: { type: "string" },
        flowPattern: { type: "string" },
        repetitionStyle: { type: "string" },
        tone: { type: "string" },
        transitions: { type: "string" },
        curiosityGaps: { type: "string" },
        emotionalTriggers: { type: "array", items: { type: "string" } },
        directAddress: { type: "string" },
        detailLevel: { type: "string" },
      },
      required: ["sentenceRhythm", "flowPattern", "repetitionStyle", "tone", "transitions", "curiosityGaps", "emotionalTriggers", "directAddress", "detailLevel"],
    },
  },
  required: ["niche", "targetAudience", "hookStyle", "scriptFlow", "sentenceStyle", "emotionalPacingCurve", "retentionTechniques", "wordsPerSecond", "targetWordCount", "styleDNA"],
};

export const videoIdeasInputSchema = {
  type: "object" as const,
  properties: {
    ideas: { type: "array", items: { type: "string" } },
  },
  required: ["ideas"],
};

export const visualProfileInputSchema = {
  type: "object" as const,
  properties: {
    visualProfile: {
      type: "object",
      properties: {
        artStyle: { type: "string" },
        colorPalette: { type: "array", items: { type: "string" } },
        lightingStyle: { type: "string" },
        cameraStyle: { type: "string" },
        composition: { type: "string" },
        detailLevel: { type: "string" },
        mood: { type: "string" },
      },
      required: ["artStyle", "colorPalette", "lightingStyle", "cameraStyle", "composition", "detailLevel", "mood"],
    },
    thumbnailAnalysis: {
      type: "object",
      properties: {
        textStyle: { type: "string" },
        composition: { type: "string" },
        colorContrast: { type: "string" },
        emotionTriggers: { type: "array", items: { type: "string" } },
      },
      required: ["textStyle", "composition", "colorContrast", "emotionTriggers"],
    },
  },
  required: ["visualProfile"],
};

const beatItem = {
  type: "object" as const,
  properties: {
    beatNumber: { type: "number" },
    scriptSegment: { type: "string" },
    imagePrompt: { type: "string" },
    camera: { type: "string" },
    lighting: { type: "string" },
    mood: { type: "string" },
    action: { type: "string" },
  },
  required: ["beatNumber", "scriptSegment", "imagePrompt", "camera", "lighting", "mood", "action"],
};

export const imagePromptsInputSchema = {
  type: "object" as const,
  properties: {
    beats: { type: "array", items: beatItem },
  },
  required: ["beats"],
};

export const videoPromptsInputSchema = {
  type: "object" as const,
  properties: {
    beats: {
      type: "array",
      items: {
        type: "object",
        properties: {
          beatNumber: { type: "number" },
          videoPrompt: { type: "string" },
        },
        required: ["beatNumber", "videoPrompt"],
      },
    },
  },
  required: ["beats"],
};

const thumbnailItem = {
  type: "object" as const,
  properties: {
    position: { type: "number" },
    title: { type: "string" },
    visualConcept: { type: "string" },
    textOverlay: { type: "string" },
    emotionTrigger: { type: "string" },
    stylePrompt: { type: "string" },
  },
  required: ["position", "title", "visualConcept", "textOverlay", "emotionTrigger", "stylePrompt"],
};

export const thumbnailsInputSchema = {
  type: "object" as const,
  properties: {
    // EXACTLY 5 thumbnails — enforced via minItems/maxItems so Claude
    // can't drift to 3 or 4 (which silently breaks the downstream
    // image-generation step that maps 1:1 from concepts to images).
    thumbnails: { type: "array", items: thumbnailItem, minItems: 5, maxItems: 5 },
  },
  required: ["thumbnails"],
};
