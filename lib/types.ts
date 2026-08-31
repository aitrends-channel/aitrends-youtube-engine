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
  /** ISO 8601 timestamp from the videos.list snippet. Optional because
   *  cached ChannelInfo rows written before this field existed won't have
   *  it; the UI falls back to "—" in that case. */
  publishedAt?: string;
  /** Set when transcripts are fetched and the result is merged back into
   *  channel_info before the PATCH. Lets the channel page's videos table
   *  render the per-video word count on subsequent visits without having
   *  to re-fetch transcripts. */
  wordCount?: number;
  /** YouTube videos.list contentDetails.caption flag. True when the
   *  video has at least one caption track. Used by the long-video
   *  selection strategy: when the channel's avg duration exceeds the
   *  cap, we prefer videos with captions because Supadata can pull
   *  them directly without slow speech-to-text. */
  hasCaptions?: boolean;
}

/** User's content-type pick from the channel step. Scopes which videos
 *  the YouTube top-10 fetch returns ("long" = >60s, "shorts" = <=60s,
 *  "both" = no filter). Shared by the API route, channel resolver,
 *  and the channel page. */
export type ContentType = "long" | "shorts" | "both";

export interface ChannelInfo {
  channelId: string;
  channelName: string;
  subscribers: string;
  description?: string;
  topVideos: TopVideo[];
  /** The contentType scope these topVideos were filtered against. Used
   *  by the cache lookup to keep a prior "long" run from leaking into a
   *  new "shorts" run on the same channel. Optional because cached rows
   *  written before this field existed won't have it. */
  contentType?: ContentType;
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

/** A button overlaid on the finished video: which one, when it is on screen,
 *  and where. Times are seconds along the video; position and size are
 *  fractions of the frame. */
export interface ProjectElement {
  id: string;
  element: string;
  start_sec: number;
  end_sec: number;
  x: number;
  y: number;
  size: number;
  /** Which track it sits on. Higher draws over lower. */
  lane: number;
}

/** A line of text placed on the assembled video. Shares the timeline with
 *  ProjectElement, and differs by carrying content rather than a name. */
export interface ProjectText {
  id: string;
  content: string;
  start_sec: number;
  end_sec: number;
  x: number;
  y: number;
  /** Font height as a fraction of the frame height. */
  size: number;
  colour: string;
  /** Kept as the union rather than a bare string so a treatment the worker
   *  cannot draw is a type error here, not a silent fallback there. */
  style: "plain" | "outline" | "box" | "shadow" | "box-light" | "glow" | "heavy"
    | "thin" | "outline-white" | "glow-warm" | "shadow-soft" | "shadow-hard"
    | "poster" | "lift" | "side" | "faded" | "glow-cool" | "edge-red";
  /** Panel behind the text. Null is no panel. */
  bg_colour: string | null;
  bg_opacity: number;
  /** Which track it sits on. Higher draws over lower. */
  lane: number;
}

/** A sound placed at a moment on the finished video, rather than owned by a
 *  beat. Shares the timeline with elements and text. */
export interface ProjectSound {
  id: string;
  sound: string;
  at_sec: number;
  /** Relative to the project's sfx_volume, which stays the master. */
  volume: number;
  pitch: number;
  /** Seconds of the file to play. Null plays all of it. */
  duration_sec: number | null;
  lane: number;
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
  /** "queued" = part of a bulk run whose KIE submit hasn't landed yet
   *  (stamped on the whole target set at run start, upgraded to
   *  "generating" per-beat as each submit goes out). */
  imageStatus?: "pending" | "queued" | "generating" | "done" | "failed";
  videoStatus?: "pending" | "queued" | "submitting" | "rendering" | "done" | "failed" | "paused";
  /** This beat's own assembly effect, overriding the project's. Absent means it
   *  follows the project, which is every beat until somebody picks one. */
  imageMotion?: string | null;
  /** A sound played at this beat's start during assembly. Null is silence. */
  soundEffect?: string | null;
  /** The transition at the cut after this beat. Null follows the project. */
  transition?: string | null;
  /** Level and pitch for this beat's sound. Null means the sound as it is. */
  soundVolume?: number | null;
  soundPitch?: number | null;
  imageTaskId?: string;
  imageModelId?: string;
  videoJobId?: string;
  videoError?: string;
  /** Snapshot of the video-generation config used when this beat was
   *  queued (migration 091). Populated only on beats queued after
   *  that migration; older beats surface as undefined. */
  videoModelId?: string;
  videoDuration?: string | number;
  videoAspectRatio?: string;
  videoResolution?: string;
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
  /** What costPerUnit counts. Absent means the historical per-second figure the
   *  chip has always shown for video, or per generation for images. */
  costUnit?: "clip" | "sec";
  /** The provider that will actually serve this model, when it differs from the
   *  operator the admin selected. Set rather than hidden: the customer chose a
   *  model, and which provider runs it changes the price and the result. */
  servedBy?: string;
  /** The figure is the cheapest the model offers rather than what this run will
   *  cost, so the chip says "from". Set only for published rates, never for
   *  measured ones. */
  costIsFloor?: boolean;
  /** Seeded credits per unit at each resolution the model offers, so a card
   *  can quote the resolution in hand instead of the cheapest one. Sent whole
   *  rather than refetched per resolution: it is four numbers, and the chip
   *  should not wait on a request to stop saying "from". */
  costByResolution?: Record<string, number>;
  /** Observed average wall-clock generation time in milliseconds.
   *  Powers the picker's "Fastest" tab — lower is faster. Injected
   *  by /api/kie/models from the project_costs ledger. Absent for
   *  models with no ledger history. */
  avgSpeedMs?: number;
  /** Why this model cannot be selected right now, or absent when it can.
   *  Shown on a disabled card: a model that quietly routes somewhere else, or
   *  fails on submit, is worse than one the picker says it cannot serve. */
  unavailable?: string;
}

export interface JobStatus {
  status: "waiting" | "active" | "completed" | "failed" | "not_found";
  progress?: number;
  result?: { url: string };
  error?: string;
}
