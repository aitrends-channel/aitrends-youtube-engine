import { createHash } from "crypto";
import { supabase } from "@/lib/supabase/client";
import { getAnthropicClient, SYSTEM_PROMPT } from "@/lib/claude/client";
import { getVisionConfig } from "@/lib/claude/vision";
import { modelParamsFor, resolveDefaultModel, resolveModelForUser } from "@/lib/claude/models";
import { buildScriptPrompt, buildVisualAnalysisPrompt, buildVideoIdeasPrompt } from "@/lib/claude/prompts";
import { visualProfileInputSchema, videoIdeasInputSchema } from "@/lib/claude/anthropicSchemas";
import { VisualProfileSchema, VideoIdeasSchema } from "@/lib/claude/schemas";
import { extractToolInputFromText } from "@/lib/claude/textFallback";
import { retryClaudeCall } from "@/lib/claude/retry";
import { uploadFromUrl, uploadBuffer, userFolderFor } from "@/lib/supabase/storage";
import { generateImages, generateVideos, generateThumbnails } from "@/lib/workflow/prompts-core";
import { submitImageTask, generateImage } from "@/lib/kie/images";
import { PROMPT_LENGTH_CAPS, capPrompt, isPromptLengthError } from "@/lib/kie/promptLength";
import { resolveConsistency, applyConsistency } from "@/lib/character-consistency";
import { finishImageTask } from "@/lib/kie/finishImageTask";
import { generateTTS, TTS_MODEL } from "@/lib/kie/tts";
import { friendlyError } from "@/lib/errors/friendly";
import { isQwenVoice } from "@/lib/replicate/tts";
import { isAi33Voice } from "@/lib/ai33/tts";
import { dedupeOverlap } from "@/lib/text/dedupeOverlap";
import { getModelConfig } from "@/lib/kie/imageModels";
import { getVideoModelConfig } from "@/lib/kie/videoModels";
import { getConcurrencyConfig } from "@/lib/concurrency-config";
import { logProjectCost } from "@/lib/costs";
import { incrementFreeUsage } from "@/lib/freeUsage";
import { redis } from "@/lib/queue/client";
import { isProTier } from "@/lib/plans-gating";
import { sendEmail } from "@/lib/email/smtp";
import { storageFullNote } from "@/lib/storage-quota";
import { canStartWalletWork, OUT_OF_CREDITS_MESSAGE } from "@/lib/heclus-charge";
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
    // Auto mode: pick a topic that no other video in this niche has used
    // already. Channel analysis generated video_ideas at kickoff; if every
    // suggestion is taken, generate more (mirrors the topic step's
    // "Generate more ideas") and pick from the fresh ones.
    const { data, error } = await supabase
      .from("projects")
      .select("video_ideas, channel_url, channel_name")
      .eq("id", project.id)
      .single();
    if (error) return RESULT.attention(`Couldn't read generated ideas: ${error.message}`);
    let ideas = Array.isArray(data?.video_ideas) ? (data!.video_ideas as string[]) : [];

    // Topics already used by sibling videos in the same channel/niche.
    const norm = (t: string) => t.toLowerCase().trim();
    const usedTopics = await usedTopicsForChannel(
      project.user_id, project.id,
      (data?.channel_url as string | null) ?? null,
      (data?.channel_name as string | null) ?? null,
    );
    const used = new Set(usedTopics.map(norm));
    const pick = (list: string[]) => list.find((t) => t && t.trim() && !used.has(norm(t))) ?? null;

    let topic = pick(ideas);
    if (!topic) {
      // Every suggested idea is taken — generate more, excluding the ones
      // we already have AND the ones already used.
      ideas = await generateMoreTopics(project.id, project.user_id, ideas, [...ideas, ...usedTopics]);
      topic = pick(ideas);
    }
    if (!topic) {
      return RESULT.attention("Couldn't find a fresh topic that hasn't been used — open the project to pick or add one.");
    }

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
    return await runPromptsStep(project, cfg);
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

