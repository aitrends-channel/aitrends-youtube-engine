import { supabase } from "@/lib/supabase/client";
import { getAnthropicClient, MODEL, VISION_MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import { buildScriptPrompt, buildVisualAnalysisPrompt } from "@/lib/claude/prompts";
import { visualProfileInputSchema } from "@/lib/claude/anthropicSchemas";
import { VisualProfileSchema } from "@/lib/claude/schemas";
import { retryClaudeCall } from "@/lib/claude/retry";
import { uploadFromUrl, userFolderFor } from "@/lib/supabase/storage";
import { PROMPT_MODEL } from "@/lib/claude/client";
import { generateImages, generateVideos } from "@/lib/workflow/prompts-core";
import { submitImageTask } from "@/lib/kie/images";
import { getModelConfig } from "@/lib/kie/imageModels";
import { getVideoModelConfig } from "@/lib/kie/videoModels";
import { redis } from "@/lib/queue/client";
import { sendEmail } from "@/lib/email/smtp";
import type { VisualProfileOutput } from "@/lib/claude/schemas";
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

  // ── Generate + assemble (state 14 → complete) ────────────────────
  if (state === 14) return await runGenerateStep(project, cfg);
  if (state >= 15) return RESULT.done();

  // ── Channel not finished (shouldn't happen — runs at kickoff) ────
  return RESULT.attention("Channel analysis hasn't completed — open the project to finish setup.");
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
    // Image prompts create the beats and set current_state back to 13
    // while running, then to 14 on completion.
    await generateImages(project.id, project.user_id, script, visualProfile, capture, PROMPT_MODEL);
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
    await sendCompletionEmail(project.id, project.user_id).catch(() => {});
    await supabase.from("projects").update({ current_state: 15 }).eq("id", project.id).lt("current_state", 15);
    return RESULT.done();
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
    for (const b of toSubmitImg) {
      try {
        const taskId = await submitImageTask(b.image_prompt!.trim(), imageModel, imgAr, imgRes, project.user_id);
        await supabase.from("project_beats")
          .update({ image_status: "generating", image_task_id: taskId, image_model_id: imageModel })
          .eq("project_id", project.id).eq("beat_number", b.beat_number);
      } catch (err) {
        // Hard failure to even submit (bad credits/model) → surface it.
        return RESULT.attention(`Image generation failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }
    return RESULT.waiting(`Generating ${toSubmitImg.length} image${toSubmitImg.length === 1 ? "" : "s"}…`);
  }

  // ── Videos (queue once images exist; worker picks them up) ────────
  const allImagesDone = beats.every(imgDone);
  if (allImagesDone) {
    const vidDone = (b: BeatRow) => !!b.video_url;
    const vidPending = (b: BeatRow) => !vidDone(b) && (b.video_status === "queued" || b.video_status === "submitting" || b.video_status === "rendering");
    const vidFailed = (b: BeatRow) => !vidDone(b) && !vidPending(b);
    const videoModel = chainModel(cfg.videos, vidIdx);
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
      for (const b of toQueueVid) {
        await supabase.from("project_beats").update({
          video_status: "queued", video_job_id: null, video_error: null,
          video_model_id: videoModel, video_aspect_ratio: vidAr,
          video_duration: vidDur, video_resolution: vidRes,
        }).eq("project_id", project.id).eq("beat_number", b.beat_number);
      }
      return RESULT.waiting(`Rendering ${toQueueVid.length} video clip${toQueueVid.length === 1 ? "" : "s"}…`);
    }

    // ── All media done → trigger assembly ──────────────────────────
    if (beats.every(vidDone)) {
      const a = cfg.assemble;
      const options = {
        aspectRatio: cfg.output.aspectRatio,
        captionsEnabled: a.captionsEnabled,
        captionsLanguage: a.captionsLanguage,
        captionsStyle: a.captionsStyle,
        captionsSize: a.captionsSize,
        captionsPosition: a.captionsPosition,
        backgroundMusicUrl: a.bgMusicUrl,
        backgroundMusicVolume: a.bgMusicVolume,
        logoUrl: a.logoUrl,
        logoX: a.logoX, logoY: a.logoY, logoSize: a.logoSize,
        // Map the picker's 1K/2K to a render preset the worker expects.
        resolution: cfg.output.resolution === "2K" ? "1440p" : "1080p",
      };
      await redis.set(`assembly:${project.id}`, JSON.stringify(options), { ex: 7200 });
      await supabase.from("projects").update({
        assembly_status: "queued", assembly_progress: "Queued…",
        assembly_error: null, assembly_stop_requested: false,
      }).eq("id", project.id);
      return RESULT.waiting("All clips ready — assembling the final video…");
    }
    return RESULT.waiting("Rendering video clips…");
  }

  return RESULT.waiting("Generating images…");
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
