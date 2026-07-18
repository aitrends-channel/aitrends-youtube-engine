import { createHash } from "crypto";
import { supabase } from "@/lib/supabase/client";
import { getAnthropicClient, MODEL, VISION_MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import { buildScriptPrompt, buildVisualAnalysisPrompt } from "@/lib/claude/prompts";
import { visualProfileInputSchema } from "@/lib/claude/anthropicSchemas";
import { VisualProfileSchema } from "@/lib/claude/schemas";
import { retryClaudeCall } from "@/lib/claude/retry";
import { uploadFromUrl, uploadBuffer, userFolderFor } from "@/lib/supabase/storage";
import { PROMPT_MODEL } from "@/lib/claude/client";
import { generateImages, generateVideos, generateThumbnails } from "@/lib/workflow/prompts-core";
import { submitImageTask, generateImage } from "@/lib/kie/images";
import { generateTTS, TTS_MODEL } from "@/lib/kie/tts";
import { isGoogleVoice } from "@/lib/google/tts";
import { isQwenVoice } from "@/lib/replicate/tts";
import { dedupeOverlap } from "@/lib/text/dedupeOverlap";
import { getModelConfig } from "@/lib/kie/imageModels";
import { getVideoModelConfig } from "@/lib/kie/videoModels";
import { getConcurrencyConfig } from "@/lib/concurrency-config";
import { logProjectCost } from "@/lib/costs";
import { incrementFreeUsage } from "@/lib/freeUsage";
import { redis } from "@/lib/queue/client";
import { isProTier } from "@/lib/plans-gating";
import { sendEmail } from "@/lib/email/smtp";
import type { VisualProfileOutput, ThumbnailAnalysisOutput } from "@/lib/claude/schemas";
import type { ModelChain, OneClickConfig } from "@/lib/one-click/config";

// 1Click orchestrator — advances one autopilot project by exactly one
// step per call, mirroring what each wizard page does but server-side
// and with the user's saved preferences auto-accepting every gate.
//
// The tick loop (/api/one-click/tick) fetches running projects and calls
// advanceProject on each. Keeping each call to a single step means a
// crash or timeout only loses that step's work, the next tick retries,
// and long async work (image/video generation, assembly) is polled
// across ticks rather than blocking one request.
//
// State machine (projects.current_state):
//   1–5  channel  → runs client-side at kickoff; orchestrator starts at 6
//   6    topic/script (split by selected_topic)
//   7–8  visuals
//   9–13 prompts / voiceover
//   14   generate (images + videos)
//   15   assemble → complete

const RESULT = {
  advanced: (step: string, note?: string) => ({ kind: "advanced" as const, step, note }),
  waiting: (note: string) => ({ kind: "waiting" as const, note }),
  attention: (note: string) => ({ kind: "attention" as const, note }),
  done: () => ({ kind: "done" as const }),
};
export type AdvanceResult =
  | { kind: "advanced"; step: string; note?: string }
  | { kind: "waiting"; note: string }
  | { kind: "attention"; note: string }
  | { kind: "done" };

interface ProjectRow {
  id: string;
  user_id: string;
  current_state: number;
  selected_topic: string | null;
  script: string | null;
  channel_analysis: unknown;
  content_type: string | null;
  auto_pilot_config: OneClickConfig | null;
}

// Steps the orchestrator can't yet drive on its own. Rather than hang,
// it flags needs_attention with a clear, actionable message so the user
// can finish that step in the normal wizard (and Stop/continue).
const MANUAL_STEP_NOTE = (step: string) =>
  `1Click has taken your project through to the ${step} step. Finish the remaining steps in the editor — full automation of ${step} onward is rolling out shortly.`;

/**
 * Advance one project by a single step. Returns what happened so the
 * tick loop can update auto_pilot_status/error and decide whether to
 * keep ticking this project.
 */
export async function advanceProject(project: ProjectRow): Promise<AdvanceResult> {
  const cfg = project.auto_pilot_config;
  if (!cfg) return RESULT.attention("Missing 1Click configuration for this run.");

  const state = project.current_state ?? 1;

  // ── Topic (state 6, no topic yet) ────────────────────────────────
  if (state === 6 && !project.selected_topic) {
    // Manual mode: pause for the user to choose. The run resumes on a
    // later tick once selected_topic is set (in the topic UI).
    if (cfg.topicMode === "manual") {
      return RESULT.attention("Pick a topic to continue — 1Click resumes automatically once you choose one.");
    }
    // Auto mode: channel analysis already generated video_ideas at
    // kickoff. Pick the top idea as the topic.
    const { data, error } = await supabase
      .from("projects")
      .select("video_ideas")
      .eq("id", project.id)
      .single();
    if (error) return RESULT.attention(`Couldn't read generated ideas: ${error.message}`);
    const ideas = Array.isArray(data?.video_ideas) ? (data!.video_ideas as string[]) : [];
    const topic = ideas.find((t) => t && t.trim());
    if (!topic) return RESULT.attention("No topic ideas were generated — open the project and pick a topic.");

    const { error: upErr } = await supabase
      .from("projects")
      .update({ selected_topic: topic })
      .eq("id", project.id);
    if (upErr) return RESULT.attention(`Couldn't save the topic: ${upErr.message}`);
    return RESULT.advanced("topic", `Picked topic: ${topic}`);
  }

  // ── Script (state 6, topic chosen) ───────────────────────────────
  if (state === 6 && project.selected_topic) {
    // Manual mode: pause for the user to write/edit the script. The run
    // resumes once the script step advances current_state past 6.
    if (cfg.scriptMode === "manual" && !project.script) {
      return RESULT.attention("Write or edit your script to continue — 1Click resumes once it's ready.");
    }
    return await runScriptStep(project, cfg);
  }

  // ── Visuals (states 7–8) ─────────────────────────────────────────
  if (state >= 7 && state <= 8) {
    return await runVisualsStep(project);
  }

  // ── Prompts (states 9–13): image + video prompts per beat ────────
  if (state >= 9 && state <= 13) {
    return await runPromptsStep(project);
  }

  // ── Generate + assemble (state 14) ───────────────────────────────
  if (state === 14) return await runGenerateStep(project, cfg);
  // ── Thumbnails (state 15, after assembly) → complete (16) ────────
  if (state === 15) return await runThumbnailsStep(project, cfg);
  // Safety net: a project already at state 16 (e.g. resumed after the
  // thumbnails step already completed it). runThumbnailsStep sends the
  // email on the real completion path, so don't re-send here.
  if (state >= 16) return RESULT.done();

  // ── Channel analysis (states 1–5) still running ──────────────────
  // 1Click now engages right from the analysis step: the channel page
  // fires /api/workflow/analyze (which lands the project at state 6 with
  // topic ideas) and hands off to the live view immediately. So while
  // state < 6 we WAIT for that server-side call rather than erroring.
  // Bound the wait so a failed/never-arriving analysis eventually
  // surfaces instead of spinning forever.
  const { data: waitRow } = await supabase
    .from("projects").select("auto_pilot_attempts").eq("id", project.id).single();
  const waitAtt = (waitRow?.auto_pilot_attempts as Record<string, number> | null) ?? {};
  const waits = (waitAtt["channelWaits"] ?? 0) + 1;
  if (waits > 40) {
    return RESULT.attention("Channel analysis didn't complete — reopen the project to finish setup.");
  }
  waitAtt["channelWaits"] = waits;
  await supabase.from("projects").update({ auto_pilot_attempts: waitAtt }).eq("id", project.id);
  return RESULT.waiting("Analyzing your channel…");
}

// DEV/TEST-only script cap. When ONECLICK_DEV_SCRIPT_WORDS is a positive
// integer, prompt generation runs on only the FIRST N words of the
// script — so generateImages creates just a couple of beats and the whole
// pipeline (prompts, voiceovers, images, videos, assembly) runs on that
// tiny subset (cheap KIE spend, fast end-to-end). This caps work at the
// source instead of generating everything and deleting it. Unset / 0 /
// prod → returns the script unchanged. Env-driven so it can never ship on.
function devSliceScript(script: string): string {
  const n = parseInt(process.env.ONECLICK_DEV_SCRIPT_WORDS ?? "", 10);
  if (!Number.isInteger(n) || n <= 0) return script;
  const words = script.trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) return script;
  console.log(`[one-click] DEV script cap: using first ${n} of ${words.length} words for prompts`);
  return words.slice(0, n).join(" ");
}

