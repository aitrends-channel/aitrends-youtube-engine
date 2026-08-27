import type { ChannelAnalysisOutput, VisualProfileOutput, ThumbnailAnalysisOutput } from "./schemas";
import type { SupadataTranscript } from "@/lib/youtube/supadata";

// Mirror of the channel-page 45-min consent gate. When the channel's
// avg video length is past this, the user opts past the warning at the
// channel step — but the analysis still returns the channel's true
// (longer) average word count. For script generation we cap the target
// here so the produced script lands at <=45min of video regardless of
// the source channel's natural length. A no-op for channels already
// under the threshold.
export const MAX_SCRIPT_DURATION_SECONDS = 45 * 60;

// Fallback WPS when analysis.wordsPerSecond is missing/zero. 2 is the
// middle of the 1.5–2.5 band the analysis prompt asks Claude to pick
// from, so a missing value still produces a sensible cap.
const FALLBACK_WORDS_PER_SECOND = 2;

export function getEffectiveScriptTargetWordCount(
  analysis: Pick<ChannelAnalysisOutput, "targetWordCount" | "wordsPerSecond">
): number {
  const baseTarget = analysis.targetWordCount && analysis.targetWordCount > 0
    ? analysis.targetWordCount
    : 900;
  const wps = analysis.wordsPerSecond && analysis.wordsPerSecond > 0
    ? analysis.wordsPerSecond
    : FALLBACK_WORDS_PER_SECOND;
  const maxWords = Math.floor(MAX_SCRIPT_DURATION_SECONDS * wps);
  return Math.min(baseTarget, maxWords);
}

// Long videos (1hr+ source content) produce 10-15k-word transcripts.
// Sending several of those concatenated tips KIE's proxy past whatever
// internal budget makes it return a generic 500. Sample each transcript
// down to ~6000 words — head for the hook + opening cadence, tail for
// the CTA / closer — preserving the signal the style-DNA prompt
// actually keys on while keeping each video bounded.
const PER_TRANSCRIPT_WORD_CAP = 15000;
const HEAD_RATIO = 0.75;

function sampleTranscript(text: string): { text: string; sampled: boolean; sampledWordCount: number } {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= PER_TRANSCRIPT_WORD_CAP) {
    return { text, sampled: false, sampledWordCount: words.length };
  }
  const headSize = Math.floor(PER_TRANSCRIPT_WORD_CAP * HEAD_RATIO);
  const tailSize = PER_TRANSCRIPT_WORD_CAP - headSize;
  const head = words.slice(0, headSize).join(" ");
  const tail = words.slice(-tailSize).join(" ");
  return {
    text: `${head}\n\n[... middle of video omitted for length — sample resumes near the end ...]\n\n${tail}`,
    sampled: true,
    sampledWordCount: PER_TRANSCRIPT_WORD_CAP,
  };
}

