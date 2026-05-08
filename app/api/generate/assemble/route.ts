import ffmpeg from "fluent-ffmpeg";
import { supabase } from "@/lib/supabase/client";
import { uploadBuffer } from "@/lib/supabase/storage";
import { getAnthropicClient, MODEL } from "@/lib/claude/client";
import { getSettings } from "@/lib/settings";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import os from "os";

export const maxDuration = 300;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string | null = require("ffmpeg-static");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobeStatic: { path: string } = require("ffprobe-static");

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);


async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buf));
}

function getMediaDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) reject(new Error(`ffprobe failed: ${err.message}`));
      else resolve(meta.format.duration ?? 0);
    });
  });
}

function normalizeClip(
  src: string,
  isImage: boolean,
  duration: number,
  output: string,
  w: number,
  h: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,fps=24`;
    const cmd = ffmpeg();
    if (isImage) {
      cmd.input(src).inputOptions(["-loop", "1"]);
    } else {
      cmd.input(src).inputOptions(["-stream_loop", "-1"]);
    }
    cmd
      .outputOptions(["-t", String(duration), "-vf", vf, "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-an", "-pix_fmt", "yuv420p"])
      .output(output)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`normalize clip failed: ${err.message}`)))
      .run();
  });
}

function blackClip(duration: number, output: string, w: number, h: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(`color=black:size=${w}x${h}:rate=24`)
      .inputOptions(["-f", "lavfi"])
      .outputOptions(["-t", String(duration), "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-an", "-pix_fmt", "yuv420p"])
      .output(output)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`black clip failed: ${err.message}`)))
      .run();
  });
}

function concatClips(listFile: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c", "copy"])
      .output(output)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`concat failed: ${err.message}`)))
      .run();
  });
}

function mixAudio(video: string, audio: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(video)
      .input(audio)
      .outputOptions(["-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest"])
      .output(output)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`audio mix failed: ${err.message}`)))
      .run();
  });
}

// ── ElevenLabs transcription ──────────────────────────────────────────────────

interface TranscriptionWord {
  text?: string;
  word?: string;     // some API versions use "word"
  start?: number;
  start_time?: number;
  end?: number;
  end_time?: number;
  type?: string;
}

async function transcribeAudio(audioPath: string, userId: string): Promise<TranscriptionWord[]> {
  const { elevenlabs_api_key: apiKey } = await getSettings(userId);
  if (!apiKey) throw new Error("ElevenLabs API key not configured. Add it in Settings.");

  const audioBytes = fs.readFileSync(audioPath);

  const MAX_ATTEMPTS = 4;
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const formData = new FormData();
    formData.append("file", new Blob([audioBytes], { type: "audio/mpeg" }), "voiceover.mp3");
    formData.append("model_id", "scribe_v1");
    formData.append("timestamps_granularity", "word");
    formData.append("tag_audio_events", "false");

    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: formData,
    });

    if (res.ok) {
      const data = await res.json() as { words?: TranscriptionWord[] };
      return (data.words ?? []).filter((w) => (w.type ?? "word") === "word");
    }

    const body = await res.text();
    lastError = `ElevenLabs STT error ${res.status}: ${body}`;

    if (res.status !== 429 || attempt === MAX_ATTEMPTS) break;

    const delay = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
    console.warn(`[assemble] transcription 429 — retrying in ${delay / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
    await new Promise((r) => setTimeout(r, delay));
  }

  throw new Error(lastError);
}

// ── Beat-to-transcription alignment ──────────────────────────────────────────