// Generate the script the same way the script route does (buildScriptPrompt
// + Claude), non-streaming, then persist and advance to state 7.
async function runScriptStep(project: ProjectRow, _cfg: OneClickConfig): Promise<AdvanceResult> {
  const topic = project.selected_topic!;

  const { data, error } = await supabase
    .from("projects")
    .select("channel_analysis")
    .eq("id", project.id)
    .single();
  const analysis = data?.channel_analysis as Parameters<typeof buildScriptPrompt>[0] | undefined;
  if (error || !analysis) {
    return RESULT.attention("Channel analysis is missing — can't write the script.");
  }

  let script = "";
  try {
    const { client: anthropic } = await getAnthropicClient(project.user_id, "script");
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildScriptPrompt(analysis, topic) }],
    });
    script = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  } catch (err) {
    return RESULT.attention(`Script generation failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  if (!script) return RESULT.attention("The script came back empty — open the project and retry.");

  const wordCount = script.split(/\s+/).filter(Boolean).length;
  const { error: upErr } = await supabase
    .from("projects")
    .update({ script, word_count: wordCount, current_state: 7 })
    .eq("id", project.id);
  if (upErr) return RESULT.attention(`Couldn't save the script: ${upErr.message}`);

  return RESULT.advanced("script", `Wrote a ${wordCount}-word script`);
}

// Auto-capture reference frames from the channel's top videos (YouTube
// still URLs → R2, no cost) and run the vision analysis to extract the
// visual profile, mirroring the visuals page's video-style branch.
// Advances to state 9. Low-risk: no KIE credits, one vision call.
async function runVisualsStep(project: ProjectRow): Promise<AdvanceResult> {
  const { data, error } = await supabase
    .from("projects")
    .select("channel_info")
    .eq("id", project.id)
    .single();
  if (error) return RESULT.attention(`Couldn't read channel info: ${error.message}`);

  const topVideos = (data?.channel_info as { topVideos?: { videoId?: string; title?: string }[] } | null)?.topVideos ?? [];
  const videos = topVideos
    .map((v) => ({ videoId: (v.videoId ?? "").trim(), title: (v.title ?? "").trim() }))
    .filter((v) => v.videoId)
    .slice(0, 10);
  if (videos.length === 0) return RESULT.attention("No channel videos to sample for visual style — finish the visuals step in the editor.");

  // Capture two auto-sampled frames per video (YouTube exposes 1/2/3.jpg)
  // and upload to R2, skipping any that don't resolve.
  const folder = `${userFolderFor({ id: project.user_id, email: null })}/${project.id}/auto-frames`;
  const framesByVideo = await Promise.all(videos.map(async ({ videoId, title }) => {
    const urls = (await Promise.all([1, 3].map(async (n) => {
      try { return await uploadFromUrl(`${folder}/${videoId}-frame-${n}.jpg`, `https://img.youtube.com/vi/${videoId}/${n}.jpg`, "image/jpeg"); }
      catch { return null; }
    }))).filter((u): u is string => !!u);
    return { videoId, title, thumbnailUrl: "", frameUrls: urls };
  }));
  const frameUrls = framesByVideo.flatMap((f) => f.frameUrls).slice(0, 20);
  if (frameUrls.length === 0) return RESULT.attention("Couldn't capture reference frames — finish the visuals step in the editor.");

  // Vision analysis — video-only branch, so the tool returns just the
  // visualProfile and the step advances to state 9 (as the route does).
  const schema = {
    type: "object" as const,
    properties: { visualProfile: visualProfileInputSchema.properties.visualProfile },
    required: ["visualProfile"],
  };
  let profileInput: unknown;
  try {
    const { client } = await getAnthropicClient(project.user_id, "visual_analysis");
    const res = await retryClaudeCall("one-click:visuals", () => client.messages.create({
      model: VISION_MODEL,
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [{ name: "save_visual_analysis", description: "Save the extracted visual style profile", input_schema: schema }],
      tool_choice: { type: "tool", name: "save_visual_analysis" },
      messages: [{
        role: "user",
        content: [
          ...frameUrls.map((url) => ({ type: "image" as const, source: { type: "url" as const, url } })),
          { type: "text" as const, text: buildVisualAnalysisPrompt({ video: true, thumbnails: false }) },
        ],
      }],
    }), 5);
    const toolUse = res.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error("No visual profile returned");
    profileInput = (toolUse.input as { visualProfile: unknown }).visualProfile;
  } catch (err) {
    return RESULT.attention(`Visual analysis failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  const visualProfile = VisualProfileSchema.parse(profileInput);
  const { error: upErr } = await supabase
    .from("projects")
    .update({ visual_profile: visualProfile, auto_frames: framesByVideo, current_state: 9 })
    .eq("id", project.id);
  if (upErr) return RESULT.attention(`Couldn't save the visual profile: ${upErr.message}`);

  return RESULT.advanced("visuals", "Captured reference frames and extracted the visual style");
}

// Generate per-beat image prompts (which also creates project_beats) and
// video prompts, reusing the prompts route's own functions with a no-op
// send. Claude-token work (no KIE image/video credits — those come at
// the generate step). generateImages restores current_state to 14 on
// completion, so a successful run lands the project at the generate step.
async function runPromptsStep(project: ProjectRow): Promise<AdvanceResult> {
  const { data, error } = await supabase
    .from("projects")
    .select("script, visual_profile")
    .eq("id", project.id)
    .single();
  const script = (data?.script as string | null)?.trim();
  const visualProfile = data?.visual_profile as VisualProfileOutput | null;
  if (error || !script) return RESULT.attention("The script is missing — can't generate prompts.");
  if (!visualProfile) return RESULT.attention("The visual profile is missing — can't generate prompts.");

  // generateImages/generateVideos report failures through send() as
  // {type:"error"} events rather than always throwing — capture those
  // so the real reason surfaces instead of a generic message.
  let sendErr: string | null = null;
  const capture = (data: object) => {
    const d = data as { type?: string; message?: string };
    if (d.type === "error" && d.message) sendErr = d.message;
  };
  try {
    // DEV/TEST cap: feed only the first N words of the script to prompt
    // generation, so just a couple of beats are ever created and the rest
    // of the pipeline runs on that subset. No-op unless
    // ONECLICK_DEV_SCRIPT_WORDS is set.
    const genScript = devSliceScript(script);
    // Image prompts create the beats and set current_state back to 13
    // while running, then to 14 on completion.
    await generateImages(project.id, project.user_id, genScript, visualProfile, capture, PROMPT_MODEL);
    if (sendErr) return RESULT.attention(`Image prompt generation failed: ${sendErr}`);
    // Video prompts fill each beat's video_prompt (doesn't touch state).
    await generateVideos(project.id, project.user_id, capture, PROMPT_MODEL);
    if (sendErr) return RESULT.attention(`Video prompt generation failed: ${sendErr}`);
  } catch (err) {
    return RESULT.attention(`Prompt generation failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  // Confirm the run actually landed at the generate step.
  const { data: after } = await supabase.from("projects").select("current_state").eq("id", project.id).single();
  if ((after?.current_state ?? 0) < 14) {
    return RESULT.attention("Prompt generation didn't finish — open the project's Prompts step to complete it, then resume.");
  }
  return RESULT.advanced("prompts", "Generated image and video prompts for every beat");
}

interface BeatRow {
  beat_number: number;
  image_prompt: string | null;
  video_prompt: string | null;
  image_url: string | null;
  image_status: string | null;
  image_task_id: string | null;
  video_url: string | null;
  video_status: string | null;
}

// nth model in a chain (0=primary,1=secondary,2=fallback), skipping
// empty slots. Returns the last non-empty when idx overruns.
function chainModel(chain: ModelChain, idx: number): string {
  const models = [chain.primary, chain.secondary, chain.fallback].filter((m): m is string => !!m);
  return models[Math.min(idx, models.length - 1)] ?? chain.primary;
}
function chainLength(chain: ModelChain): number {
  return [chain.primary, chain.secondary, chain.fallback].filter(Boolean).length;
}

// KIE image models reject prompts past a model-specific maximum with
// "KIE 500: The text length cannot exceed the maximum limit". Unlike a
// 429 this is deterministic — retrying the identical prompt fails the
// same way — so recovery means SHORTENING the prompt. We retry at
// progressively smaller caps; the floor (400) sits comfortably under
// every KIE image model's limit. Applies to both beat images and
// thumbnails, so it lives here rather than in each loop.
const PROMPT_LENGTH_CAPS = [1500, 800, 400];
function isPromptLengthError(msg: string): boolean {
  return /text length|maximum limit|too long|prompt.*exceed/i.test(msg);
}
// Cap a prompt to `max` chars, preferring to cut at the last sentence/
// clause/word boundary so the truncated prompt still reads cleanly.
function capPrompt(prompt: string, max: number): string {
  if (prompt.length <= max) return prompt;
  const slice = prompt.slice(0, max);
  const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(", "), slice.lastIndexOf(" "));
  return (cut > max * 0.5 ? slice.slice(0, cut) : slice).trim();
}

// Hash a beat's script segment the same way the manual tts/beats route
// does, so "up to date" checks agree across the two flows.
function hashSegment(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

// Generate per-beat voiceover audio (voiceover_url) with the user's
// configured voice — a 1:1 mirror of /api/generate/tts/beats: same
// stale-beat rule, same overlap-dedupe, batched by tts_beat_batch, same
// cost accounting. The assembler runs in per-beat mode whenever ANY beat
// has a voiceover_url and DROPS beats that lack one, so every beat must
// be voiced before assembly. Returns an AdvanceResult to short-circuit
// runGenerateStep while work remains, or null once all beats are voiced.
async function ensureVoiceovers(project: ProjectRow, cfg: OneClickConfig): Promise<AdvanceResult | null> {
  const voiceId = cfg.tts?.voiceId?.trim();
  if (!voiceId) return RESULT.attention("No voiceover voice is configured for 1Click — set one in your 1Click preferences, then resume.");

  const { data: beatData, error } = await supabase
    .from("project_beats")
    .select("beat_number, script_segment, voiceover_url, voiceover_status, voiceover_voice_id, voiceover_script_hash")
    .eq("project_id", project.id)
    .order("beat_number");
  if (error) return RESULT.attention(`Couldn't read beats for voiceover: ${error.message}`);
  const allBeats = beatData ?? [];
  if (allBeats.length === 0) return RESULT.attention("No beats to voice — reopen the prompts step.");

  // Same stale rule as selectStaleBeats in the manual tts/beats route.
  const toGenerate = allBeats.filter((b) => {
    const seg = (b.script_segment as string | null)?.trim();
    if (!seg) return false; // skip blank segments (they produce no audio)
    if (!b.voiceover_url) return true;
    if (b.voiceover_status === "failed" || b.voiceover_status === "queued") return true;
    if (b.voiceover_voice_id !== voiceId) return true;
    if (b.voiceover_script_hash !== hashSegment(seg)) return true;
    return false;
  });
  if (toGenerate.length === 0) return null; // all voiced → proceed to images

  // Index by beat number so each beat can dedupe overlap against the
  // previous beat's segment (as the route does).
  const segByNumber = new Map<number, string | null>();
  for (const b of allBeats) segByNumber.set(b.beat_number as number, b.script_segment as string | null);

  const BATCH_SIZE = Math.max(1, (await getConcurrencyConfig()).tts_beat_batch);
  const folder = userFolderFor({ id: project.user_id, email: null });
  let hardError: string | null = null;

  const genOne = async (beatNumber: number): Promise<void> => {
    const rawSegment = (segByNumber.get(beatNumber) ?? "").trim();
    if (!rawSegment) return;
    // Trim any leading overlap with the previous beat so the boundary
    // phrase isn't spoken twice; keep raw text if dedupe empties it.
    const segment = dedupeOverlap(rawSegment, segByNumber.get(beatNumber - 1) ?? null);
    const ttsText = segment || rawSegment;
    try {
      await supabase.from("project_beats").update({ voiceover_status: "generating" })
        .eq("project_id", project.id).eq("beat_number", beatNumber);
      const { audio, charsConsumed } = await generateTTS(ttsText, voiceId, undefined, undefined, project.user_id);
      // Same cost accounting as the route: ElevenLabs bills the ledger;
      // BYO Google / Heclus-paid Qwen count against free-usage caps.
      if (charsConsumed && !isGoogleVoice(voiceId) && !isQwenVoice(voiceId)) {
        void logProjectCost({ projectId: project.id, userId: project.user_id, step: "tts", provider: "elevenlabs", model: TTS_MODEL, units: charsConsumed, unitKind: "elevenlabs_chars" });
      } else if (charsConsumed && isGoogleVoice(voiceId)) {
        void incrementFreeUsage(project.user_id, "tts_chars", charsConsumed);
      } else if (charsConsumed && isQwenVoice(voiceId)) {
        void incrementFreeUsage(project.user_id, "qwen_tts_chars", charsConsumed);
      }
      const storagePath = `${folder}/${project.id}/voiceovers/beat-${beatNumber}_${Date.now()}.mp3`;
      const publicUrl = await uploadBuffer(storagePath, audio, "audio/mpeg");
      await supabase.from("project_beats").update({
        voiceover_url: publicUrl, voiceover_status: "done",
        voiceover_voice_id: voiceId, voiceover_script_hash: hashSegment(rawSegment), voiceover_error: null,
      }).eq("project_id", project.id).eq("beat_number", beatNumber);
    } catch (e) {
      const message = e instanceof Error ? e.message : "TTS failed";
      hardError = message;
      await supabase.from("project_beats").update({ voiceover_status: "failed", voiceover_error: message })
        .eq("project_id", project.id).eq("beat_number", beatNumber);
    }
  };

  // Batched, mirroring tts_beat_batch. Per-beat persistence means a tick
  // that times out mid-run resumes cleanly on the next one.
  for (let i = 0; i < toGenerate.length; i += BATCH_SIZE) {
    await Promise.all(toGenerate.slice(i, i + BATCH_SIZE).map((b) => genOne(b.beat_number as number)));
    if (hardError) return RESULT.attention(`Voiceover generation failed: ${hardError}`);
  }
  return RESULT.waiting(`Generating ${toGenerate.length} voiceover${toGenerate.length === 1 ? "" : "s"}…`);
}

// State 14: generate every beat's image and video clip (real KIE spend),
// applying the model fallback chains on failure, then queue assembly and
// poll it to completion — all across ticks, since this work is async
// (KIE webhook/cron for images, the video worker for clips + assembly).
async function runGenerateStep(project: ProjectRow, cfg: OneClickConfig): Promise<AdvanceResult> {
  // Assembly phase first: once assembly_status is set we only watch it.
  const { data: proj } = await supabase
    .from("projects")
    .select("assembly_status, assembled_url, auto_pilot_attempts")
    .eq("id", project.id)
    .single();
  const assemblyStatus = proj?.assembly_status as string | null;
  if (assemblyStatus === "done" || proj?.assembled_url) {
    // Video assembled — advance to the thumbnails step (state 15), which
    // the orchestrator runs next. Completion + email happen after
    // thumbnails (state 16).
    await supabase.from("projects").update({ current_state: 15 }).eq("id", project.id).lt("current_state", 15);
    return RESULT.advanced("assemble", "Final video assembled");
  }
  if (assemblyStatus === "failed") return RESULT.attention("Assembly failed — open the project to retry the final render.");
  if (assemblyStatus === "queued" || assemblyStatus === "processing") return RESULT.waiting("Assembling the final video…");

  const attempts = (proj?.auto_pilot_attempts as Record<string, number> | null) ?? {};
  const imgIdx = attempts["genImageModelIdx"] ?? 0;
  const vidIdx = attempts["genVideoModelIdx"] ?? 0;

  const { data: beatData, error: beatErr } = await supabase
    .from("project_beats")
    .select("beat_number, image_prompt, video_prompt, image_url, image_status, image_task_id, video_url, video_status")
    .eq("project_id", project.id)
    .order("beat_number");
  if (beatErr) return RESULT.attention(`Couldn't read beats: ${beatErr.message}`);
  const beats = (beatData ?? []) as BeatRow[];
  if (beats.length === 0) return RESULT.attention("No beats to generate — reopen the prompts step.");

  // ── Voiceovers ────────────────────────────────────────────────────
  // Narrate every beat before touching images/videos. The assembler
  // drops any beat without a voiceover_url, so this must finish first.
  const voResult = await ensureVoiceovers(project, cfg);
  if (voResult) return voResult;

  // ── Images ───────────────────────────────────────────────────────
  const imgDone = (b: BeatRow) => !!b.image_url;
  const imgPending = (b: BeatRow) => !imgDone(b) && (b.image_status === "generating" || b.image_status === "queued");
  const imgFailed = (b: BeatRow) => !imgDone(b) && !imgPending(b); // failed / null / never submitted
  const imageModel = chainModel(cfg.images, imgIdx);
  // Only pass a resolution/aspect ratio the chosen model actually
  // supports — a value it doesn't list makes KIE reject the submit
  // (the cause of the "image generation failed"). Fall back to the
  // model's first supported ratio, and drop resolution entirely for
  // models without tiers.
  const imgCfg = getModelConfig(imageModel);
  const imgAr = imgCfg.aspectRatios.includes(cfg.output.aspectRatio) ? cfg.output.aspectRatio : (imgCfg.aspectRatios[0] ?? "16:9");
  const imgRes = imgCfg.resolutions?.includes(cfg.output.resolution) ? cfg.output.resolution : (imgCfg.resolutions?.[0] ?? undefined);

  const toSubmitImg = beats.filter((b) => imgFailed(b) && b.image_prompt?.trim());
  if (toSubmitImg.length > 0) {
    // If a whole prior batch failed (not just first submit), step the
    // chain to the next model before resubmitting.
    const anyPreviouslyFailed = toSubmitImg.some((b) => b.image_status === "failed");
    if (anyPreviouslyFailed && imgIdx < chainLength(cfg.images) - 1) {
      attempts["genImageModelIdx"] = imgIdx + 1;
      await supabase.from("projects").update({ auto_pilot_attempts: attempts }).eq("id", project.id);
    }
    // Mirror the manual generate flow's pacing, but honor the admin's
    // image_generation_batch (product_config) instead of a hardcoded
    // count, with a 1.5s gap between batches and per-beat retry on KIE's
    // "call frequency too high" 429 (backoff 1s→2s→4s→8s). Firing all
    // beats at once trips the rate limit.
    const SUBMIT_BATCH = Math.max(1, (await getConcurrencyConfig()).image_generation_batch);
    let hardError: string | null = null;
    const submitOne = async (b: BeatRow): Promise<boolean> => {
      const basePrompt = b.image_prompt!.trim();
      const MAX_RETRIES = 5;
      let capIdx = 0; // 0 = full prompt; >0 = capped at PROMPT_LENGTH_CAPS[capIdx-1]
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const prompt = capIdx === 0 ? basePrompt : capPrompt(basePrompt, PROMPT_LENGTH_CAPS[capIdx - 1]);
        try {
          const taskId = await submitImageTask(prompt, imageModel, imgAr, imgRes, project.user_id);
          await supabase.from("project_beats")
            .update({ image_status: "generating", image_task_id: taskId, image_model_id: imageModel, image_prompt: prompt })
            .eq("project_id", project.id).eq("beat_number", b.beat_number);
          return true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          // Prompt too long → shorten and retry (deterministic, no backoff).
          if (isPromptLengthError(msg) && capIdx < PROMPT_LENGTH_CAPS.length) {
            capIdx++;
            continue;
          }
          const rateLimited = /429|frequency|rate limit/i.test(msg);
          if (rateLimited && attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * 2 ** attempt)));
            continue;
          }
          hardError = msg; // credits / model / length-exhausted — surface it
          return false;
        }
      }
      return false;
    };
    for (let i = 0; i < toSubmitImg.length; i += SUBMIT_BATCH) {
      const batch = toSubmitImg.slice(i, i + SUBMIT_BATCH);
      await Promise.all(batch.map(submitOne));
      if (hardError) return RESULT.attention(`Image generation failed: ${hardError}`);
      if (i + SUBMIT_BATCH < toSubmitImg.length) await new Promise((r) => setTimeout(r, 1500));
    }
    return RESULT.waiting(`Generating ${toSubmitImg.length} image${toSubmitImg.length === 1 ? "" : "s"}…`);
  }

  // ── Videos (queue once images exist; worker picks them up) ────────
  const allImagesDone = beats.every(imgDone);
  if (allImagesDone) {
    // Video prompts must exist before any clip can be queued. Because
    // generateImages advances current_state to 14 on its OWN completion —
    // before generateVideos runs — a project can reach the generate step
    // with beats that have no video_prompt (an earlier prompts run whose
    // video half didn't finish: cancelled tick, timeout, etc.). Without a
    // prompt, a beat is filtered out of toQueueVid below and the step
    // loops "Rendering video clips…" forever with nothing ever sent to
    // KIE. Self-heal by generating the missing prompts here, exactly as
    // the prompts step would, then let the next tick queue them.
    const missingVideoPrompts = beats.some((b) => !b.video_prompt?.trim());
    if (missingVideoPrompts) {
      let sendErr: string | null = null;
      const capture = (d: object) => { const e = d as { type?: string; message?: string }; if (e.type === "error" && e.message) sendErr = e.message; };
      try {
        await generateVideos(project.id, project.user_id, capture, PROMPT_MODEL);
        if (sendErr) return RESULT.attention(`Video prompt generation failed: ${sendErr}`);
      } catch (err) {
        return RESULT.attention(`Video prompt generation failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
      return RESULT.waiting("Preparing video prompts…");
    }

    const vidDone = (b: BeatRow) => !!b.video_url;
    const vidPending = (b: BeatRow) => !vidDone(b) && (b.video_status === "queued" || b.video_status === "submitting" || b.video_status === "rendering");
    const vidFailed = (b: BeatRow) => !vidDone(b) && !vidPending(b);
    const videoModel = chainModel(cfg.videos, vidIdx);
    // The worker silently skips any queued beat whose video_model_id is
    // empty — so guard here rather than queue clips that never render.
    if (!videoModel?.trim()) {
      return RESULT.attention("No video model is configured for 1Click — set one in your 1Click preferences, then resume.");
    }
    // Match the model's supported options; many video models take no
    // aspect ratio (they inherit the source image) and their own
    // resolution set, so pass only what's valid.
    const vidCfg = getVideoModelConfig(videoModel);
    const vidAr = vidCfg.aspectRatios.length && vidCfg.aspectRatios.includes(cfg.output.aspectRatio) ? cfg.output.aspectRatio : (vidCfg.aspectRatios[0] ?? null);
    const vidRes = vidCfg.resolutions?.length ? (vidCfg.resolutions.includes(cfg.output.resolution) ? cfg.output.resolution : vidCfg.resolutions[0]) : null;
    const vidDur = cfg.videos.duration != null ? String(cfg.videos.duration) : null;

    const toQueueVid = beats.filter((b) => vidFailed(b) && b.video_prompt?.trim());
    if (toQueueVid.length > 0) {
      const anyPreviouslyFailed = toQueueVid.some((b) => b.video_status === "failed");
      if (anyPreviouslyFailed && vidIdx < chainLength(cfg.videos) - 1) {
        attempts["genVideoModelIdx"] = vidIdx + 1;
        await supabase.from("projects").update({ auto_pilot_attempts: attempts }).eq("id", project.id);
      }
      await supabase.from("projects").update({
        video_model_id: videoModel, video_aspect_ratio: vidAr,
        video_duration: vidDur, video_resolution: vidRes,
      }).eq("id", project.id);
      // Queue in batches sized by product_config.video_worker — the same
      // admin knob that caps how many clips the worker renders at once —
      // so clips follow the same batched pattern as images (which use
      // image_generation_batch) instead of flipping every beat to
      // "queued" in a single burst.
      const VIDEO_BATCH = Math.max(1, (await getConcurrencyConfig()).video_worker);
      const queueOne = (b: BeatRow) => supabase.from("project_beats").update({
        video_status: "queued", video_job_id: null, video_error: null,
        video_model_id: videoModel, video_aspect_ratio: vidAr,
        video_duration: vidDur, video_resolution: vidRes,
      }).eq("project_id", project.id).eq("beat_number", b.beat_number);
      for (let i = 0; i < toQueueVid.length; i += VIDEO_BATCH) {
        await Promise.all(toQueueVid.slice(i, i + VIDEO_BATCH).map(queueOne));
        if (i + VIDEO_BATCH < toQueueVid.length) await new Promise((r) => setTimeout(r, 500));
      }
      return RESULT.waiting(`Rendering ${toQueueVid.length} video clip${toQueueVid.length === 1 ? "" : "s"}…`);
    }

    // ── All media done → trigger assembly ──────────────────────────
    if (beats.every(vidDone)) {
      const a = cfg.assemble;
      // Map the picker's 1K/2K to a worker render preset, and gate
      // Pro-only resolutions exactly like the manual assemble route:
      // a non-Pro run downgrades to 1080p instead of being rejected.
      const { data: userData } = await supabase.auth.admin.getUserById(project.user_id);
      const wantsHi = cfg.output.resolution === "2K";
      const resolution = wantsHi && isProTier(userData?.user) ? "1440p" : "1080p";
      const options = {
        aspectRatio: cfg.output.aspectRatio,
        // Per-beat voiceover mode is active (every beat has voiceover_url),
        // so the worker ignores voiceoverType — send "original" to match
        // the manual assemble route's hard-coded value.
        voiceoverType: "original",
        captionsEnabled: a.captionsEnabled,
        captionsLanguage: a.captionsLanguage,
        captionsStyle: a.captionsStyle,
        captionsSize: a.captionsSize,
        captionsPosition: a.captionsPosition,
        trimSilenceEnabled: true,
        backgroundMusicUrl: a.bgMusicUrl,
        backgroundMusicVolume: a.bgMusicVolume,
        logoUrl: a.logoUrl,
        logoX: a.logoX, logoY: a.logoY, logoSize: a.logoSize,
        resolution,
      };
      // Redis is the worker handoff; the project row is the durable
      // copy (hydration / resume) — write both, exactly as the manual
      // assemble route does.
      await redis.set(`assembly:${project.id}`, JSON.stringify(options), { ex: 7200 });
      await supabase.from("projects").update({
        assembly_status: "queued", assembly_progress: "Queued…",
        assembly_error: null, assembly_stop_requested: false,
        background_music_url: a.bgMusicUrl ?? null,
        background_music_volume: typeof a.bgMusicVolume === "number" ? a.bgMusicVolume : 0.15,
        logo_url: a.logoUrl ?? null,
        logo_x: typeof a.logoX === "number" ? a.logoX : 0.85,
        logo_y: typeof a.logoY === "number" ? a.logoY : 0.05,
        logo_size: typeof a.logoSize === "number" ? a.logoSize : 0.1,
        trim_silence_enabled: true,
        captions_enabled: a.captionsEnabled,
        captions_language: a.captionsLanguage ?? "source",
        captions_style: a.captionsStyle ?? "classic",
        captions_size: a.captionsSize ?? "medium",
        captions_position: a.captionsPosition ?? "bottom",
      }).eq("id", project.id);
      return RESULT.waiting("All clips ready — assembling the final video…");
    }
    return RESULT.waiting("Rendering video clips…");
  }

  return RESULT.waiting("Generating images…");
}

// State 15 (video assembled): generate thumbnail concepts + images
// automatically, then mark complete (state 16). Concepts reuse the
// prompts route's generateThumbnails (Claude); images reuse generateImage
// batched by the admin's thumbnail_batch with 429 retry, mirroring the
// manual thumbnail-images route. Runs across ticks — concepts first,
// then images, then done.
async function runThumbnailsStep(project: ProjectRow, cfg: OneClickConfig): Promise<AdvanceResult> {
  const { data, error } = await supabase
    .from("projects")
    .select("script, visual_profile, thumbnail_analysis")
    .eq("id", project.id)
    .single();
  const script = (data?.script as string | null)?.trim();
  const visualProfile = data?.visual_profile as VisualProfileOutput | null;
  if (error || !script || !visualProfile) {
    // Video is already done; don't block on thumbnails — surface it.
    return RESULT.attention("Couldn't start thumbnails (missing script or visual profile) — generate them in the editor.");
  }

  // 1) Concepts — create project_thumbnails rows if none exist yet.
  const { data: existing } = await supabase
    .from("project_thumbnails")
    .select("position, image_url")
    .eq("project_id", project.id)
    .order("position");
  let thumbs = existing ?? [];
  if (thumbs.length === 0) {
    let sendErr: string | null = null;
    const capture = (d: object) => { const e = d as { type?: string; message?: string }; if (e.type === "error" && e.message) sendErr = e.message; };
    try {
      await generateThumbnails(project.id, project.user_id, script, visualProfile,
        (data?.thumbnail_analysis as ThumbnailAnalysisOutput | undefined) ?? undefined, capture, PROMPT_MODEL);
      if (sendErr) return RESULT.attention(`Thumbnail concepts failed: ${sendErr}`);
    } catch (err) {
      return RESULT.attention(`Thumbnail concepts failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    const { data: created } = await supabase
      .from("project_thumbnails").select("position, image_url").eq("project_id", project.id).order("position");
    thumbs = created ?? [];
    if (thumbs.length === 0) return RESULT.attention("No thumbnail concepts were generated — open the editor to create them.");
    return RESULT.waiting("Generating thumbnail concepts…");
  }

  // 2) Images — generate any thumbnail still missing an image, batched
  // by thumbnail_batch, with 429 retry (same pacing as images).
  const missing = thumbs.filter((t) => !t.image_url);
  if (missing.length > 0) {
    const model = chainModel(cfg.images, 0);
    const mCfg = getModelConfig(model);
    const ar = mCfg.aspectRatios.includes("16:9") ? "16:9" : (mCfg.aspectRatios[0] ?? "16:9");
    const resv = mCfg.resolutions?.includes(cfg.output.resolution) ? cfg.output.resolution : (mCfg.resolutions?.[0] ?? undefined);
    const batchSize = Math.max(1, (await getConcurrencyConfig()).thumbnail_batch);

    let hardError: string | null = null;
    const genOne = async (position: number): Promise<void> => {
      const { data: row } = await supabase
        .from("project_thumbnails").select("text_overlay, style_prompt, visual_concept").eq("project_id", project.id).eq("position", position).maybeSingle();
      const basePrompt = [(row?.style_prompt as string | null), (row?.visual_concept as string | null)].filter(Boolean).join(". ").trim() || "YouTube thumbnail";
      await supabase.from("project_thumbnails").update({ image_status: "generating" }).eq("project_id", project.id).eq("position", position);
      let capIdx = 0;
      for (let attempt = 0; attempt <= 5; attempt++) {
        const prompt = capIdx === 0 ? basePrompt : capPrompt(basePrompt, PROMPT_LENGTH_CAPS[capIdx - 1]);
        try {
          const { url } = await generateImage(prompt, model, ar, resv, project.user_id);
          const folder = userFolderFor({ id: project.user_id, email: null });
          const publicUrl = await uploadFromUrl(`${folder}/${project.id}/thumbnails/pos-${position}_${attempt}.png`, url, "image/png");
          await supabase.from("project_thumbnails").update({ image_url: publicUrl, image_status: "done" }).eq("project_id", project.id).eq("position", position);
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          // Prompt too long → shorten and retry (deterministic, no backoff).
          if (isPromptLengthError(msg) && capIdx < PROMPT_LENGTH_CAPS.length) { capIdx++; continue; }
          if (/429|frequency|rate limit/i.test(msg) && attempt < 5) { await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * 2 ** attempt))); continue; }
          hardError = msg;
          await supabase.from("project_thumbnails").update({ image_status: "failed" }).eq("project_id", project.id).eq("position", position);
          return;
        }
      }
    };
    for (let i = 0; i < missing.length; i += batchSize) {
      await Promise.all(missing.slice(i, i + batchSize).map((t) => genOne(t.position as number)));
      if (hardError) return RESULT.attention(`Thumbnail generation failed: ${hardError}`);
      if (i + batchSize < missing.length) await new Promise((r) => setTimeout(r, 1500));
    }
    return RESULT.waiting(`Generating ${missing.length} thumbnail${missing.length === 1 ? "" : "s"}…`);
  }

  // 3) All thumbnails done → mark the project complete and finish the
  // run in one step. Returning done() flips auto_pilot_status to
  // "completed", so the tick won't pick this project up again — which
  // is why the email is sent here (the only path to state 16) and the
  // dispatch's state>=16 branch is just an idempotent safety net.
  await supabase.from("projects").update({ current_state: 16 }).eq("id", project.id);
  await sendCompletionEmail(project.id, project.user_id).catch(() => {});
  return RESULT.done();
}

// Best-effort "your video is ready" email via the support mailbox.
async function sendCompletionEmail(projectId: string, userId: string): Promise<void> {
  const { data: users } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const email = users?.users.find((u) => u.id === userId)?.email;
  if (!email) return;
  const { data: proj } = await supabase.from("projects").select("selected_topic").eq("id", projectId).single();
  const topic = (proj?.selected_topic as string | null) ?? "your video";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL_PRODUCTION ?? process.env.APP_URL ?? "https://app.heclus.io";
  await sendEmail({
    from: "support@heclus.com",
    to: email,
    subject: "Your Heclus video is ready 🎬",
    text: `Hi,\n\n1Click just finished "${topic}" — it's ready to review and download.\n\nOpen it here: ${appUrl}/projects/${projectId}/assemble\n\nThanks,\nHeclus`,
  });
}
