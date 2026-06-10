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

Be precise and pull from the actual text — these values will directly govern script generation.

CALL the save_channel_analysis tool with EVERY field populated. The schema requires every key — omitting any field is an error. If a transcript doesn't give you a value, estimate based on what's most plausible for this niche; never leave a field out. The complete set of required fields is:

Top-level (all required):
- niche (string)
- targetAudience (string)
- hookStyle (string)
- scriptFlow (string)
- sentenceStyle (string)
- emotionalPacingCurve (string)
- retentionTechniques (array of strings)
- wordsPerSecond (number, typically 1.5–2.5)
- targetWordCount (number, integer)
- styleDNA (object)

styleDNA must contain:
- sentenceRhythm (string)
- flowPattern (string)
- repetitionStyle (string)
- tone (string)
- transitions (string)
- curiosityGaps (string)
- emotionalTriggers (array of strings)
- directAddress (string)
- detailLevel (string)`;
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

Call the save_video_ideas tool with an "ideas" array of exactly 25 title strings. Do not write any text outside the tool call.`;
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
  mode: { video: boolean; thumbnails: boolean }
): string {
  const videoBlock = mode.video ? `Analyze the uploaded video screenshots and extract the visual style profile:
- Art style (realistic, illustrated, animated, mixed, etc.)
- Color palette (list the dominant colors with descriptions)
- Lighting style (warm, cool, dramatic, soft, divine glow, etc.)
- Camera style (close-up, wide, medium, over-shoulder, etc.)
- Composition style (centered, rule-of-thirds, dynamic angles, etc.)
- Detail level (minimal/clean, moderate, highly detailed)
- Overall mood

Return these fields inside a "visualProfile" object.` : "";

  const thumbBlock = mode.thumbnails ? `Analyze the uploaded thumbnail images and extract the thumbnail style profile:
- Text style and placement
- Composition approach
- Color contrast strategy
- Emotion triggers used

Return these fields inside a "thumbnailAnalysis" object.` : "";

  const joiner = mode.video && mode.thumbnails ? "\n\n" : "";

  return `${videoBlock}${joiner}${thumbBlock}

Call the save_visual_analysis tool with the structured profile. Be specific — these descriptions will be used as direct instructions for AI image generation. Do not write any text outside the tool call.`;
}

// Split build for prompt caching. Static block (instructions + visual
// style + per-beat fields + validation + tool call instruction) is
// identical across every chunk of a single generation run and hits
// Anthropic's ephemeral cache after the first call. Dynamic block is
// just the script chunk content. Beats are always numbered from 1
// locally; the route renumbers them to absolute beat_number values at
// persistence time so chunks can run in parallel without coordination.
export function buildImagePromptsCached(visualProfile: VisualProfileOutput): string {
  return `Identify every VISUAL BEAT in the SCRIPT CHUNK that follows this message and generate one image prompt for each.

WHAT COUNTS AS A VISUAL BEAT
A visual beat is any individual narration unit that introduces a NEW:
- Action, subject, character, or location
- Camera perspective, emotion, or object
- Historical event, statistic, date, fact, or study
- Transition, cause-and-effect relationship, or visual concept

RULES (NON-NEGOTIABLE)
1. NEVER generate visuals by scene. NEVER summarize multiple beats into a single prompt.
2. Every beat receives exactly ONE image prompt. No narration may be left without visual coverage.
3. If a sentence contains multiple distinct visual ideas, split it into multiple beats.
4. Each fact, statistic, date, location, study, or historical example gets its OWN dedicated beat.
5. Storytelling sections typically produce 1+ beats per sentence — often multiple when a sentence contains several visual changes.
6. Educational sections: each concept, mechanism, or example is its own beat with a visual that aids understanding (not generic stock).
7. Do NOT optimize for fewer prompts. Complete visual coverage is the goal.

DENSITY
- Minimum: 1 beat per sentence.
- Preferred: ~1 beat every 3–6 seconds of narration (≈10–15 words of script per beat).
- This chunk may produce many beats; long-form scripts commonly total 50–150+ across all chunks.

VISUAL STYLE
Art Style: ${visualProfile.artStyle}
Colors: ${visualProfile.colorPalette.join(", ")}
Lighting: ${visualProfile.lightingStyle}
Camera: ${visualProfile.cameraStyle}
Composition: ${visualProfile.composition}
Mood: ${visualProfile.mood}
Detail: ${visualProfile.detailLevel}

PER-BEAT FIELDS
- scriptSegment: the exact words from the script for this beat (typically 8–20 words). Must be a verbatim substring of the chunk AND must NOT overlap with adjacent beats — each beat picks up exactly where the previous beat's last word ended. Concatenating every scriptSegment in order, separated by single spaces, must reproduce the chunk verbatim. Do not repeat phrases at beat boundaries.
- imagePrompt: 1–2 cinematic sentences. Visualize the narration LITERALLY whenever possible. For abstract concepts, use concrete visual metaphors. Apply the visual style above as direct AI-image-generator instructions. Be specific (subject, action, environment, framing).
- camera: single short phrase (e.g. "tight close-up", "low-angle wide", "overhead aerial")
- lighting: single short phrase (e.g. "warm golden rim light", "cold blue moonlight")
- mood: single short phrase (e.g. "tense, urgent", "quiet, reverent")
- action: single short phrase (e.g. "subject leans forward", "dust settles after the strike")

QUALITY
- Maintain continuity between neighboring beats — characters, locations, lighting, and props carry forward unless the narration introduces a change.
- Historical sections: historically accurate environments, clothing, tools, architecture, lighting — no anachronisms.
- Educational sections: visuals must help the viewer UNDERSTAND the narration, not just decorate it.

VALIDATION (DO THIS BEFORE RETURNING)
Step 1: Walk the script chunk and identify every visual beat using the definition above.
Step 2: Count them.
Step 3: Confirm your "beats" array has exactly that many entries — one image prompt per beat.
If the counts do not match, keep adding beats until coverage is complete.

Number beats sequentially starting from 1, with no gaps. Call the save_image_prompts tool with a "beats" array. Do not write any text outside the tool call.`;
}