// Strip punctuation and lowercase so "Hello," matches "hello"
function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function alignBeats(
  beatTexts: string[],
  transcriptionWords: TranscriptionWord[],
  totalAudioDuration: number
): number[] {
  const getStart = (w: TranscriptionWord) => w.start ?? w.start_time ?? 0;

  if (!transcriptionWords.length) {
    // Proportional fallback: divide audio by script word-count fractions
    const wordCounts = beatTexts.map((t) => Math.max(1, t.trim().split(/\s+/).filter(Boolean).length));
    const total = wordCounts.reduce((s, n) => s + n, 0);
    return wordCounts.map((n) => Math.max(0.5, (n / total) * totalAudioDuration));
  }

  const transcriptNorm = transcriptionWords.map((w) => normalizeWord(w.text ?? w.word ?? ""));
  let searchFrom = 0;
  const beatStartIndices: number[] = [];

  for (const beatText of beatTexts) {
    const beatWords = beatText.trim().split(/\s+/).filter(Boolean).map(normalizeWord).filter(Boolean);

    if (!beatWords.length || searchFrom >= transcriptionWords.length) {
      beatStartIndices.push(Math.min(searchFrom, transcriptionWords.length - 1));
      continue;
    }

    // Try to find the beat's opening phrase (up to first 3 words) in the transcription.
    // Require ≥2 consecutive matches to avoid false positives on short common words.
    const window = beatWords.slice(0, 3);
    let bestIdx = searchFrom; // fallback: stay at current position

    for (let i = searchFrom; i < transcriptionWords.length; i++) {
      let matches = 0;
      for (let j = 0; j < window.length && i + j < transcriptionWords.length; j++) {
        if (transcriptNorm[i + j] === window[j]) matches++;
      }
      if (matches >= Math.min(2, window.length)) {
        bestIdx = i;
        break;
      }
    }

    beatStartIndices.push(bestIdx);
    searchFrom = bestIdx + 1; // always advance so beats stay in order
  }

  // Convert start indices → durations
  // Beat i duration = timestamp of beat i+1's first word − timestamp of beat i's first word
  const durations: number[] = [];
  for (let i = 0; i < beatTexts.length; i++) {
    const startIdx = beatStartIndices[i];
    const nextIdx = i < beatTexts.length - 1 ? beatStartIndices[i + 1] : transcriptionWords.length;
    const start = getStart(transcriptionWords[Math.min(startIdx, transcriptionWords.length - 1)]);
    const end =
      nextIdx < transcriptionWords.length
        ? getStart(transcriptionWords[nextIdx])
        : totalAudioDuration;
    durations.push(Math.max(0.5, end - start));
  }

  return durations;
}

// ── SRT caption generation ────────────────────────────────────────────────────

interface SrtSegment {
  index: number;
  start: number;
  end: number;
  text: string;
}

function buildSrtSegmentsFromBeats(beats: Beat[], durations: number[], wordsPerSegment = 7): SrtSegment[] {
  const segments: SrtSegment[] = [];
  let cursor = 0;
  for (let i = 0; i < beats.length; i++) {
    const duration = durations[i];
    const words = (beats[i].script_segment ?? "").trim().split(/\s+/).filter(Boolean);
    if (words.length) {
      for (let j = 0; j < words.length; j += wordsPerSegment) {
        const chunk = words.slice(j, j + wordsPerSegment);
        const start = cursor + (j / words.length) * duration;
        const end = cursor + (Math.min(j + wordsPerSegment, words.length) / words.length) * duration;
        segments.push({ index: segments.length + 1, start, end, text: chunk.join(" ") });
      }
    }
    cursor += duration;
  }
  return segments;
}

function buildSrtSegments(words: TranscriptionWord[], wordsPerSegment = 7): SrtSegment[] {
  const getStart = (w: TranscriptionWord) => w.start ?? w.start_time ?? 0;
  const getEnd = (w: TranscriptionWord) => w.end ?? w.end_time ?? getStart(w) + 2;

  const segments: SrtSegment[] = [];
  for (let i = 0; i < words.length; i += wordsPerSegment) {
    const chunk = words.slice(i, Math.min(i + wordsPerSegment, words.length));
    const start = getStart(chunk[0]);
    const lastWord = chunk[chunk.length - 1];
    const nextWord = words[i + wordsPerSegment];
    const end = getEnd(lastWord) || (nextWord ? getStart(nextWord) : start + 3);
    const text = chunk.map((w) => (w.text ?? w.word ?? "").trim()).filter(Boolean).join(" ");
    if (text) segments.push({ index: segments.length + 1, start, end, text });
  }
  return segments;
}

