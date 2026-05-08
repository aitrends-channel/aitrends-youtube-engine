import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Packer,
} from "docx";

interface Beat {
  beatNumber: number;
  scriptSegment: string;
  imagePrompt: string;
  camera: string;
  lighting: string;
  mood: string;
  action: string;
  videoPrompt?: string;
}

interface Thumbnail {
  position: number;
  title: string;
  visualConcept: string;
  textOverlay: string;
  emotionTrigger: string;
  stylePrompt: string;
}

interface ExportData {
  channelName?: string;
  selectedTopic?: string;
  videoIdeas?: string[];
  script?: string;
  wordCount?: number;
  targetWordCount?: number;
  beats?: Beat[];
  thumbnails?: Thumbnail[];
}

function para(text: string, opts?: { bold?: boolean; size?: number }) {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        bold: opts?.bold,
        size: opts?.size,
      }),
    ],
    spacing: { after: 120 },
  });
}

function heading(text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel]) {
  return new Paragraph({
    text,
    heading: level,
    spacing: { before: 400, after: 200 },
  });
}

export async function buildDocx(data: ExportData): Promise<Buffer> {
  const children: Paragraph[] = [];

  // Title
  children.push(
    new Paragraph({
      text: data.channelName ? `AI YouTube Engine — ${data.channelName}` : "AI YouTube Engine",
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    })
  );

  if (data.selectedTopic) {
    children.push(para(`Topic: ${data.selectedTopic}`, { bold: true }));
  }

  // Section 1 — Video Ideas
  if (data.videoIdeas?.length) {
    children.push(heading("SECTION 1 — 25 VIDEO IDEAS", HeadingLevel.HEADING_1));
    data.videoIdeas.forEach((idea, i) => {
      children.push(para(`${i + 1}. ${idea}`));
    });
  }

  // Section 2 — Script
  if (data.script) {
    children.push(heading("SECTION 2 — FULL SCRIPT", HeadingLevel.HEADING_1));
    if (data.targetWordCount) {
      children.push(para(`Target Word Count: ${data.targetWordCount} words`));
    }
    if (data.wordCount) {
      children.push(para(`Final Word Count: ${data.wordCount} words`));
    }
    children.push(new Paragraph({ text: "", spacing: { after: 200 } }));

    const paragraphs = data.script.split(/\n\n+/);
    for (const p of paragraphs) {
      children.push(para(p.trim()));
    }
  }

  // Section 3 — Beats
  if (data.beats?.length) {
    children.push(heading("SECTION 3 — IMAGE PROMPTS & VIDEO PROMPTS", HeadingLevel.HEADING_1));
    for (const beat of data.beats) {
      children.push(heading(`BEAT ${beat.beatNumber}`, HeadingLevel.HEADING_2));
      children.push(para(`SCRIPT: ${beat.scriptSegment}`));
      children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
      children.push(para(`IMAGE PROMPT: ${beat.imagePrompt}`, { bold: false }));
      children.push(para(`• Camera: ${beat.camera}`));
      children.push(para(`• Lighting: ${beat.lighting}`));
      children.push(para(`• Mood: ${beat.mood}`));
      children.push(para(`• Action: ${beat.action}`));
      if (beat.videoPrompt) {
        children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
        children.push(para(`VIDEO PROMPT: ${beat.videoPrompt}`));
      }
    }
  }

  // Section 4 — Thumbnails
  if (data.thumbnails?.length) {
    children.push(heading("SECTION 4 — THUMBNAIL CONCEPTS", HeadingLevel.HEADING_1));
    for (const thumb of data.thumbnails) {
      children.push(heading(`Thumbnail ${thumb.position} — ${thumb.title}`, HeadingLevel.HEADING_2));
      children.push(para(`Visual Concept: ${thumb.visualConcept}`));
      children.push(para(`Text Overlay: ${thumb.textOverlay}`));
      children.push(para(`Emotion Trigger: ${thumb.emotionTrigger}`));
      children.push(para(`Style-Matched Prompt: ${thumb.stylePrompt}`));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
