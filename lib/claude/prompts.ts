import type { ChannelAnalysisOutput, VisualProfileOutput, ThumbnailAnalysisOutput } from "./schemas";
import type { SupadataTranscript } from "@/lib/youtube/supadata";

export function buildAnalysisPrompt(transcripts: SupadataTranscript[]): string {
  const successful = transcripts.filter((t) => t.success && t.text.length > 0);
  const failed = transcripts.filter((t) => !t.success || !t.text.length);

  const videoText = successful.map((t, i) => {
    const avgWordCount = successful.reduce((sum, s) => sum + s.wordCount, 0) / successful.length;
    return `--- VIDEO ${i + 1}: "${t.title}" ---
Word count (full transcript): ~${t.wordCount} words

TRANSCRIPT:
${t.text}`.trim();
  }).join("\n\n");

  const failedNote = failed.length
    ? `\nNote: ${failed.length} video(s) had no available transcript and were skipped.\n`
    : "";

  return `Analyze these real YouTube video transcripts from the same channel and extract the channel's content style DNA.

You are working from ACTUAL transcript text — the creator's real words, exactly as spoken. Use this to extract precise writing patterns, not inferences.

${failedNote}${videoText}

Perform STATE 4 (Channel Analysis) and STATE 5 (Style DNA Extraction):

STATE 4 — Extract:
- Niche and topic category (from transcript content and vocabulary)
- Target audience description (from language level, topics, and how the creator addresses the viewer)
- Hook style: analyze the ACTUAL opening lines of each transcript — identify the exact hook pattern used (curiosity gap, bold claim, personal story, question, numbered list, fear/urgency, etc.)
- Script flow structure: map how the video is structured from the transcript (intro → conflict/problem → content → CTA, etc.)
- Sentence style: analyze actual sentence lengths, complexity, and punctuation patterns from the text
- Emotional pacing curve: how energy and tension build across the transcript
- Retention techniques: identify exact patterns used (open loops, callbacks, cliffhangers, "stay to the end" moments)
- Words per second: estimate WPS based on transcript word count and typical video length for this niche (1.5–2.5 WPS)
- Target word count: use the actual average word count across transcripts as the baseline

STATE 5 — Extract deep writing behavior directly from the transcript text:
- Sentence rhythm patterns (short punchy bursts? long flowing sentences? mixed?)
- Flow pattern (how ideas connect — does it use contrast, building tension, storytelling, lists?)
- Repetition style (does the creator repeat key phrases for emphasis? which ones?)
- Tone (authoritative, conversational, urgent, inspirational — pull exact examples)
- Transition phrases (the actual words/phrases used to move between ideas — quote them)
- Curiosity gap techniques (exact phrasing patterns that create open loops)
- Emotional trigger words/themes (the specific words that carry emotional weight in these transcripts)
- Direct address style (how they speak to "you" — formal, intimate, commanding, friendly?)
- Detail level (abstract concepts only? specific numbers and examples? anecdotes?)

Return a single JSON object with the extracted analysis. Be precise and pull from the actual text — these values will directly govern script generation.`;
}

export function buildVideoIdeasPrompt(
  analysis: ChannelAnalysisOutput,
  topicHint?: string
): string {
  return `Based on this channel's style analysis, generate 25 video title ideas.

CHANNEL ANALYSIS:
- Niche: ${analysis.niche}
- Target Audience: ${analysis.targetAudience}
- Hook Style: ${analysis.hookStyle}
- Tone: ${analysis.styleDNA.tone}
- Emotional Triggers: ${analysis.styleDNA.emotionalTriggers.join(", ")}

${topicHint ? `TOPIC DIRECTION: ${topicHint}` : ""}

Rules:
- Each title must match the channel's hook style exactly
- Use the same emotional trigger patterns
- Vary the formats (list videos, revelation videos, warning videos, etc.)
- Make titles that create genuine curiosity gaps
- NO generic titles — each must feel native to this specific channel

Return a JSON object with an "ideas" array of exactly 25 title strings.`;
}