// Topics already used by OTHER videos in the same channel/niche, so 1Click
// never repeats a topic that a video already exists for. Scopes by
// channel_url (canonical), falling back to channel_name; returns [] when
// neither is set (can't reliably scope → don't over-exclude).
async function usedTopicsForChannel(
  userId: string, projectId: string, channelUrl: string | null, channelName: string | null,
): Promise<string[]> {
  let q = supabase
    .from("projects")
    .select("selected_topic")
    .eq("user_id", userId)
    .neq("id", projectId)
    .not("selected_topic", "is", null);
  if (channelUrl) q = q.eq("channel_url", channelUrl);
  else if (channelName) q = q.eq("channel_name", channelName);
  else return [];
  const { data } = await q;
  return (data ?? []).map((r) => (r.selected_topic as string | null) ?? "").filter(Boolean);
}

// Generate more topic ideas for a project, excluding ones already on hand
// or already used — a 1:1 mirror of /api/workflow/ideas. Appends the fresh,
// deduped ideas to video_ideas and returns the combined list.
async function generateMoreTopics(
  projectId: string, userId: string, existingIdeas: string[], exclude: string[],
): Promise<string[]> {
  const { data: proj } = await supabase
    .from("projects").select("channel_analysis, channel_info").eq("id", projectId).single();
  if (!proj?.channel_analysis) return existingIdeas;
  const topVideos = (proj.channel_info as { topVideos?: Array<{ title?: string }> } | null)?.topVideos ?? [];
  const topTitles = topVideos.map((v) => (v.title ?? "").trim()).filter(Boolean);
  try {
    const { client } = await getAnthropicClient(userId, "ideas");
    const res = await client.messages.create({
      ...await resolveDefaultModel("ideas"),
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [{ name: "save_video_ideas", description: "Save the generated video ideas", input_schema: videoIdeasInputSchema }],
      tool_choice: { type: "tool", name: "save_video_ideas" },
      messages: [{ role: "user", content: buildVideoIdeasPrompt(proj.channel_analysis as Parameters<typeof buildVideoIdeasPrompt>[0], undefined, topTitles, exclude) }],
    });
    const toolUse = res.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return existingIdeas;
    const parsed = VideoIdeasSchema.safeParse(toolUse.input);
    if (!parsed.success) return existingIdeas;
    // Dedupe against everything we already have or excluded.
    const seen = new Set([...existingIdeas, ...exclude].map((t) => t.toLowerCase().trim()));
    const fresh = parsed.data.ideas.filter((t) => {
      const k = t.toLowerCase().trim();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (fresh.length === 0) return existingIdeas;
    const combined = [...existingIdeas, ...fresh];
    await supabase.from("projects").update({ video_ideas: combined }).eq("id", projectId);
    return combined;
  } catch (err) {
    console.warn(`[one-click] generateMoreTopics failed for ${projectId}:`, err instanceof Error ? err.message : err);
    return existingIdeas;
  }
}

// Apply the user's 1Click script-length setting: use the whole script when
// fullScript is on, otherwise only the first N words. This drives how much
// of the script feeds the rest of the pipeline (prompts, beats, voiceovers,
// images, videos, assembly). Defaults to 20 words when unset.
function sliceScriptForConfig(script: string, cfg: OneClickConfig): string {
  const limit = cfg.scriptLimit;
  if (!limit || limit.fullScript) return script;
  const n = Number.isInteger(limit.words) && limit.words > 0 ? limit.words : 20;
  const words = script.trim().split(/\s+/).filter(Boolean);
  if (words.length <= n) return script;
  console.log(`[one-click] script length: using first ${n} of ${words.length} words`);
  return words.slice(0, n).join(" ");
}

// Generate the script the same way the script route does (buildScriptPrompt
// + Claude), non-streaming, then persist and advance to state 7.
async function runScriptStep(project: ProjectRow, cfg: OneClickConfig): Promise<AdvanceResult> {
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
      ...await resolveDefaultModel("script"),
      max_tokens: 8192,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildScriptPrompt(analysis, topic) }],
    });
    script = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  } catch (err) {
    return RESULT.attention(`Script generation failed. ${friendlyError(err instanceof Error ? err.message : null)}`);
  }
  if (!script) return RESULT.attention("The script came back empty — open the project and retry.");

  // Apply the user's script-length setting so the ENTIRE downstream flow
  // (prompts, beats, voiceovers, images, videos, thumbnails) and the UI
  // word count are based on the chosen length. Full-script → unchanged.
  script = sliceScriptForConfig(script, cfg);

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

  // Capture two auto-sampled frames per video (YouTube exposes 1/2/3.jpg).
  // Fetch each frame ONCE server-side, then (a) upload the bytes to R2 for
  // the stored auto_frames, and (b) keep the bytes as base64 for the vision
  // call. Passing base64 — instead of R2 URLs — means Anthropic never has
  // to download the images itself, which is what was timing out ("the
  // request timed out while trying to download the file").
  const folder = `${userFolderFor({ id: project.user_id, email: null })}/${project.id}/auto-frames`;
  const captured = await Promise.all(videos.map(async ({ videoId, title }) => {
    const frames = (await Promise.all([1, 3].map(async (n) => {
      try {
        const res = await fetch(`https://img.youtube.com/vi/${videoId}/${n}.jpg`);
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 100) return null; // 404s can return a near-empty body
        const r2Url = await uploadBuffer(`${folder}/${videoId}-frame-${n}.jpg`, buf, "image/jpeg");
        return { r2Url, base64: Buffer.from(buf).toString("base64") };
      } catch { return null; }
    }))).filter((f): f is { r2Url: string; base64: string } => !!f);
    return { videoId, title, thumbnailUrl: "", frameUrls: frames.map((f) => f.r2Url), base64s: frames.map((f) => f.base64) };
  }));
  const framesByVideo = captured.map(({ videoId, title, thumbnailUrl, frameUrls }) => ({ videoId, title, thumbnailUrl, frameUrls }));
  const visionCfg = await getVisionConfig();
  // One frame per video before a second from any of them, so the cap keeps every
  // video represented rather than the first few twice. Mirrors spreadAcrossVideos
  // in the visual-analysis route; here the grouping is already per-capture.
  const byVideo = captured.map((c) => c.base64s);
  const deepest = Math.max(0, ...byVideo.map((b) => b.length));
  const spread: string[] = [];
  for (let round = 0; round < deepest; round++) {
    for (const frames of byVideo) if (frames[round]) spread.push(frames[round]);
  }
  const base64Frames = spread.slice(0, visionCfg.maxImages);
  if (base64Frames.length === 0) return RESULT.attention("Couldn't capture reference frames — finish the visuals step in the editor.");

  // Vision analysis — video-only branch, so the tool returns just the
  // visualProfile and the step advances to state 9 (as the route does).
  const schema = {
    type: "object" as const,
    properties: { visualProfile: visualProfileInputSchema.properties.visualProfile },
    required: ["visualProfile"],
  };
  let visualProfile: VisualProfileOutput;
  try {
    const { client } = await getAnthropicClient(project.user_id, "visual_analysis");
    const callModel = () => client.messages.create({
      ...modelParamsFor(visionCfg.model),
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [{ name: "save_visual_analysis", description: "Save the extracted visual style profile", input_schema: schema }],
      tool_choice: { type: "tool", name: "save_visual_analysis" },
      messages: [{
        role: "user",
        content: [
          ...base64Frames.map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data } })),
          { type: "text" as const, text: buildVisualAnalysisPrompt({ video: true, thumbnails: false }) },
        ],
      }],
    });

    // KIE+Opus/Haiku sometimes ignore tool_choice and emit the JSON as a
    // text block (or a fake <tool_calls> wrapper) instead of a tool_use.
    // Mirror the manual visual-analysis route: two attempts to land a real
    // tool_use, then a text-mode fallback parser.
    let toolInput: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await retryClaudeCall(`one-click:visuals (try ${attempt + 1})`, callModel, 5);
      const toolUse = res.content.find((b) => b.type === "tool_use");
      if (toolUse && toolUse.type === "tool_use") { toolInput = toolUse.input as Record<string, unknown>; break; }
      if (attempt === 1) {
        const textBlock = res.content.find((b) => b.type === "text");
        const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
        toolInput = extractToolInputFromText(raw) as Record<string, unknown> | null;
      }
    }
    if (!toolInput) {
      throw new Error("No visual analysis returned — the model produced neither a tool call nor parseable JSON.");
    }

    // The model returns either { visualProfile: {...} } (happy path) or the
    // profile fields flat at the root. Handle both, exactly as the manual
    // route does — the raw `.visualProfile` assumption was what produced the
    // cryptic "expected object" Zod error when the model returned it flat.
    const rawProfile =
      (toolInput.visualProfile && typeof toolInput.visualProfile === "object")
        ? (toolInput.visualProfile as Record<string, unknown>)
        : (typeof toolInput.artStyle === "string" && Array.isArray(toolInput.colorPalette))
          ? toolInput
          : null;
    if (!rawProfile) {
      throw new Error(`Visual analysis returned an unrecognized shape (keys: ${Object.keys(toolInput).join(", ") || "(empty)"}).`);
    }

    // Validate INSIDE the try so a schema mismatch surfaces as a clean
    // needs_attention message instead of a raw ZodError bubbling to the tick.
    visualProfile = VisualProfileSchema.parse(rawProfile);
  } catch (err) {
    return RESULT.attention(`Visual analysis failed. ${friendlyError(err instanceof Error ? err.message : null)}`);
  }

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
async function runPromptsStep(project: ProjectRow, cfg: OneClickConfig): Promise<AdvanceResult> {
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
    // Respect the user's script-length setting (belt-and-braces for a
    // manually-written script that runScriptStep didn't slice). Full-script
    // → unchanged; otherwise only the first N words feed prompt generation.
    const genScript = sliceScriptForConfig(script, cfg);
    // Image prompts create the beats and set current_state back to 13
    // while running, then to 14 on completion.
    await generateImages(project.id, project.user_id, genScript, visualProfile, capture, (await resolveModelForUser(project.user_id, "image_prompts")).model);
    if (sendErr) return RESULT.attention(`Image prompt generation failed: ${sendErr}`);
    // Video prompts fill each beat's video_prompt (doesn't touch state).
    await generateVideos(project.id, project.user_id, capture, (await resolveModelForUser(project.user_id, "video_prompts")).model);
    if (sendErr) return RESULT.attention(`Video prompt generation failed: ${sendErr}`);
  } catch (err) {
    return RESULT.attention(`Prompt generation failed. ${friendlyError(err instanceof Error ? err.message : null)}`);
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
  image_model_id: string | null;
  video_url: string | null;
  video_status: string | null;
  video_job_id: string | null;
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
      // Same cost accounting as the route: ElevenLabs bills the ledger,
      // perk voices count against their free-usage caps.
      if (charsConsumed && !isQwenVoice(voiceId) && !isAi33Voice(voiceId)) {
        void logProjectCost({ projectId: project.id, userId: project.user_id, step: "tts", provider: "elevenlabs", model: TTS_MODEL, units: charsConsumed, unitKind: "elevenlabs_chars" });
      } else if (charsConsumed && isQwenVoice(voiceId)) {
        void incrementFreeUsage(project.user_id, "qwen_tts_chars", charsConsumed);
      } else if (charsConsumed && isAi33Voice(voiceId)) {
        void incrementFreeUsage(project.user_id, "ai33_tts_chars", charsConsumed);
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

  // Checked here, not at the top of the tick: this is the step that writes
  // images, clips and a video, and the returns above are the common case.
  const storageNote = await storageFullNote(project.user_id);
  if (storageNote) return RESULT.attention(storageNote);

  // Same place, same reason: a wallet-funded project must not keep generating on
  // Heclus's providers with nothing to bill it to. The tick stops and says so
  // rather than failing beat by beat, since 1Click runs unattended and the user
  // is not watching a banner.
  if (!(await canStartWalletWork(project.user_id))) {
    return RESULT.attention(OUT_OF_CREDITS_MESSAGE);
  }

  const attempts = (proj?.auto_pilot_attempts as Record<string, number> | null) ?? {};
  const imgIdx = attempts["genImageModelIdx"] ?? 0;
  const vidIdx = attempts["genVideoModelIdx"] ?? 0;

  const BEAT_COLS = "beat_number, image_prompt, video_prompt, image_url, image_status, image_task_id, image_model_id, video_url, video_status, video_job_id";
  const { data: beatData, error: beatErr } = await supabase
    .from("project_beats")
    .select(BEAT_COLS)
    .eq("project_id", project.id)
    .order("beat_number");
  if (beatErr) return RESULT.attention(`Couldn't read beats: ${beatErr.message}`);
  let beats = (beatData ?? []) as BeatRow[];
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
    // Character-consistency text (per-project override, else account
    // default), appended to each capped base prompt only for the KIE
    // submit — we persist the base below (without the text) so retries
    // never double-append and the stored prompt stays clean.
    const consistency = await resolveConsistency(project.user_id, project.id);
    let hardError: string | null = null;
    const submitOne = async (b: BeatRow): Promise<boolean> => {
      const basePrompt = b.image_prompt!.trim();
      const MAX_RETRIES = 5;
      let capIdx = 0; // 0 = full prompt; >0 = capped at PROMPT_LENGTH_CAPS[capIdx-1]
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const prompt = capIdx === 0 ? basePrompt : capPrompt(basePrompt, PROMPT_LENGTH_CAPS[capIdx - 1]);
        const sentPrompt = applyConsistency(prompt, consistency.text, consistency.append);
        try {
          const taskId = await submitImageTask(sentPrompt, imageModel, imgAr, imgRes, project.user_id);
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

  // Reconcile in-flight images against KIE NOW rather than waiting on the
  // 5-min finish-images cron — mirrors the manual generate page's image
  // poller (finishImageTask pulls a KIE-finished image into the DB). Without
  // this, an image "done on KIE" stays "generating" in the UI for minutes.
  const inFlightImg = beats.filter((b) => !imgDone(b) && b.image_task_id && (b.image_status === "generating" || b.image_status === "queued"));
  if (inFlightImg.length > 0) {
    await Promise.all(inFlightImg.map((b) =>
      finishImageTask({
        projectId: project.id, beatNumber: b.beat_number, taskId: b.image_task_id!,
        modelId: b.image_model_id ?? imageModel, userId: project.user_id, userEmail: null,
      }).catch(() => {}), // pending / transient KIE error — the next tick retries
    ));
    // Re-read so allImagesDone (and the UI's counts) reflect anything that
    // just finished, letting this same tick move on to videos.
    const { data: refreshed } = await supabase
      .from("project_beats").select(BEAT_COLS).eq("project_id", project.id).order("beat_number");
    if (refreshed) beats = refreshed as BeatRow[];
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
        await generateVideos(project.id, project.user_id, capture, (await resolveModelForUser(project.user_id, "video_prompts")).model);
        if (sendErr) return RESULT.attention(`Video prompt generation failed: ${sendErr}`);
      } catch (err) {
        return RESULT.attention(`Video prompt generation failed. ${friendlyError(err instanceof Error ? err.message : null)}`);
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

    // ── Stall recovery for stuck video beats ───────────────────────
    // A pending beat (queued/submitting/rendering) is left to the worker,
    // but the worker can drop it: an orphaned commit (KIE finished but the
    // URL was never written — "done on KIE, not a failure"), a crash, or a
    // queued beat it never picks up. The failed-beat re-queue above never
    // touches these, so the run would spin "Rendering…" forever. Recover
    // by re-queuing the stragglers once progress has clearly stalled.
    //
    // Guard: only intervene once SOME clips have finished. That proves the
    // model works and is reasonably fast, so a long gap is genuinely stuck
    // — and it avoids re-queuing a legitimately slow first render (where
    // nothing is done yet) and double-charging KIE.
    const pendingVids = beats.filter((b) => !vidDone(b) && b.video_prompt?.trim());
    const doneVids = beats.filter(vidDone).length;
    const snap = (attempts["vidDoneSnap"] as number | undefined) ?? -1;
    if (doneVids > snap) {
      // Progress since the last tick — reset the stall clock.
      attempts["vidDoneSnap"] = doneVids;
      delete attempts["vidStallSince"];
      attempts["vidRequeues"] = 0;
      await supabase.from("projects").update({ auto_pilot_attempts: attempts }).eq("id", project.id);
      return RESULT.waiting("Rendering video clips…");
    }

    // Beats never actually sent to KIE — queued/submitting but with NO
    // video_job_id — are the "worker never picked it up / dropped it"
    // case ("done on 4, the 5th never sent"). When other clips have
    // finished, that's clearly a drop rather than a slow render, so we
    // re-send those fast (short window). Beats that DO have a job id are
    // genuinely rendering on KIE — leave them to the worker/webhook.
    const notSubmitted = pendingVids.filter((b) => !b.video_job_id);
    const fast = notSubmitted.length > 0 && doneVids > 0;
    const STALL_MS = fast ? 90 * 1000 : 5 * 60 * 1000;
    const stallSince = attempts["vidStallSince"]; // epoch ms
    if (!stallSince) {
      attempts["vidStallSince"] = Date.now();
      await supabase.from("projects").update({ auto_pilot_attempts: attempts }).eq("id", project.id);
    } else if (doneVids > 0 && Date.now() - stallSince > STALL_MS) {
      const requeues = ((attempts["vidRequeues"] as number | undefined) ?? 0) + 1;
      if (requeues > 3) {
        return RESULT.attention(`Video generation stalled — ${doneVids}/${beats.length} clips rendered but the rest didn't finish. Retry the Videos step, or open the project to finish them.`);
      }
      attempts["vidRequeues"] = requeues;
      delete attempts["vidStallSince"];
      await supabase.from("projects").update({ auto_pilot_attempts: attempts }).eq("id", project.id);
      // Re-queue the stuck beats fresh (clear job id so the worker
      // resubmits). Fast path only re-sends the never-submitted ones so
      // we don't disturb clips actively rendering on KIE.
      const toRequeue = fast ? notSubmitted : pendingVids;
      for (const b of toRequeue) {
        await supabase.from("project_beats").update({
          video_status: "queued", video_job_id: null, video_error: null,
          video_model_id: videoModel, video_aspect_ratio: vidAr,
          video_duration: vidDur, video_resolution: vidRes,
        }).eq("project_id", project.id).eq("beat_number", b.beat_number);
      }
      return RESULT.waiting(`Re-sent ${toRequeue.length} video clip${toRequeue.length === 1 ? "" : "s"} that weren't picked up…`);
    }
    return RESULT.waiting("Rendering video clips…");
  }

  return RESULT.waiting("Generating images…");
}

// Finish the run: mark state 16, stamp completion time, send the "video
// ready" email (if opted in), and return done(). Reused by the normal
// thumbnails-done path AND the thumbnail-give-up fallbacks — a finished
// video must never be trapped by a thumbnail hiccup.
async function completeRun(project: ProjectRow, cfg: OneClickConfig): Promise<AdvanceResult> {
  await supabase.from("projects").update({ current_state: 16 }).eq("id", project.id);
  // Best-effort + separate so a missing migration-098 column can't block it.
  await supabase.from("projects")
    .update({ auto_pilot_completed_at: new Date().toISOString() })
    .eq("id", project.id)
    .then(undefined, () => {});
  if (cfg.notifications?.onComplete !== false) {
    await sendCompletionEmail(project.id, project.user_id).catch((e) =>
      console.error(`[one-click] completion email failed for ${project.id}:`, e instanceof Error ? e.message : e));
  } else {
    console.log(`[one-click] completion email skipped for ${project.id} (notifications.onComplete=false)`);
  }
  return RESULT.done();
}

// Bump a named attempt counter and report whether the cap is reached.
async function bumpAttempt(projectId: string, key: string, cap: number): Promise<boolean> {
  const { data: row } = await supabase.from("projects").select("auto_pilot_attempts").eq("id", projectId).single();
  const att = (row?.auto_pilot_attempts as Record<string, number> | null) ?? {};
  const n = (att[key] ?? 0) + 1;
  att[key] = n;
  await supabase.from("projects").update({ auto_pilot_attempts: att }).eq("id", projectId);
  return n >= cap;
}

// State 15 (video assembled): generate thumbnail concepts + images
// automatically, then mark complete (state 16). Concepts reuse the
// prompts route's generateThumbnails (Claude); images reuse generateImage
// batched by the admin's thumbnail_batch with 429 retry, mirroring the
// manual thumbnail-images route. Thumbnails are the LAST step and the video
// is already assembled, so a persistent thumbnail failure must NOT trap the
// finished video — after a few retries we complete the run without them.
async function runThumbnailsStep(project: ProjectRow, cfg: OneClickConfig): Promise<AdvanceResult> {
  const { data, error } = await supabase
    .from("projects")
    .select("script, visual_profile, thumbnail_analysis")
    .eq("id", project.id)
    .single();
  const script = (data?.script as string | null)?.trim();
  const visualProfile = data?.visual_profile as VisualProfileOutput | null;
  if (error || !script || !visualProfile) {
    // The video is already assembled — don't trap it. Complete without
    // thumbnails; the user can generate them in the editor.
    console.warn(`[one-click] thumbnails skipped for ${project.id}: missing script/visual profile`);
    return await completeRun(project, cfg);
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
    let failure: string | null = null;
    try {
      await generateThumbnails(project.id, project.user_id, script, visualProfile,
        (data?.thumbnail_analysis as ThumbnailAnalysisOutput | undefined) ?? undefined, capture, (await resolveModelForUser(project.user_id, "thumbnails")).model);
      if (sendErr) failure = sendErr;
    } catch (err) {
      failure = err instanceof Error ? err.message : "unknown error";
    }
    if (!failure) {
      const { data: created } = await supabase
        .from("project_thumbnails").select("position, image_url").eq("project_id", project.id).order("position");
      thumbs = created ?? [];
      if (thumbs.length === 0) failure = "no concepts returned";
    }
    if (failure) {
      // Retry a few times (Claude/KIE occasionally returns a malformed
      // shape), then finish WITHOUT thumbnails — the video is done, so a
      // thumbnail hiccup shouldn't block completion.
      if (await bumpAttempt(project.id, "thumbConceptAttempts", 3)) {
        console.warn(`[one-click] thumbnails skipped for ${project.id} — concepts failed: ${failure}`);
        return await completeRun(project, cfg);
      }
      return RESULT.waiting("Generating thumbnail concepts…");
    }
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
      if (hardError) {
        // Retry a few times, then complete without the remaining thumbnail
        // images — the finished video must not be trapped.
        if (await bumpAttempt(project.id, "thumbImageAttempts", 3)) {
          console.warn(`[one-click] thumbnails partially generated for ${project.id} — image gen failed: ${hardError}`);
          return await completeRun(project, cfg);
        }
        return RESULT.waiting("Retrying thumbnail images…");
      }
      if (i + batchSize < missing.length) await new Promise((r) => setTimeout(r, 1500));
    }
    return RESULT.waiting(`Generating ${missing.length} thumbnail${missing.length === 1 ? "" : "s"}…`);
  }

  // 3) All thumbnails done → finish the run.
  return await completeRun(project, cfg);
}

// Look up a user's email by id (service-role listUsers). Shared by the
// completion + attention emails.
async function getUserEmail(userId: string): Promise<string | null> {
  const { data: users } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  return users?.users.find((u) => u.id === userId)?.email ?? null;
}

const APP_URL = () => process.env.NEXT_PUBLIC_APP_URL_PRODUCTION ?? process.env.APP_URL ?? "https://app.heclus.io";
// Brand theme color (hex approximation of the app's oklch(0.72 0.25 285))
// — email clients don't support oklch, so we use the closest hex.
const BRAND = "#7c5cff";

// Escape user/AI-supplied text before interpolating into the HTML email.
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Fetch the white Heclus logo so it can be embedded inline (cid:) in the
// email — remote <img src> URLs get blocked by many clients, so we attach
// the bytes instead. Fail-soft: null → the header falls back to text only.
async function fetchLogoAttachment(): Promise<{ filename: string; content: Buffer; cid: string; contentType: string } | null> {
  try {
    const res = await fetch(`${APP_URL()}/heclus-icon-white.png`);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 100) return null;
    return { filename: "heclus.png", content: buf, cid: "heclus-logo", contentType: "image/png" };
  } catch {
    return null;
  }
}

// Branded, email-client-safe HTML shell (table layout + inline styles):
// a theme-purple header band carrying the white Heclus logo (embedded via
// cid), then the message on white, a purple button, an optional note box +
// secondary link. `logoCid` set → render the inline logo; otherwise the
// header shows just the "Heclus" wordmark.
function emailHtml(opts: {
  heading: string; intro: string; note?: string;
  buttonLabel: string; buttonUrl: string; secondary?: { label: string; url: string };
  logoCid?: string;
}): string {
  const { heading, intro, note, buttonLabel, buttonUrl, secondary, logoCid } = opts;
  const logoImg = logoCid
    ? `<td style="vertical-align:middle;"><img src="cid:${logoCid}" alt="Heclus" width="26" height="26" style="display:block;border:0;outline:none;" /></td><td style="vertical-align:middle;padding-left:9px;">`
    : `<td style="vertical-align:middle;">`;
  return `<div style="margin:0;padding:0;background:#0b0b0f;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0f;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="background:${BRAND};padding:20px 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            ${logoImg}<span style="font-size:17px;font-weight:800;color:#ffffff;letter-spacing:0.3px;">Heclus</span></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:28px 32px 0;"><h1 style="margin:0;font-size:20px;line-height:1.3;color:#18181b;">${esc(heading)}</h1></td></tr>
        <tr><td style="padding:12px 32px 0;"><p style="margin:0;font-size:14px;line-height:1.6;color:#52525b;">${intro}</p>${note ? `<div style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#71717a;background:#f4f4f5;border-radius:10px;padding:12px 14px;">${esc(note)}</div>` : ""}</td></tr>
        <tr><td style="padding:24px 32px 0;"><a href="${buttonUrl}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;">${esc(buttonLabel)}</a></td></tr>
        ${secondary ? `<tr><td style="padding:14px 32px 0;"><a href="${secondary.url}" style="font-size:13px;color:${BRAND};text-decoration:none;">${esc(secondary.label)}</a></td></tr>` : ""}
        <tr><td style="padding:28px 32px 28px;"><p style="margin:0;font-size:12px;line-height:1.5;color:#a1a1aa;">You're receiving this because 1Click autopilot is running on your Heclus account.</p></td></tr>
      </table>
    </td></tr>
  </table>
</div>`;
}

// "Your video is ready" email — customized HTML with a "View video" button
// that opens the finished video in the browser. Throws on failure so the
// caller can log it (a hands-off run must not silently drop this).
async function sendCompletionEmail(projectId: string, userId: string): Promise<void> {
  const email = await getUserEmail(userId);
  if (!email) { console.warn(`[one-click] completion email: no address for user ${userId}`); return; }
  const { data: proj } = await supabase.from("projects").select("selected_topic, assembled_url").eq("id", projectId).single();
  const topic = (proj?.selected_topic as string | null) ?? "your video";
  const assembledUrl = (proj?.assembled_url as string | null) ?? null;
  const appUrl = APP_URL();
  const projectUrl = `${appUrl}/projects/${projectId}/one-click`;
  // "View video" opens the finished video directly in the browser; fall
  // back to the project's final-preview page if the URL isn't stored.
  const viewUrl = assembledUrl ?? projectUrl;
  const logo = await fetchLogoAttachment();
  const { messageId } = await sendEmail({
    from: "notify@heclus.com",
    to: email,
    subject: `Your video "${topic}" is ready`,
    text: `Your 1Click video "${topic}" is ready.\n\nView video: ${viewUrl}\nOpen in Heclus: ${projectUrl}\n\nHeclus`,
    attachments: logo ? [logo] : undefined,
    html: emailHtml({
      heading: "Your video is ready",
      intro: `1Click just finished <strong style="color:#18181b;">“${esc(topic)}”</strong>. It's ready to watch, review, and export.`,
      buttonLabel: "View video",
      buttonUrl: viewUrl,
      secondary: { label: "Open in Heclus", url: projectUrl },
      logoCid: logo?.cid,
    }),
  });
  console.log(`[one-click] completion email sent to ${email} for ${projectId} (msg ${messageId})`);
}

