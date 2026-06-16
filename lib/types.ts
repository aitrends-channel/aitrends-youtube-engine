export type ProjectState =
  | "channel_setup"
  | "analyzing"
  | "script"
  | "visuals"
  | "prompts"
  | "generate";

export interface TopVideo {
  videoId: string;
  title: string;
  viewCount: number;
  duration?: string;
}

export interface ChannelInfo {
  channelId: string;
  channelName: string;
  subscribers: string;
  description?: string;
  topVideos: TopVideo[];
  lastCachedAt?: string;
}

export interface TranscriptResult {
  videoId: string;
  title: string;
  text: string;
  success: boolean;
  error?: string;
}

export interface VideoMetadata {
  videoId: string;
  title: string;
  description: string;
  tags: string[];
  viewCount: number;
  likeCount: number;
  commentCount: number;
  publishedAt: string;
  duration: string;
  topComments: string[];
}

export interface StyleDNA {
  sentenceRhythm: string;
  flowPattern: string;
  repetitionStyle: string;
  tone: string;
  transitions: string;
  curiosityGaps: string;
  emotionalTriggers: string[];
  directAddress: string;
  detailLevel: string;
}

export interface ChannelAnalysis {
  niche: string;
  targetAudience: string;
  hookStyle: string;
  scriptFlow: string;
  sentenceStyle: string;
  emotionalPacingCurve: string;
  retentionTechniques: string[];
  wordsPerSecond: number;
  targetWordCount: number;
  styleDNA: StyleDNA;
}

export interface VisualProfile {
  artStyle: string;
  colorPalette: string[];
  lightingStyle: string;
  cameraStyle: string;
  composition: string;
  detailLevel: string;
  mood: string;
}

export interface ThumbnailAnalysis {
  textStyle: string;
  composition: string;
  colorContrast: string;
  emotionTriggers: string[];
}

export interface Beat {
  beatNumber: number;
  scriptSegment: string;
  imagePrompt: string;
  camera: string;
  lighting: string;
  mood: string;
  action: string;
  videoPrompt?: string;
  imageUrl?: string;
  videoUrl?: string;
  imageStatus?: "pending" | "generating" | "done" | "failed";
  videoStatus?: "pending" | "queued" | "submitting" | "rendering" | "done" | "failed" | "paused";
  imageTaskId?: string;
  imageModelId?: string;
  videoJobId?: string;
  videoError?: string;
  audioUrl?: string;
  /** Per-beat voiceover fields (migration 045). Each beat gets its
   *  own TTS mp3 generated from its scriptSegment; the assembler
   *  concatenates them in order, skipping the matcher entirely. */
  voiceoverUrl?: string;
  voiceoverStatus?: "pending" | "queued" | "generating" | "done" | "failed";
  voiceoverDurationMs?: number;
  voiceoverVoiceId?: string;
  voiceoverScriptHash?: string;
  voiceoverError?: string;
  voiceoverJobId?: string;
}

export interface ThumbnailConcept {
  position: number;
  title: string;
  visualConcept: string;
  textOverlay: string;
  emotionTrigger: string;
  stylePrompt: string;
  imageUrl?: string;
  imageStatus?: "pending" | "generating" | "done" | "failed";
}

export interface Project {
  id: string;
  createdAt: string;
  channelUrl?: string;
  channelName?: string;
  channelInfo?: ChannelInfo;
  transcripts?: TranscriptResult[];
  currentState: number;
  selectedTopic?: string;
  videoIdeas?: string[];
  channelAnalysis?: ChannelAnalysis;
  script?: string;
  wordCount?: number;
  targetWordCount?: number;
  visualProfile?: VisualProfile;
  thumbnailAnalysis?: ThumbnailAnalysis;
  beats?: Beat[];
  thumbnails?: ThumbnailConcept[];
  ttsUrl?: string;
  ttsVoiceId?: string;
  ttsCleanedUrl?: string;
  assembledUrl?: string;
  assemblyStatus?: "processing" | "done" | "failed";
  assemblyProgress?: string;
  assemblyError?: string;
  imagesProgress?: number;
  videosProgress?: number;
}

export interface KieModel {
  id: string;
  name: string;
  description?: string;
  type: "tts" | "image" | "video";
  tags?: string[];
  previewUrl?: string;
  costPerUnit?: string;
  /** Observed average wall-clock generation time in milliseconds.
   *  Powers the picker's "Fastest" tab — lower is faster. Injected
   *  by /api/kie/models from the project_costs ledger. Absent for
   *  models with no ledger history. */
  avgSpeedMs?: number;
}

export interface JobStatus {
  status: "waiting" | "active" | "completed" | "failed" | "not_found";
  progress?: number;
  result?: { url: string };
  error?: string;
}