export function buildImagePromptsDynamic(script: string): string {
  return `SCRIPT (THIS CHUNK):\n${script}`;
}

export function buildImagePromptsPrompt(
  script: string,
  visualProfile: VisualProfileOutput,
  startBeat: number = 1
): string {
  return `Identify every VISUAL BEAT in this script chunk and generate one image prompt for each.

WHAT COUNTS AS A VISUAL BEAT
A visual beat is any individual narration unit that introduces a NEW:
- Action, subject, character, or location
- Camera perspective, emotion, or object
- Historical event, statistic, date, fact, or study
- Transition, cause-and-effect relationship, or visual concept

RULES (NON-NEGOTIABLE)
1. NEVER generate visuals by scene. NEVER summarize multiple beats into a single prompt.
2. Every beat receives exactly ONE image prompt. No narration may be left without visual coverage.
3. If a sentence contains multiple distinct visual ideas, split it into multiple beats.
4. Each fact, statistic, date, location, study, or historical example gets its OWN dedicated beat.
5. Storytelling sections typically produce 1+ beats per sentence — often multiple when a sentence contains several visual changes.
6. Educational sections: each concept, mechanism, or example is its own beat with a visual that aids understanding (not generic stock).
7. Do NOT optimize for fewer prompts. Complete visual coverage is the goal.

DENSITY
- Minimum: 1 beat per sentence.
- Preferred: ~1 beat every 3–6 seconds of narration (≈10–15 words of script per beat).
- This chunk may produce many beats; long-form scripts commonly total 50–150+ across all chunks.

SCRIPT (THIS CHUNK):
${script}

VISUAL STYLE
Art Style: ${visualProfile.artStyle}
Colors: ${visualProfile.colorPalette.join(", ")}
Lighting: ${visualProfile.lightingStyle}
Camera: ${visualProfile.cameraStyle}
Composition: ${visualProfile.composition}
Mood: ${visualProfile.mood}
Detail: ${visualProfile.detailLevel}

PER-BEAT FIELDS
- scriptSegment: the exact words from the script for this beat (typically 8–20 words). Must be a verbatim substring of the chunk above AND must NOT overlap with adjacent beats — each beat picks up exactly where the previous beat's last word ended. Concatenating every scriptSegment in order, separated by single spaces, must reproduce the chunk verbatim. Do not repeat phrases at beat boundaries.
- imagePrompt: 1–2 cinematic sentences. Visualize the narration LITERALLY whenever possible. For abstract concepts, use concrete visual metaphors. Apply the visual style above as direct AI-image-generator instructions. Be specific (subject, action, environment, framing).
- camera: single short phrase (e.g. "tight close-up", "low-angle wide", "overhead aerial")
- lighting: single short phrase (e.g. "warm golden rim light", "cold blue moonlight")
- mood: single short phrase (e.g. "tense, urgent", "quiet, reverent")
- action: single short phrase (e.g. "subject leans forward", "dust settles after the strike")

QUALITY
- Maintain continuity between neighboring beats — characters, locations, lighting, and props carry forward unless the narration introduces a change.
- Historical sections: historically accurate environments, clothing, tools, architecture, lighting — no anachronisms.
- Educational sections: visuals must help the viewer UNDERSTAND the narration, not just decorate it.

VALIDATION (DO THIS BEFORE RETURNING)
Step 1: Walk the script chunk and identify every visual beat using the definition above.
Step 2: Count them.
Step 3: Confirm your "beats" array has exactly that many entries — one image prompt per beat.
If the counts do not match, keep adding beats until coverage is complete.

Number beats sequentially starting from ${startBeat}, with no gaps. Call the save_image_prompts tool with a "beats" array. Do not write any text outside the tool call.`;
}