// ASS time format: h:mm:ss.cs
function toAssTime(seconds: number): string {
  const h  = Math.floor(seconds / 3600);
  const m  = Math.floor((seconds % 3600) / 60);
  const s  = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

interface AssStyle {
  fontSize: number; alignment: number; marginV: number;
  primaryColour: string; outlineColour: string; backColour: string;
  bold: number; borderStyle: number; outline: number; shadow: number;
}

// Font size and margin are expressed in PlayRes units (= real pixels when PlayRes matches video).
// Using a percentage of video height keeps captions proportionally identical across 16:9, 9:16, and 1:1.
function buildAssStyle(style: string, size: string, position: string, videoH: number): AssStyle {
  const fontPct   = size === "small" ? 0.030 : size === "large" ? 0.052 : 0.040;
  const fontSize  = Math.round(videoH * fontPct);
  const alignment = position === "top" ? 8 : 2;   // numpad layout: 8=top-centre, 2=bottom-centre
  const marginV   = Math.round(videoH * 0.03);     // 3% of height padding from edge
  // SSA colours: &HAABBGGRR  (AA=alpha, 00=opaque; FF=transparent)
  switch (style) {
    case "bold":
      return { fontSize, alignment, marginV, primaryColour: "&H0000FFFF", outlineColour: "&H00000000", backColour: "&H00000000", bold: 1, borderStyle: 1, outline: 2, shadow: 0 };
    case "boxed":
      return { fontSize, alignment, marginV, primaryColour: "&H00FFFFFF", outlineColour: "&H00000000", backColour: "&H80000000", bold: 0, borderStyle: 3, outline: 0, shadow: 0 };
    case "minimal":
      return { fontSize, alignment, marginV, primaryColour: "&H00FFFFFF", outlineColour: "&H00000000", backColour: "&H00000000", bold: 0, borderStyle: 1, outline: 1, shadow: 0 };
    case "classic":
    default:
      return { fontSize, alignment, marginV, primaryColour: "&H00FFFFFF", outlineColour: "&H00000000", backColour: "&H00000000", bold: 0, borderStyle: 1, outline: 2, shadow: 1 };
  }
}

// Write an ASS file — style embedded in the header so libass never needs force_style overrides.
// PlayRes must match the actual video dimensions so FontSize units equal real pixels.
function writeAss(segments: SrtSegment[], s: AssStyle, videoW: number, videoH: number, filePath: string): void {
  const styleRow =
    `Style: Default,Arial,${s.fontSize},${s.primaryColour},&H000000FF,` +
    `${s.outlineColour},${s.backColour},${s.bold},0,0,0,100,100,0,0,` +
    `${s.borderStyle},${s.outline},${s.shadow},${s.alignment},10,10,${s.marginV},1`;

  const dialogues = segments
    .map((seg) => `Dialogue: 0,${toAssTime(seg.start)},${toAssTime(seg.end)},Default,,0,0,0,,${seg.text}`)
    .join("\n");

  const content =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${videoW}\nPlayResY: ${videoH}\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styleRow}\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${dialogues}`;

  fs.writeFileSync(filePath, content, "utf-8");
}

async function translateSegments(segments: SrtSegment[], targetLanguage: string, userId: string): Promise<SrtSegment[]> {
  if (!segments.length) return segments;
  const anthropic = await getAnthropicClient(userId);
  const numbered = segments.map((s) => `${s.index}. ${s.text}`).join("\n");
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: `Translate these numbered caption lines to ${targetLanguage}. Return only the translated lines in exactly the same "N. text" format, one per line:\n\n${numbered}`,
    }],
  });
  const raw = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  const lines = raw.split("\n").filter(Boolean);
  return segments.map((seg) => {
    const line = lines.find((l) => l.startsWith(`${seg.index}.`));
    if (!line) return seg;
    return { ...seg, text: line.replace(/^\d+\.\s*/, "").trim() };
  });
}

function burnSubtitles(video: string, assPath: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const escaped = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    ffmpeg()
      .input(video)
      .outputOptions([
        "-vf", `ass='${escaped}'`,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "copy",
      ])
      .output(output)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(new Error(`subtitle burn failed: ${err.message}`)))
      .run();
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Beat = {
  beat_number: number;
  script_segment: string | null;
  video_url: string | null;
  image_url: string | null;
};

function send(controller: ReadableStreamDefaultController, event: object) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const {
    projectId, aspectRatio = "16:9", voiceoverType = "cleaned",
    captionsEnabled = false, captionsLanguage = "source",
    captionsStyle = "classic", captionsSize = "medium", captionsPosition = "bottom",
  } = await req.json() as {
    projectId: string; aspectRatio?: string; voiceoverType?: "cleaned" | "original";
    captionsEnabled?: boolean; captionsLanguage?: string;
    captionsStyle?: string; captionsSize?: string; captionsPosition?: string;
  };

  if (!projectId) {
    return new Response(`data: ${JSON.stringify({ type: "error", message: "projectId required" })}\n\n`, { status: 400 });
  }

  const [w, h] = aspectRatio === "9:16" ? [1080, 1920] : aspectRatio === "1:1" ? [1080, 1080] : [1920, 1080];

  const stream = new ReadableStream({
    async start(controller) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assemble-"));

      try {
        send(controller, { type: "status", message: "Loading project data…" });

        const [projectRes, beatsRes] = await Promise.all([
          supabase.from("projects").select("tts_url, tts_cleaned_url").eq("id", projectId).eq("user_id", user.id).single(),
          supabase.from("project_beats").select("beat_number, script_segment, video_url, image_url").eq("project_id", projectId).order("beat_number"),
        ]);

        if (projectRes.error) throw new Error("Project not found");

        const proj = projectRes.data as { tts_url: string | null; tts_cleaned_url: string | null };
        const beats = (beatsRes.data ?? []) as Beat[];

        const voiceoverUrl = voiceoverType === "original"
          ? (proj.tts_url ?? proj.tts_cleaned_url)
          : (proj.tts_cleaned_url ?? proj.tts_url);

        if (!voiceoverUrl) throw new Error("No voiceover found — generate a voiceover on the Generate page first.");
        if (!beats.length) throw new Error("No beats found in this project.");

        // ── Download voiceover ────────────────────────────────────────────────
        send(controller, { type: "status", message: "Downloading voiceover…" });
        const voiceoverPath = path.join(tmpDir, "voiceover.mp3");
        await downloadFile(voiceoverUrl, voiceoverPath);

        const totalDuration = await getMediaDuration(voiceoverPath);
        if (totalDuration <= 0) throw new Error("Could not determine voiceover duration");

        // ── Transcribe voiceover for word timestamps ──────────────────────────
        send(controller, { type: "status", message: "Transcribing voiceover…" });
        let transcriptionWords: TranscriptionWord[] = [];
        try {
          transcriptionWords = await transcribeAudio(voiceoverPath, user.id);
          console.log(`[assemble] transcription: ${transcriptionWords.length} words`);
        } catch (transcribeErr) {
          console.warn("[assemble] transcription failed, falling back to word-count proportional:", transcribeErr);
          // transcriptionWords stays empty → alignBeats falls back to proportional
        }

        // ── Align beats to transcription timestamps ───────────────────────────
        const beatTexts = beats.map((b) => b.script_segment ?? "");
        const durations = alignBeats(beatTexts, transcriptionWords, totalDuration);

        // ── Process each beat into a normalized clip ──────────────────────────
        send(controller, { type: "status", message: "Processing video clips…" });
        const clipPaths: string[] = [];

        for (let i = 0; i < beats.length; i++) {
          const beat = beats[i];
          const duration = durations[i];
          const clipPath = path.join(tmpDir, `clip_${String(i).padStart(3, "0")}.mp4`);

          send(controller, { type: "progress", current: i + 1, total: beats.length, message: `Processing beat ${beat.beat_number}…` });

          try {
            if (beat.video_url) {
              const ext = beat.video_url.includes(".webm") ? "webm" : "mp4";
              const srcPath = path.join(tmpDir, `src_${i}.${ext}`);
              await downloadFile(beat.video_url, srcPath);
              await normalizeClip(srcPath, false, duration, clipPath, w, h);
            } else if (beat.image_url) {
              const ext = beat.image_url.toLowerCase().includes(".png") ? "png" : "jpg";
              const srcPath = path.join(tmpDir, `src_${i}.${ext}`);
              await downloadFile(beat.image_url, srcPath);
              await normalizeClip(srcPath, true, duration, clipPath, w, h);
            } else {
              await blackClip(duration, clipPath, w, h);
            }
          } catch (clipErr) {
            console.error(`[assemble] beat ${beat.beat_number} clip error:`, clipErr);
            await blackClip(duration, clipPath, w, h);
          }

          clipPaths.push(clipPath);
        }

        // ── Concat all clips ──────────────────────────────────────────────────
        send(controller, { type: "status", message: "Joining clips…" });
        const listPath = path.join(tmpDir, "concat.txt");
        fs.writeFileSync(listPath, clipPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
        const joinedPath = path.join(tmpDir, "joined.mp4");
        await concatClips(listPath.replace(/\\/g, "/"), joinedPath);

        // ── Mix voiceover ─────────────────────────────────────────────────────
        send(controller, { type: "status", message: "Mixing voiceover…" });
        const outputPath = path.join(tmpDir, "output.mp4");
        await mixAudio(joinedPath, voiceoverPath, outputPath);

        // ── Burn captions (optional) ──────────────────────────────────────────
        let finalOutputPath = outputPath;
        if (captionsEnabled) {
          try {
            send(controller, { type: "status", message: "Generating captions…" });
            let segments = transcriptionWords.length > 0
              ? buildSrtSegments(transcriptionWords)
              : buildSrtSegmentsFromBeats(beats, durations);

            if (captionsLanguage !== "source") {
              send(controller, { type: "status", message: `Translating captions to ${captionsLanguage}…` });
              segments = await translateSegments(segments, captionsLanguage, user.id);
            }

            const assPath = path.join(tmpDir, "captions.ass");
            const assStyle = buildAssStyle(captionsStyle, captionsSize, captionsPosition, h);
            writeAss(segments, assStyle, w, h, assPath);

            send(controller, { type: "status", message: "Burning captions into video…" });
            const captionedPath = path.join(tmpDir, "captioned.mp4");
            await burnSubtitles(outputPath, assPath, captionedPath);
            finalOutputPath = captionedPath;
          } catch (captionErr) {
            const msg = captionErr instanceof Error ? captionErr.message : String(captionErr);
            console.warn("[assemble] caption burn failed:", msg);
            send(controller, { type: "caption_warn", message: `Captions failed (${msg}) — assembling without captions.` });
          }
        }

        // ── Upload ────────────────────────────────────────────────────────────
        send(controller, { type: "status", message: "Uploading assembled video…" });
        const buf = fs.readFileSync(finalOutputPath);
        const publicUrl = await uploadBuffer(
          `${projectId}/assembled_${Date.now()}.mp4`,
          buf.buffer as ArrayBuffer,
          "video/mp4"
        );

        await supabase.from("projects").update({ assembled_url: publicUrl }).eq("id", projectId).eq("user_id", user.id);

        send(controller, { type: "done", url: publicUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Assembly failed";
        console.error("[assemble]", message);
        send(controller, { type: "error", message });
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