export function buildScriptPrompt(
  analysis: ChannelAnalysisOutput,
  topic: string
): string {
  const targetWordCount = analysis.targetWordCount ?? 900;
  return `Generate a FULL YouTube video script for the topic: "${topic}"

STYLE DNA (MUST FOLLOW EXACTLY):
- Niche: ${analysis.niche}
- Target Word Count: ${targetWordCount} words (stay within ±5%)
- Words Per Second: ${analysis.wordsPerSecond} WPS
- Hook Style: ${analysis.hookStyle}
- Sentence Style: ${analysis.sentenceStyle}
- Script Flow: ${analysis.scriptFlow}
- Emotional Pacing: ${analysis.emotionalPacingCurve}
- Tone: ${analysis.styleDNA.tone}
- Sentence Rhythm: ${analysis.styleDNA.sentenceRhythm}
- Flow Pattern: ${analysis.styleDNA.flowPattern}
- Repetition Style: ${analysis.styleDNA.repetitionStyle}
- Transitions: ${analysis.styleDNA.transitions}
- Curiosity Gaps: ${analysis.styleDNA.curiosityGaps}
- Emotional Triggers: ${analysis.styleDNA.emotionalTriggers.join(", ")}
- Direct Address: ${analysis.styleDNA.directAddress}
- Detail Level: ${analysis.styleDNA.detailLevel}
- Retention Techniques: ${analysis.retentionTechniques.join(", ")}

RULES:
- Write ONLY the script — no headers, no stage directions, no notes
- Match the style DNA above exactly — rhythm, sentence length, emotional arc
- DO NOT think about visuals or images
- End with a natural CTA (subscribe, like, share) in the channel's tone
- NEVER copy wording from source transcripts — be fully original

Begin writing the script now. Output ONLY the script text.`;
}

export function buildVisualAnalysisPrompt(
  includesThumbnails: boolean
): string {
  return `Analyze the uploaded video screenshots and extract the visual style profile.

Analyze and extract:
- Art style (realistic, illustrated, animated, mixed, etc.)
- Color palette (list the dominant colors with descriptions)
- Lighting style (warm, cool, dramatic, soft, divine glow, etc.)
- Camera style (close-up, wide, medium, over-shoulder, etc.)
- Composition style (centered, rule-of-thirds, dynamic angles, etc.)
- Detail level (minimal/clean, moderate, highly detailed)
- Overall mood

${includesThumbnails ? `Also analyze the thumbnail images separately:
- Text style and placement
- Composition approach
- Color contrast strategy
- Emotion triggers used` : ""}

Return a JSON object with the visual profile. Be specific — these descriptions will be used as direct instructions for AI image generation.`;
}

export function buildImagePromptsPrompt(
  script: string,
  visualProfile: VisualProfileOutput,
  startBeat: number = 1,
  targetBeats: number = 8
): string {
  return `Split this script portion into beats (aim for around ${targetBeats}, but use as many as needed to cover all content — minimum 1) and generate an image prompt for each beat.

SCRIPT:
${script}

VISUAL STYLE:
Art Style: ${visualProfile.artStyle}
Colors: ${visualProfile.colorPalette.join(", ")}
Lighting: ${visualProfile.lightingStyle}
Camera: ${visualProfile.cameraStyle}
Composition: ${visualProfile.composition}
Mood: ${visualProfile.mood}
Detail: ${visualProfile.detailLevel}

FIELD RULES:
- scriptSegment: exact words from the script for that beat (~20-25 words)
- imagePrompt: 1-2 sentences. Describe the specific scene, subject, and action. Apply the visual style above — incorporate the art style, colors, lighting, and camera as a direct AI image generator prompt.
- camera: single short phrase (e.g. "tight close-up")
- lighting: single short phrase (e.g. "warm golden rim light")
- mood: single short phrase (e.g. "tense, urgent")
- action: single short phrase (e.g. "subject leans forward")

Number beats from ${startBeat}, no gaps. Return a JSON object with a "beats" array.`;
}

export function buildVideoPromptsPrompt(
  beats: { beatNumber: number; scriptSegment: string; imagePrompt: string }[],
  visualProfile: VisualProfileOutput | null
): string {
  const beatList = beats
    .map((b) => `Beat ${b.beatNumber}:\n  Script: "${b.scriptSegment}"\n  Image scene: ${b.imagePrompt}`)
    .join("\n\n");

  const styleSection = visualProfile
    ? `CHANNEL VISUAL STYLE:
Art Style: ${visualProfile.artStyle}
Lighting: ${visualProfile.lightingStyle}
Camera Style: ${visualProfile.cameraStyle}
Mood: ${visualProfile.mood}

`
    : "";

  return `Generate a video motion prompt for each beat below. Each prompt must describe camera movement and action WITHIN the exact scene from the image prompt — same subject, same environment, same lighting.

${styleSection}BEATS:
${beatList}

RULES:
- One prompt per beat — same beat numbers, no gaps
- 2 sentences: (1) camera movement, (2) subject motion and expression
- Duration: 3-5 seconds, smooth and cinematic
- Stay within the existing image scene — only add motion

Return a JSON object with a "beats" array of { beatNumber, videoPrompt }.`;
}

