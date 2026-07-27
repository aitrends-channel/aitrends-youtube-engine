// Shared shape for the project export documents. Both exporters
// (docxExporter, pdfExporter) render the same data, and collectExportData
// is the single place that maps DB rows onto it — so a field added here
// shows up in Word and PDF from one change.

export interface ExportBeat {
  beatNumber: number;
  scriptSegment: string;
  imagePrompt: string;
  camera: string;
  lighting: string;
  mood: string;
  action: string;
  videoPrompt?: string;
}

export interface ExportThumbnail {
  position: number;
  title: string;
  visualConcept: string;
  textOverlay: string;
  emotionTrigger: string;
  stylePrompt: string;
}

// Which prompt kinds to render per beat. Undefined means both, so existing
// callers keep the full document.
export interface ExportParts {
  image?: boolean;
  video?: boolean;
}

// Sections are emitted only for the fields present, so a prompts-only
// export simply leaves videoIdeas/script/thumbnails undefined.
export interface ExportData {
  channelName?: string;
  selectedTopic?: string;
  videoIdeas?: string[];
  script?: string;
  wordCount?: number;
  targetWordCount?: number;
  beats?: ExportBeat[];
  thumbnails?: ExportThumbnail[];
  parts?: ExportParts;
}

// Shared by both exporters so the Word and PDF beat sections can't diverge
// in which blocks they show or how the heading is worded.
export function resolveParts(parts: ExportParts | undefined) {
  const image = parts?.image !== false;
  const video = parts?.video !== false;
  return {
    image,
    video,
    heading: image && video
      ? "IMAGE PROMPTS & VIDEO PROMPTS"
      : image ? "IMAGE PROMPTS" : "VIDEO PROMPTS",
  };
}

// Drop beats that carry nothing for the selected kinds — a video-only
// export shouldn't emit "BEAT 7" headings for beats with no video prompt.
export function beatsForParts(beats: ExportBeat[], image: boolean, video: boolean): ExportBeat[] {
  return beats.filter((b) => (image && b.imagePrompt) || (video && b.videoPrompt));
}