// Split build for prompt caching: the cached block is identical across
// all chunks of a single generation run (instructions + visual style +
// rules), so it hits the Anthropic ephemeral cache after the first call.
// Only the per-chunk beats list — the dynamic block — is re-tokenized.
export function buildVideoPromptsCached(visualProfile: VisualProfileOutput | null): string {
  const styleSection = visualProfile
    ? `CHANNEL VISUAL STYLE:
Art Style: ${visualProfile.artStyle}
Lighting: ${visualProfile.lightingStyle}
Camera Style: ${visualProfile.cameraStyle}
Mood: ${visualProfile.mood}

`
    : "";

  return `Generate a video motion prompt for each beat in the BEATS block that follows this message. Each prompt must describe camera movement and action WITHIN the exact scene from the image prompt — same subject, same environment, same lighting.

${styleSection}RULES:
- One prompt per beat — same beat numbers, no gaps
- 2 sentences: (1) camera movement, (2) subject motion and expression
- Duration: 3-5 seconds, smooth and cinematic
- Stay within the existing image scene — only add motion

Call the save_video_prompts tool with a "beats" array of { beatNumber, videoPrompt }. Do not write any text outside the tool call.`;
}

export function buildVideoPromptsDynamic(
  beats: { beatNumber: number; scriptSegment: string; imagePrompt: string }[]
): string {
  const beatList = beats
    .map((b) => `Beat ${b.beatNumber}:\n  Script: "${b.scriptSegment}"\n  Image scene: ${b.imagePrompt}`)
    .join("\n\n");
  return `BEATS:\n${beatList}`;
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

Call the save_video_prompts tool with a "beats" array of { beatNumber, videoPrompt }. Do not write any text outside the tool call.`;
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

  return `Generate EXACTLY 5 YouTube thumbnail concepts for this video. Not 3, not 4, not 6 — exactly 5. The downstream image-generation step assumes 5 concepts and will fail if any are missing.

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
- EXACTLY 5 thumbnail concepts, positions 1, 2, 3, 4, and 5 (no gaps, no duplicates)
- Each must create immediate curiosity or strong emotion
- Vary the approaches: close-up face, dramatic scene, text-heavy, before/after, reaction shot, etc.

For each thumbnail, provide:
- title: catchy text for the thumbnail title card
- visualConcept: describe the main visual scene and composition in 2-3 sentences
- textOverlay: exact text shown on thumbnail + font style + colors (e.g. "GOD IS REMOVING THEM — bold white text, red shadow, top-left")
- emotionTrigger: the core emotion this thumbnail triggers (fear, curiosity, inspiration, shock, etc.)
- stylePrompt: a COMPLETE, DETAILED AI image generation prompt for the thumbnail image (4-6 sentences). Must include: subject description, scene/background, lighting, composition, color palette, art style, text placement guidance, and technical quality tags. Write it as if you're instructing an image AI with full context — no shortcuts.

Call the save_thumbnails tool with a "thumbnails" array. Do not write any text outside the tool call.`;
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

Call the tool with "beats" array and "thumbnails" array. Do not write any text outside the tool call.`;
}