export function buildAnalysisPrompt(transcripts: SupadataTranscript[]): string {
  const successful = transcripts.filter((t) => t.success && t.text.length > 0);
  const failed = transcripts.filter((t) => !t.success || !t.text.length);

  const videoText = successful.map((t, i) => {
    const sample = sampleTranscript(t.text);
    const wordLine = sample.sampled
      ? `Word count: ${t.wordCount} full / ${sample.sampledWordCount} sampled (head + tail)`
      : `Word count (full transcript): ~${t.wordCount} words`;
    return `--- VIDEO ${i + 1}: "${t.title}" ---
${wordLine}

TRANSCRIPT:
${sample.text}`.trim();
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
  topicHint?: string,
  // Top-performing existing titles from the channel. We feed these as
  // STYLE REFERENCE (not topic copies) so Claude can match the exact
  // capitalization rhythm, punctuation tics, hook syntax — patterns
  // the analysis prose loses. Cap at 10 to stay within budget and
  // because the long tail of top videos drifts from current style.
  topVideoTitles?: string[],
  // Existing ideas already in this project's list. Passed so Claude
  // doesn't regenerate near-duplicates on a "Generate More Ideas"
  // click. Client dedupes too as a safety net.
  excludeTitles?: string[],
): string {
  const refBlock = topVideoTitles && topVideoTitles.length
    ? `\nREFERENCE TITLES — the channel's top videos. Match their syntax / capitalization / hook style; do NOT reuse their topics:\n${topVideoTitles.slice(0, 10).map((t) => `- ${t}`).join("\n")}\n`
    : "";
  const excludeBlock = excludeTitles && excludeTitles.length
    ? `\nALREADY-GENERATED TITLES — do NOT produce these or close paraphrases:\n${excludeTitles.slice(0, 100).map((t) => `- ${t}`).join("\n")}\n`
    : "";
  return `Based on this channel's style analysis, generate 25 video title ideas.

CHANNEL ANALYSIS:
- Niche: ${analysis.niche}
- Target Audience: ${analysis.targetAudience}
- Hook Style: ${analysis.hookStyle}
- Tone: ${analysis.styleDNA.tone}
- Emotional Triggers: ${analysis.styleDNA.emotionalTriggers.join(", ")}
${refBlock}${excludeBlock}
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
  const targetWordCount = getEffectiveScriptTargetWordCount(analysis);
  // When the channel's natural average exceeds the 45-min consent gate
  // we ship a shorter target than analysis.targetWordCount. The model
  // must still go through the channel's full arc — opening hook, middle
  // development, ending CTA — just paced tighter. Without this note the
  // model tends to drop the middle development section or skip the
  // signature ending move when asked to compress.
  const isCompressed = (analysis.targetWordCount ?? 0) > targetWordCount;
  const compressionNote = isCompressed
    ? `\nNOTE: The channel's natural videos run longer than this target, but the script must still walk the FULL channel arc — same opening hook style, same middle development pattern, same signature ending / CTA move. Compress the pacing, never the structure. Do NOT drop or shorten the middle section to land on the word count; trim everywhere proportionally.\n`
    : "";
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
${compressionNote}
ARC STRUCTURE (MANDATORY — preserve all three phases):
- BEGINNING: open with the channel's exact Hook Style above; set up the curiosity gap or stakes the same way the channel does.
- MIDDLE: develop the topic following the channel's Script Flow and Emotional Pacing above — same beats, same callbacks, same retention techniques. This is the section that gets compressed when length is tight; it does NOT get cut.
- END: close with the channel's signature ending move, then a natural CTA (subscribe, like, share) in the channel's Tone and Direct Address style.

RULES:
- Write ONLY the script — no headers, no stage directions, no notes
- Match the style DNA above exactly — rhythm, sentence length, emotional arc
- Preserve the full beginning → middle → end arc regardless of target length
- DO NOT think about visuals or images
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

// Optional prompt-style variant driver. The Prompts step lets the user
// pick between "general" (default) and "cinematic". Cinematic uses a
// completely different beat-splitting rubric that produces fewer,
// longer-held shots (~1 beat every 6–10s vs the general ~1 per 3–6s)
// and adds a validation pass targeting pacing. The extracted visual
// profile is still substituted into VISUAL STYLE — only the beat-
// definition rules and per-beat guidance change. Unknown values are
// treated as "general" so old rows and future values stay safe.
export type PromptStyle = "general" | "cinematic";

function renderVisualStyleBlock(visualProfile: VisualProfileOutput): string {
  return `Art Style: ${visualProfile.artStyle}
Colors: ${visualProfile.colorPalette.join(", ")}
Lighting: ${visualProfile.lightingStyle}
Camera: ${visualProfile.cameraStyle}
Composition: ${visualProfile.composition}
Mood: ${visualProfile.mood}
Detail: ${visualProfile.detailLevel}`;
}

// Each generated image prompt is sent to the image generator ALONE —
// with no memory of the other prompts, the script, or the style guide.
// So any reliance on shared context makes character appearance and art
// style drift between shots. These shared blocks force every prompt to
// be fully self-contained: the model locks canonical descriptions once
// (Step 0) and repeats them VERBATIM in every prompt they appear in.
const CONSISTENCY_SHEET_BLOCK = `STEP 0 — BUILD A LOCKED CONSISTENCY SHEET (DO THIS FIRST, BEFORE ANY BEATS)
Before writing a single image prompt, build a consistency sheet you will reuse VERBATIM:
- RECURRING CHARACTERS: for every character who appears more than once, write ONE fixed ~25–40 word description covering age, gender, ethnicity/skin tone, build/height, hair (color, length, style), eyes, distinguishing features (scars, glasses, tattoos), and their exact default outfit (garments, colors, materials). This exact wording is that character's lock.
- LOCATIONS: for every recurring location, write ONE fixed ~15–25 word description (architecture, era, materials, defining features).
- STYLE TAG: write ONE locked style-tag string for the rendering mode — art style, medium, full color palette WITH hex codes where a specific color matters, and the base lighting treatment.
Paste each locked description WORD-FOR-WORD into every prompt where that character, location, or mode appears. Paraphrasing changes the rendered face — never reword, shorten, or vary a locked description between beats.`;

const SELF_CONTAINED_IMAGE_PROMPT_FIELD = `- imagePrompt: 1–2 sentences forming a COMPLETE, SELF-CONTAINED image-generation prompt — the single strongest image for this moment. The image model receives this ONE prompt with NO memory of other beats, the script, or any style guide, so everything needed must be inside it:
    • Embed the full STYLE TAG from your consistency sheet (art style, medium, color palette with hex codes, lighting) — never assume a shared style guide.
    • For EVERY character in frame, paste their FULL locked physical description VERBATIM (age, gender, ethnicity/skin tone, build, hair, eyes, distinguishing features, exact outfit) — every single time they appear, even if they were in the previous beat.
    • State the full location/environment plus the specific action and framing for this shot.
  Visualize the narration literally where possible; for abstract ideas use a concrete visual metaphor.`;

const SELF_CONTAINED_QUALITY_RULES = `- SELF-CONTAINED ONLY — never reference other beats or prior context. BAN "the same man/woman", "as before", "as previously described", "continuing from", "the aforementioned", "returns/reappears", and any pronoun (he/she/they/it) whose subject isn't fully described earlier in THIS prompt. If a character or place recurs, RE-STATE its full locked description.
- Consistency comes from REPEATING the locked descriptions verbatim, not from carrying context forward — identical inputs must yield identical renders.`;

// When a whole-script consistency sheet has been generated up front, we
// inject it verbatim so every chunk reuses identical descriptions (true
// cross-chunk consistency). Without one, fall back to having the model
// build its own — still self-contained, but that sheet only spans the
// current chunk.
function consistencyBlock(sheet?: string): string {
  const trimmed = sheet?.trim();
  if (!trimmed) return CONSISTENCY_SHEET_BLOCK;
  return `LOCKED CONSISTENCY SHEET — reuse these descriptions VERBATIM (built once for the WHOLE script)
${trimmed}

When any listed character or location appears in a beat, paste its description WORD-FOR-WORD into that prompt, and apply the STYLE TAG to every prompt. Never reword, shorten, or vary a locked description — paraphrasing changes the rendered face. If something isn't listed, describe it fully and keep it consistent yourself.`;
}

// One-shot prompt that produces the whole-script consistency sheet. The
// route runs this once (full script + visual style) BEFORE chunking, so
// every chunk reuses identical character/location/style wording instead
// of each chunk inventing its own.
export function buildConsistencySheetPrompt(script: string, visualProfile: VisualProfileOutput): string {
  return `Build a LOCKED CONSISTENCY SHEET for an AI image pipeline. Every shot of the video below is drawn by an image model with NO memory of the other shots, so one canonical description of each recurring character, location, and the rendering style must be written ONCE here and reused verbatim in every prompt.

Read the FULL script and the visual style, then output plain text with exactly these sections:

RECURRING CHARACTERS
For every character who appears more than once, one entry: "<name or label>: <~25–40 word description>" covering age, gender, ethnicity/skin tone, build/height, hair (color, length, style), eyes, distinguishing features (scars, glasses, tattoos), and exact default outfit (garments, colors, materials).

RECURRING LOCATIONS
For every recurring location, one entry: "<name>: <~15–25 word description>" (architecture, era, materials, defining features).

STYLE TAG
One entry: the locked rendering style — art style, medium, full color palette WITH hex codes where a specific color matters, and base lighting.

RULES
- Base everything on the script and the visual style below; invent specifics only where the script is silent, keeping them plausible and internally consistent.
- Include only characters/locations that RECUR; skip one-off background figures.
- Be concrete so the identical words always render the identical subject.
- Output ONLY the sheet text — no preamble, no commentary, no markdown beyond the three section labels above.

VISUAL STYLE
${renderVisualStyleBlock(visualProfile)}

FULL SCRIPT
${script}`;
}

// Vision prompt: given a user-uploaded image for a beat, derive both an
// image prompt (that would recreate it) and a video motion prompt (to
// animate it). Used when a user manually uploads a beat image so the
// beat's prompts match the actual picture instead of the stale
// script-derived text. The image itself is attached as a separate
// content block by the caller.
export function buildPromptsFromImagePrompt(visualProfile: VisualProfileOutput | null): string {
  return `The attached image is the source frame for ONE beat of a video. Study it, then produce TWO prompts describing THIS image.

1) imagePrompt — a COMPLETE, SELF-CONTAINED text-to-image prompt that would recreate this exact image. Include:
   - Every subject in frame. For people: age, gender, ethnicity/skin tone, build, hair (color/length/style), eyes, distinguishing features, and exact outfit (garments, colors).
   - The setting/environment and the composition/framing.
   - The art style, medium, lighting, and color palette (with hex codes where a specific color matters).
   The image model has NO other context, so everything must be inside this one prompt — never say "the same", "as before", or use pronouns without an in-prompt antecedent.

2) videoPrompt — 1–2 sentences of camera movement + action to animate THIS image for a short image-to-video clip (e.g. "slow push-in as dust drifts across the frame"). Stay true to the image's subject, environment, and lighting; describe motion only, not a new scene.
${visualProfile ? `\nMatch this channel's visual style where the image is consistent with it:\nVISUAL STYLE\n${renderVisualStyleBlock(visualProfile)}\n` : ""}
Call the save_prompts tool with imagePrompt and videoPrompt. Do not write anything outside the tool call.`;
}

// Cinematic mode: fewer, longer-held shots; the model is instructed
// to prefer sustained camera moves over cuts. See the general variant
// in buildImagePromptsCached for the standard "1 beat per sentence"
// rubric.
function buildImagePromptsCachedCinematic(visualProfile: VisualProfileOutput, consistencySheet?: string): string {
  return `Identify every VISUAL BEAT in the SCRIPT CHUNK that follows this message and generate one image prompt for each.

${consistencyBlock(consistencySheet)}

WHAT COUNTS AS A VISUAL BEAT
A visual beat is ONE CONTINUOUS SHOT the viewer watches — not one fact or one sentence. Split by what the CAMERA sees, not by grammar. A new beat begins ONLY when the shot must change:
- A new subject, character, or location enters the frame
- The action or setting changes in a way one shot cannot contain
- A new camera perspective is required (cutting from wide to close-up for a reveal or emotional moment)
- A distinct fact, statistic, date, or historical event requires its own dedicated visual
- A deliberate dramatic cut (reveal, shock, punchline)

WHAT DOES NOT START A NEW BEAT
- A sentence that continues the same subject, location, and action
- Elaboration, restatement, or rhetorical repetition of the current idea
- Emotional build within a single moment — sustain the shot and note the shift in the "action" field instead of cutting
- Descriptive detail about something already on screen

RULES (NON-NEGOTIABLE)
1. Every beat receives exactly ONE image prompt. No narration may be left without visual coverage.
2. One shot MAY span multiple sentences when they describe the same continuous moment (same subject, same location, same action arc). Merging such sentences into a single beat is correct, not lazy.
3. Prefer FEWER, longer-held shots. Let images breathe — use camera direction (slow push-in, lingering wide, slow pan, hold on face) to sustain a moment rather than cutting.
4. Each distinct fact, statistic, date, location, study, or historical example still gets its OWN dedicated beat.
5. Punch cuts (very short beats under ~10 words) are allowed ONLY for deliberate reveals, jokes, or shocks — use sparingly.
6. Do NOT chop a single dramatic moment into multiple beats. Fast cutting destroys cinematic pacing.
7. Do NOT leave any narration uncovered. Complete visual coverage is still required — beats are longer, not fewer in coverage.

DENSITY
- Target: ~1 beat every 6–10 seconds of narration (≈20–35 words of script per beat).
- Minimum beat length: ~10 words (unless a deliberate punch cut per Rule 5).
- Maximum beat length: ~35 words (≈10 seconds) — if a passage exceeds this, split at the most natural visual change.
- A cinematic chunk should produce noticeably FEWER beats than an educational chunk of the same length.

VISUAL STYLE
${renderVisualStyleBlock(visualProfile)}

PER-BEAT FIELDS
- scriptSegment: the exact words from the script for this beat (typically 20–35 words; may be shorter only for deliberate punch cuts). Must be a verbatim substring of the chunk AND must NOT overlap with adjacent beats — each beat picks up exactly where the previous beat's last word ended. Concatenating every scriptSegment in order, separated by single spaces, must reproduce the chunk verbatim. Do not repeat phrases at beat boundaries.
${SELF_CONTAINED_IMAGE_PROMPT_FIELD}
- camera: single short phrase, favoring sustained moves for held shots (e.g. "slow push-in on face", "lingering static wide", "slow lateral pan", "gradual pull-back reveal")
- lighting: single short phrase (e.g. "warm golden rim light", "cold blue moonlight")
- mood: single short phrase (e.g. "tense, urgent", "quiet, reverent")
- action: single short phrase describing what unfolds WITHIN the held shot, including emotional shifts (e.g. "subject slowly lowers their head", "fire dims as the group falls silent")

QUALITY
${SELF_CONTAINED_QUALITY_RULES}
- Historical sections: historically accurate environments, clothing, tools, architecture, lighting — no anachronisms.
- Every image must be strong enough to hold the screen for 6–10 seconds. Prioritize composition, emotion, and atmosphere over informational density.

VALIDATION (DO THIS BEFORE RETURNING)
Step 1: Walk the script chunk and identify every visual beat using the SHOT definition above.
Step 2: Confirm concatenating every scriptSegment in order reproduces the chunk verbatim with no gaps or overlaps.
Step 3: Estimate each beat's duration (word count ÷ 2.5 ≈ seconds). If 3 or more consecutive beats fall under ~5 seconds and none are deliberate punch cuts, MERGE them until pacing targets are met.
Step 4: Confirm no beat exceeds ~35 words; split any that do at the most natural visual change.
Step 5: Confirm your "beats" array has exactly one entry per beat.

Number beats sequentially starting from 1, with no gaps. Call the save_image_prompts tool with a "beats" array. Do not write any text outside the tool call.`;
}

// Split build for prompt caching. Static block (instructions + visual
// style + per-beat fields + validation + tool call instruction) is
// identical across every chunk of a single generation run and hits
// Anthropic's ephemeral cache after the first call. Dynamic block is
// just the script chunk content. Beats are always numbered from 1
// locally; the route renumbers them to absolute beat_number values at
// persistence time so chunks can run in parallel without coordination.
//
// promptStyle: appending the cinematic block still hits the same
// ephemeral cache within a run (all chunks share the same style),
// but a style change between runs is a cache miss by design — the
// prefix genuinely differs.
export function buildImagePromptsCached(visualProfile: VisualProfileOutput, promptStyle: PromptStyle = "general", consistencySheet?: string): string {
  if (promptStyle === "cinematic") return buildImagePromptsCachedCinematic(visualProfile, consistencySheet);
  return `Identify every VISUAL BEAT in the SCRIPT CHUNK that follows this message and generate one image prompt for each.

${consistencyBlock(consistencySheet)}

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
${renderVisualStyleBlock(visualProfile)}

PER-BEAT FIELDS
- scriptSegment: the exact words from the script for this beat (typically 8–20 words). Must be a verbatim substring of the chunk AND must NOT overlap with adjacent beats — each beat picks up exactly where the previous beat's last word ended. Concatenating every scriptSegment in order, separated by single spaces, must reproduce the chunk verbatim. Do not repeat phrases at beat boundaries.
${SELF_CONTAINED_IMAGE_PROMPT_FIELD}
- camera: single short phrase (e.g. "tight close-up", "low-angle wide", "overhead aerial")
- lighting: single short phrase (e.g. "warm golden rim light", "cold blue moonlight")
- mood: single short phrase (e.g. "tense, urgent", "quiet, reverent")
- action: single short phrase (e.g. "subject leans forward", "dust settles after the strike")

QUALITY
${SELF_CONTAINED_QUALITY_RULES}
- Historical sections: historically accurate environments, clothing, tools, architecture, lighting — no anachronisms.
- Educational sections: visuals must help the viewer UNDERSTAND the narration, not just decorate it.

VALIDATION (DO THIS BEFORE RETURNING)
Step 1: Walk the script chunk and identify every visual beat using the definition above.
Step 2: Count them.
Step 3: Confirm your "beats" array has exactly that many entries — one image prompt per beat.
If the counts do not match, keep adding beats until coverage is complete.

Number beats sequentially starting from 1, with no gaps. Call the save_image_prompts tool with a "beats" array. Do not write any text outside the tool call.`;
}

// Step 2 of the three-step flow: prompts for beats that ALREADY exist. The
// style, consistency and quality rules are the same ones the combined pass
// uses — only the segmentation instructions are gone, because the segments
// are an input here rather than an output. The model is told to key its
// answer by beat number and never to re-cut or reword a segment, since the
// user may have merged beats and that decision has to survive.
//
// promptStyle still matters here even though segmentation is fixed: Cinematic
// asks for sustained camera moves and images that can hold the screen for
// 6-10 seconds, which is prompt WORDING, not boundaries. Only the three lines
// that differ between the combined general and cinematic prompts are swapped —
// duplicating the whole block for them would just invite the two to drift.
export function buildFillPromptsCached(
  visualProfile: VisualProfileOutput,
  promptStyle: PromptStyle = "general",
  consistencySheet?: string,
): string {
  const cinematic = promptStyle === "cinematic";
  const cameraField = cinematic
    ? `- camera: single short phrase, favoring sustained moves for held shots (e.g. "slow push-in on face", "lingering static wide", "slow lateral pan", "gradual pull-back reveal")`
    : `- camera: single short phrase (e.g. "tight close-up", "low-angle wide", "overhead aerial")`;
  const actionField = cinematic
    ? `- action: single short phrase describing what unfolds WITHIN the held shot, including emotional shifts (e.g. "subject slowly lowers their head", "fire dims as the group falls silent")`
    : `- action: single short phrase (e.g. "subject leans forward", "dust settles after the strike")`;
  const closingQuality = cinematic
    ? `- Every image must be strong enough to hold the screen for 6–10 seconds. Prioritize composition, emotion, and atmosphere over informational density.`
    : `- Educational sections: visuals must help the viewer UNDERSTAND the narration, not just decorate it.`;
  return `You will be given a numbered list of SCRIPT BEATS. Write one image prompt for EACH beat.

${consistencyBlock(consistencySheet)}

RULES (NON-NEGOTIABLE)
1. The segmentation is FIXED. Never merge, split, reorder, reword or re-cut a beat.
2. Return exactly one entry per beat you were given, addressed by its beatNumber.
3. Never invent beat numbers that were not in the input, and never omit one.
4. Treat each beat's text as the whole of what is narrated over that image.

VISUAL STYLE
${renderVisualStyleBlock(visualProfile)}

PER-BEAT FIELDS
${SELF_CONTAINED_IMAGE_PROMPT_FIELD}
${cameraField}
- lighting: single short phrase (e.g. "warm golden rim light", "cold blue moonlight")
- mood: single short phrase (e.g. "tense, urgent", "quiet, reverent")
${actionField}

QUALITY
${SELF_CONTAINED_QUALITY_RULES}
- Historical sections: historically accurate environments, clothing, tools, architecture, lighting — no anachronisms.
${closingQuality}

VALIDATION (DO THIS BEFORE RETURNING)
Count the beats you were given. Confirm your "beats" array has exactly that many entries and that every beatNumber matches one from the input.

Call the save_fill_prompts tool with a "beats" array. Do not write any text outside the tool call.`;
}

export function buildFillPromptsDynamic(beats: { beatNumber: number; scriptSegment: string }[]): string {
  return `SCRIPT BEATS (write one image prompt per beat, keyed by beatNumber):\n${
    beats.map((b) => `${b.beatNumber}. ${b.scriptSegment}`).join("\n")
  }`;
}

// Step 1 of the three-step flow: segmentation only. The beat DEFINITION, RULES
// and DENSITY text below are copied verbatim from buildImagePromptsCached on
// purpose — the boundaries this pass produces must match what the combined
// pass produced, or splitting the step would quietly change every downstream
// image. Only the per-beat fields differ: no visual style, no camera/lighting/
// mood/action, which is what makes this call cheap.
//
// Segmentation is style-dependent, which is easy to miss: the Cinematic
// prompt does not merely reword prompts, it changes where beats START and END
// (~20-35 words per held shot, "prefer fewer, longer-held shots") against
// General's ~10-15. A beats pass that ignored promptStyle would hand Cinematic
// projects educational-density beats and no later step could recover it.
export function buildBeatsCached(promptStyle: PromptStyle = "general"): string {
  if (promptStyle === "cinematic") {
    return `Split the SCRIPT CHUNK that follows this message into VISUAL BEATS. Do not write image prompts — segmentation only.

WHAT COUNTS AS A VISUAL BEAT
A visual beat is ONE CONTINUOUS SHOT the viewer watches — not one fact or one sentence. Split by what the CAMERA sees, not by grammar. A new beat begins ONLY when the shot must change:
- A new subject, character, or location enters the frame
- The action or setting changes in a way one shot cannot contain
- A new camera perspective is required (cutting from wide to close-up for a reveal or emotional moment)
- A distinct fact, statistic, date, or historical event requires its own dedicated visual
- A deliberate dramatic cut (reveal, shock, punchline)

WHAT DOES NOT START A NEW BEAT
- A sentence that continues the same subject, location, and action
- Elaboration, restatement, or rhetorical repetition of the current idea
- Emotional build within a single moment — sustain the shot rather than cutting
- Descriptive detail about something already on screen

RULES (NON-NEGOTIABLE)
1. One shot MAY span multiple sentences when they describe the same continuous moment. Merging such sentences into a single beat is correct, not lazy.
2. Prefer FEWER, longer-held shots.
3. Each distinct fact, statistic, date, location, study, or historical example still gets its OWN dedicated beat.
4. HARD FLOOR: no beat may be shorter than 10 words, including reveals, jokes and shocks. A punch line rides with the line beside it rather than becoming a beat of its own.
5. Do NOT chop a single dramatic moment into multiple beats.
6. Do NOT leave any narration uncovered.

DENSITY
- Target: ~1 beat every 6–10 seconds of narration (≈20–35 words of script per beat).
- Minimum beat length: 10 words, with no exceptions.
- Maximum beat length: ~35 words — if a passage exceeds this, split at the most natural visual change.

PER-BEAT FIELDS
- scriptSegment: the exact words from the script for this beat (typically 20–35 words, never fewer than 10). Must be a verbatim substring of the chunk AND must NOT overlap with adjacent beats — each beat picks up exactly where the previous beat's last word ended. Concatenating every scriptSegment in order, separated by single spaces, must reproduce the chunk verbatim.

VALIDATION (DO THIS BEFORE RETURNING)
Step 1: Walk the chunk and identify every beat using the SHOT definition above.
Step 2: Confirm concatenating every scriptSegment in order reproduces the chunk verbatim, with no gaps and no overlaps.
Step 3: Count the words in every segment. Any segment under 10 words must be joined to the beat before it (or after it, if it is the first) and the array rebuilt.
Step 4: Confirm no beat exceeds ~35 words.

Number beats sequentially starting from 1, with no gaps. Call the save_beats tool with a "beats" array. Do not write any text outside the tool call.`;
  }
  return `Split the SCRIPT CHUNK that follows this message into VISUAL BEATS. Do not write image prompts — segmentation only.

WHAT COUNTS AS A VISUAL BEAT
A visual beat is any individual narration unit that introduces a NEW:
- Action, subject, character, or location
- Camera perspective, emotion, or object
- Historical event, statistic, date, fact, or study
- Transition, cause-and-effect relationship, or visual concept

RULES (NON-NEGOTIABLE)
1. NEVER segment by scene. NEVER merge multiple beats into one.
2. No narration may be left uncovered.
3. If a sentence contains multiple distinct visual ideas, split it into multiple beats.
4. Each fact, statistic, date, location, study, or historical example gets its OWN dedicated beat.
5. Storytelling sections typically produce 1+ beats per sentence — often multiple when a sentence contains several visual changes.
6. Educational sections: each concept, mechanism, or example is its own beat.
7. Do NOT optimize for fewer beats. Complete coverage is the goal.
8. HARD FLOOR: no beat may be shorter than 10 words. This overrides every rule above. A sentence shorter than 10 words is NOT a beat of its own — carry it into the neighbouring beat so the combined segment clears 10 words. Short emphatic lines ("Not the death." "Read that again.") belong with the line beside them.

DENSITY
- Minimum: 10 words per beat, always. Never one beat per short sentence.
- Preferred: ~1 beat every 3–6 seconds of narration (≈10–15 words of script per beat).
- This chunk may produce many beats; long-form scripts commonly total 50–150+ across all chunks.

PER-BEAT FIELDS
- scriptSegment: the exact words from the script for this beat (10–20 words; never fewer than 10). Must be a verbatim substring of the chunk AND must NOT overlap with adjacent beats — each beat picks up exactly where the previous beat's last word ended. Concatenating every scriptSegment in order, separated by single spaces, must reproduce the chunk verbatim. Do not repeat phrases at beat boundaries.

VALIDATION (DO THIS BEFORE RETURNING)
Step 1: Walk the script chunk and identify every visual beat using the definition above.
Step 2: Count them.
Step 3: Confirm your "beats" array has exactly that many entries.
Step 4: Confirm the segments concatenate back to the chunk verbatim, with no gaps and no overlaps.
Step 5: Count the words in every segment. Any segment under 10 words must be joined to the beat before it (or after it, if it is the first) and the array rebuilt. Do not return a beat under 10 words.

Number beats sequentially starting from 1, with no gaps. Call the save_beats tool with a "beats" array. Do not write any text outside the tool call.`;
}

export function buildBeatsDynamic(script: string): string {
  return `SCRIPT (THIS CHUNK):\n${script}`;
}

export function buildImagePromptsDynamic(script: string): string {
  return `SCRIPT (THIS CHUNK):\n${script}`;
}

export function buildImagePromptsPrompt(
  script: string,
  visualProfile: VisualProfileOutput,
  startBeat: number = 1,
  promptStyle: PromptStyle = "general",
  consistencySheet?: string,
): string {
  return `Identify every VISUAL BEAT in this script chunk and generate one image prompt for each.

${consistencyBlock(consistencySheet)}

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
${renderVisualStyleBlock(visualProfile)}
${promptStyle === "cinematic" ? "\n(See cinematic beat-splitting rules used by buildImagePromptsCached — this synchronous variant is dead code kept for signature parity.)\n" : ""}
PER-BEAT FIELDS
- scriptSegment: the exact words from the script for this beat (typically 8–20 words). Must be a verbatim substring of the chunk above AND must NOT overlap with adjacent beats — each beat picks up exactly where the previous beat's last word ended. Concatenating every scriptSegment in order, separated by single spaces, must reproduce the chunk verbatim. Do not repeat phrases at beat boundaries.
${SELF_CONTAINED_IMAGE_PROMPT_FIELD}
- camera: single short phrase (e.g. "tight close-up", "low-angle wide", "overhead aerial")
- lighting: single short phrase (e.g. "warm golden rim light", "cold blue moonlight")
- mood: single short phrase (e.g. "tense, urgent", "quiet, reverent")
- action: single short phrase (e.g. "subject leans forward", "dust settles after the strike")

QUALITY
${SELF_CONTAINED_QUALITY_RULES}
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
- stylePrompt: a COMPLETE, DETAILED AI image generation prompt for the thumbnail image (4-6 sentences). Must include: subject description, scene/background, lighting, composition, color palette, art style, the LITERAL overlay text from textOverlay (quote the exact words inside the prompt, e.g. \`render the text "GOD IS REMOVING THEM" in bold white sans-serif with red shadow, top-left\` — describing only the placement without the actual words is NOT acceptable, the image model can't infer them), and technical quality tags. Write it as if you're instructing an image AI with full context — no shortcuts.

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
