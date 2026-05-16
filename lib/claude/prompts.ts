import type { ChannelAnalysisOutput, VisualProfileOutput, ThumbnailAnalysisOutput } from "./schemas";
import type { VideoMetadata } from "@/lib/types";

function parseDuration(iso: string): string {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return "unknown";
  const h = parseInt(match[1] ?? "0", 10);
  const m = parseInt(match[2] ?? "0", 10);
  const s = parseInt(match[3] ?? "0", 10);
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !h) parts.push(`${s}s`);
  return parts.join(" ") || "unknown";
}

export function buildAnalysisPrompt(metadata: VideoMetadata[]): string {
  const videoText = metadata.map((v, i) => {
    const duration = parseDuration(v.duration);
    const engagementRate = v.viewCount > 0 ? ((v.likeCount / v.viewCount) * 100).toFixed(2) : "0";
    const published = v.publishedAt ? new Date(v.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "short" }) : "unknown";
    const comments = v.topComments.length
      ? v.topComments.slice(0, 15).map((c) => `  - "${c}"`).join("\n")
      : "  (comments unavailable)";

    return `--- VIDEO ${i + 1}: "${v.title}" ---
Duration: ${duration} | Views: ${v.viewCount.toLocaleString()} | Likes: ${v.likeCount.toLocaleString()} | Engagement: ${engagementRate}% | Published: ${published}
${v.tags.length ? `Tags: ${v.tags.slice(0, 15).join(", ")}` : ""}

DESCRIPTION:
${v.description.trim() || "(no description)"}

TOP AUDIENCE COMMENTS (what resonates with viewers):
${comments}`.trim();
  }).join("\n\n");

  return `Analyze these YouTube videos from the same channel and extract the channel's content style DNA.

You are working from video metadata — titles, descriptions, tags, engagement metrics, and top audience comments. Use these signals to infer how this creator writes, frames topics, and connects with their audience.

${videoText}

Perform STATE 4 (Channel Analysis) and STATE 5 (Style DNA Extraction):

STATE 4 — Extract:
- Niche and topic category (infer from titles, tags, descriptions)
- Target audience description (infer from language, topics, comment tone)
- Hook style: how videos open to grab attention — infer from title patterns (curiosity gap, numbered lists, fear/revelation, personal story, etc.)
- Script flow structure: infer from description structure and content type
- Sentence style: infer from description writing patterns (length, complexity, punctuation)
- Emotional pacing curve: how energy builds — infer from engagement metrics and comment sentiment
- Retention techniques: identify from title patterns (open loops, cliffhangers, transformation promises)
- Words per second: assume 1.5-2.0 WPS for talking-head content based on the niche style
- Target word count: calculate from average video duration × words per second

STATE 5 — Extract deep writing behavior (HOW it works, not what it says):
- Sentence rhythm patterns (infer from description style)
- Flow pattern (how ideas connect — linear, story-driven, list-based)
- Repetition style
- Tone (authoritative, conversational, urgent, inspirational, etc.)
- Transition phrases and patterns
- Curiosity gap techniques (infer from title patterns)
- Emotional trigger words/themes (infer from titles, tags, and what comments respond to)
- Direct address style (how they speak to "you")
- Detail level

Return a single JSON object with the extracted analysis. Be specific and actionable — these values will directly govern script generation.`;
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
  return `Generate a FULL YouTube video script for the topic: "${topic}"

STYLE DNA (MUST FOLLOW EXACTLY):
- Niche: ${analysis.niche}
- Target Word Count: ${analysis.targetWordCount} words (stay within ±5%)
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

  return `Generate 5 YouTube thumbnail concepts for this video.

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
- 5 thumbnail concepts, positions 1-5
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
