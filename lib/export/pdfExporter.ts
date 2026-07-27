import { jsPDF } from "jspdf";
import { beatsForParts, resolveParts, type ExportData } from "./exportTypes";

// PDF twin of docxExporter — same sections, same order, same dynamic
// section numbering, so the Word and PDF downloads of a project read
// identically. jsPDF (rather than a headless browser) keeps this a plain
// serverless function with no binary to ship.
//
// jsPDF has no flow layout: text is drawn at an absolute y, so this module
// owns wrapping (splitTextToSize) and page breaks (the `write` helper
// checks the remaining height before each line). Every string goes through
// `write` for that reason — drawing directly with doc.text() would run off
// the bottom of the page.

const PAGE_MARGIN = 56; // ~0.78in at 72dpi
const LINE_GAP = 4;

export function buildPdf(data: ExportData): Buffer {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - PAGE_MARGIN * 2;
  let y = PAGE_MARGIN;

  // Draw one block of text, wrapping to contentWidth and starting a new
  // page whenever the next line would cross the bottom margin.
  function write(
    text: string,
    opts?: { size?: number; bold?: boolean; gapBefore?: number; gapAfter?: number; align?: "center" },
  ) {
    const size = opts?.size ?? 10;
    doc.setFont("helvetica", opts?.bold ? "bold" : "normal");
    doc.setFontSize(size);
    const lineHeight = size + LINE_GAP;

    y += opts?.gapBefore ?? 0;
    // Guard: a large gapBefore alone can push past the page end.
    if (y > pageHeight - PAGE_MARGIN) {
      doc.addPage();
      y = PAGE_MARGIN;
    }

    for (const line of doc.splitTextToSize(text, contentWidth) as string[]) {
      if (y + lineHeight > pageHeight - PAGE_MARGIN) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
      doc.text(line, opts?.align === "center" ? pageWidth / 2 : PAGE_MARGIN, y, {
        align: opts?.align === "center" ? "center" : "left",
      });
      y += lineHeight;
    }
    y += opts?.gapAfter ?? 0;
  }

  // Numbered as emitted, matching docxExporter — a prompts-only export
  // must not open on "SECTION 3".
  let sectionNo = 0;
  const section = (title: string) =>
    write(`SECTION ${++sectionNo} — ${title}`, { size: 14, bold: true, gapBefore: 18, gapAfter: 6 });

  write(
    data.channelName ? `AI YouTube Engine — ${data.channelName}` : "AI YouTube Engine",
    { size: 20, bold: true, align: "center", gapAfter: 10 },
  );

  if (data.selectedTopic) {
    write(`Topic: ${data.selectedTopic}`, { bold: true, gapAfter: 4 });
  }

  if (data.videoIdeas?.length) {
    section(`${data.videoIdeas.length} VIDEO IDEAS`);
    data.videoIdeas.forEach((idea, i) => write(`${i + 1}. ${idea}`, { gapAfter: 2 }));
  }

  if (data.script) {
    section("FULL SCRIPT");
    if (data.targetWordCount) write(`Target Word Count: ${data.targetWordCount} words`);
    if (data.wordCount) write(`Final Word Count: ${data.wordCount} words`);
    y += 6;
    for (const p of data.script.split(/\n\n+/)) {
      write(p.trim(), { gapAfter: 6 });
    }
  }

  // Mirrors docxExporter: the camera/lighting/mood/action bullets belong to
  // the image prompt and are omitted from a video-only export.
  if (data.beats?.length) {
    const { image, video, heading: partsHeading } = resolveParts(data.parts);
    const chosen = beatsForParts(data.beats, image, video);
    if (chosen.length) {
      section(partsHeading);
      for (const beat of chosen) {
        write(`BEAT ${beat.beatNumber}`, { size: 12, bold: true, gapBefore: 10, gapAfter: 2 });
        write(`SCRIPT: ${beat.scriptSegment}`, { gapAfter: 4 });
        if (image && beat.imagePrompt) {
          write(`IMAGE PROMPT: ${beat.imagePrompt}`, { gapAfter: 2 });
          write(`• Camera: ${beat.camera}`);
          write(`• Lighting: ${beat.lighting}`);
          write(`• Mood: ${beat.mood}`);
          write(`• Action: ${beat.action}`);
        }
        if (video && beat.videoPrompt) {
          write(`VIDEO PROMPT: ${beat.videoPrompt}`, { gapBefore: 4 });
        }
      }
    }
  }

  if (data.thumbnails?.length) {
    section("THUMBNAIL CONCEPTS");
    for (const thumb of data.thumbnails) {
      write(`Thumbnail ${thumb.position} — ${thumb.title}`, { size: 12, bold: true, gapBefore: 10, gapAfter: 2 });
      write(`Visual Concept: ${thumb.visualConcept}`);
      write(`Text Overlay: ${thumb.textOverlay}`);
      write(`Emotion Trigger: ${thumb.emotionTrigger}`);
      write(`Style-Matched Prompt: ${thumb.stylePrompt}`);
    }
  }

  return Buffer.from(doc.output("arraybuffer"));
}