// "1Click needs you" email — customized HTML. Sent when a run pauses for
// manual input or hits an error, gated on the user's notification pref.
export async function sendAttentionEmail(projectId: string, userId: string, note: string): Promise<void> {
  const email = await getUserEmail(userId);
  if (!email) { console.warn(`[one-click] attention email: no address for user ${userId}`); return; }
  const { data: proj } = await supabase.from("projects").select("selected_topic").eq("id", projectId).single();
  const topic = (proj?.selected_topic as string | null) ?? "your video";
  const appUrl = APP_URL();
  const projectUrl = `${appUrl}/projects/${projectId}/one-click`;
  const logo = await fetchLogoAttachment();
  const cleanNote = note.replace(/\s*—\s*/g, " - "); // no em-dashes in email
  const { messageId } = await sendEmail({
    from: "notify@heclus.com",
    to: email,
    subject: `Your 1Click run needs you: "${topic}"`,
    text: `1Click paused on "${topic}" and needs your attention:\n\n${cleanNote}\n\nOpen it: ${projectUrl}\n\nHeclus`,
    attachments: logo ? [logo] : undefined,
    html: emailHtml({
      heading: "1Click needs your input",
      intro: `1Click paused on <strong style="color:#18181b;">“${esc(topic)}”</strong> and needs your attention:`,
      note: cleanNote,
      buttonLabel: "Open project",
      buttonUrl: projectUrl,
      logoCid: logo?.cid,
    }),
  });
  console.log(`[one-click] attention email sent to ${email} for ${projectId} (msg ${messageId})`);
}