export function buildThumbnailsPrompt(
  script: string,
  visualProfile: VisualProfileOutput,
  thumbnailAnalysis?: ThumbnailAnalysisOutput
): string {
  const visualStyle = `Art Style: ${visualProfile.artStyle}
Color Palette: ${visualProfile.colorPalette.join(", ")}
Lighting: ${visualProfile.lightingStyle}
Camera: ${visualProfile.cameraStyle}
Composition: ${visualProfile.composition}
Mood: ${visualProfile.mood}
Detail: ${visualProfile.detailLevel}`;

  const maxThumbnails = parseInt(process.env.MAX_THUMBNAILS ?? "5", 10);
  return `Generate ${maxThumbnails} YouTube thumbnail concepts for this video.

SCRIPT SUMMARY (first 300 words):
${script.split(" ").slice(0, 300).join(" ")}...

VISUAL STYLE PROFILE:
${visualStyle}

${thumbnailAnalysis ? `THUMBNAIL ANALYSIS (match this channel's thumbnail style exactly):
- Text style: ${thumbnailAnalysis.textStyle}
- Composition: ${thumbnailAnalysis.composition}
- Color contrast: ${thumbnailAnalysis.colorContrast}
- Emotion triggers: ${thumbnailAnalysis.emotionTriggers.join(", ")}` : "Match the channel's visual style."}

RULES:
- ${maxThumbnails} thumbnail concepts, positions 1-${maxThumbnails}
- Each must create immediate curiosity or strong emotion
- Vary the approaches: close-up face, dramatic scene, text-heavy, before/after, reaction shot, etc.

For each thumbnail, provide:
- title: catchy text for the thumbnail title card
- visualConcept: describe the main visual scene and composition in 2-3 sentences
- textOverlay: exact text shown on thumbnail + font style + colors (e.g. "GOD IS REMOVING THEM — bold white text, red shadow, top-left")
- emotionTrigger: the core emotion this thumbnail triggers (fear, curiosity, inspiration, shock, etc.)
- stylePrompt: a COMPLETE, DETAILED AI image generation prompt for the thumbnail image (4-6 sentences). Must include: subject description, scene/background, lighting, composition, color palette, art style, text placement guidance, and technical quality tags. Write it as if you're instructing an image AI with full context — no shortcuts.

Return a JSON object with a "thumbnails" array.`;
}

export function buildPromptsPrompt(
  script: string,
  visualProfile: VisualProfileOutput,
  includeVideoPrompts: boolean,
  thumbnailAnalysis?: ThumbnailAnalysisOutput
): string {
  const visualStyle = `Art Style: ${visualProfile.artStyle}
Color Palette: ${visualProfile.colorPalette.join(", ")}
Lighting: ${visualProfile.lightingStyle}
Camera: ${visualProfile.cameraStyle}
Composition: ${visualProfile.composition}
Mood: ${visualProfile.mood}
Detail: ${visualProfile.detailLevel}`;

  return `Generate image prompts for every script beat, plus 5 thumbnail concepts.

SCRIPT:
${script}

VISUAL STYLE PROFILE (use in EVERY prompt):
${visualStyle}

BEAT RULES:
- Split the script into exactly 30-40 beats total (aim for 36)
- Each beat covers approximately 20-30 words of script
- Number beats sequentially from 1
- Each image prompt MUST be fully standalone — describe the complete scene
- Every prompt must include: subject, environment, lighting, mood, camera angle, art style
- Follow the visual style profile exactly in every single prompt
- Do NOT skip any part of the script — cover the entire script evenly

${includeVideoPrompts ? `VIDEO PROMPT RULES (generate for every beat):
- Add camera movement (dolly in, push, pan, crane, static)
- Duration: 3-5 seconds
- Describe the motion and action happening
- Keep cinematic and smooth` : ""}

THUMBNAIL RULES (generate 5 concepts):
${thumbnailAnalysis ? `Based on thumbnail analysis:
- Text style: ${thumbnailAnalysis.textStyle}
- Composition: ${thumbnailAnalysis.composition}
- Color contrast: ${thumbnailAnalysis.colorContrast}
- Emotion triggers: ${thumbnailAnalysis.emotionTriggers.join(", ")}` : "Match the channel's visual style"}
- Each thumbnail needs: title, visual concept, text overlay with colors, emotion trigger, full style-matched prompt

Return a JSON object with "beats" array and "thumbnails" array.`;
}
