import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Packer,
} from "docx";

import { beatsForParts, resolveParts, type ExportData } from "./exportTypes";

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

  // Sections are numbered as they're emitted rather than hardcoded, because
  // callers pass different subsets — the prompts-only export would
  // otherwise open on "SECTION 3" with no sections 1 or 2 above it, and a
  // project with no video ideas already skipped straight to "SECTION 2".
  let sectionNo = 0;
  const section = (title: string) =>
    heading(`SECTION ${++sectionNo} — ${title}`, HeadingLevel.HEADING_1);

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
    children.push(section("25 VIDEO IDEAS"));
    data.videoIdeas.forEach((idea, i) => {
      children.push(para(`${i + 1}. ${idea}`));
    });
  }

  // Section 2 — Script
  if (data.script) {
    children.push(section("FULL SCRIPT"));
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

  // Section 3 — Beats. The camera/lighting/mood/action bullets describe the
  // image prompt, so they travel with it rather than appearing in a
  // video-only export.
  if (data.beats?.length) {
    const { image, video, heading: partsHeading } = resolveParts(data.parts);
    const chosen = beatsForParts(data.beats, image, video);
    if (chosen.length) {
      children.push(section(partsHeading));
      for (const beat of chosen) {
        children.push(heading(`BEAT ${beat.beatNumber}`, HeadingLevel.HEADING_2));
        children.push(para(`SCRIPT: ${beat.scriptSegment}`));
        children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
        if (image && beat.imagePrompt) {
          children.push(para(`IMAGE PROMPT: ${beat.imagePrompt}`, { bold: false }));
          children.push(para(`• Camera: ${beat.camera}`));
          children.push(para(`• Lighting: ${beat.lighting}`));
          children.push(para(`• Mood: ${beat.mood}`));
          children.push(para(`• Action: ${beat.action}`));
        }
        if (video && beat.videoPrompt) {
          children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
          children.push(para(`VIDEO PROMPT: ${beat.videoPrompt}`));
        }
      }
    }
  }

  // Section 4 — Thumbnails
  if (data.thumbnails?.length) {
    children.push(section("THUMBNAIL CONCEPTS"));
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
