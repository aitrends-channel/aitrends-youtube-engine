import { NextResponse } from "next/server";
import { getAnthropicClient, MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import {
  buildImagePromptsPrompt,
  buildVideoPromptsPrompt,
  buildThumbnailsPrompt,
} from "@/lib/claude/prompts";
import {
  ImagePromptsSchema,
  VideoPromptsSchema,
  ThumbnailsOutputSchema,
} from "@/lib/claude/schemas";
import {
  imagePromptsInputSchema,
  videoPromptsInputSchema,
  thumbnailsInputSchema,
} from "@/lib/claude/anthropicSchemas";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { VisualProfileOutput, ThumbnailAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 300;

function assertComplete(stopReason: string | null | undefined, label: string) {
  if (stopReason === "max_tokens") {
    throw new Error(`Response was cut off during "${label}". Please try again.`);
  }
}

function sseStream(handler: (send: (data: object) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        function send(data: object) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        }
        try {
          await handler(send);
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : "Generation failed" });
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    }
  );
}

// ── Step 1: Image prompts ──────────────────────────────────────────────────
async function generateImages(
  projectId: string,
  userId: string,
  script: string,
  visualProfile: VisualProfileOutput,
  send: (data: object) => void
) {
  const anthropic = await getAnthropicClient(userId);
  const words = script.trim().split(/\s+/);
  const WORDS_PER_BEAT = parseInt(process.env.WORDS_PER_BEAT ?? "25", 10);
  const targetBeats = Math.max(1, Math.round(words.length / WORDS_PER_BEAT));

  send({ type: "status", message: `Generating image prompts for ~${targetBeats} beats...` });

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [{ name: "save_image_prompts", description: "Save image prompts for all beats", input_schema: imagePromptsInputSchema }],
    tool_choice: { type: "tool", name: "save_image_prompts" },
    messages: [{ role: "user", content: buildImagePromptsPrompt(script, visualProfile, 1, targetBeats) }],
  });

  assertComplete(res.stop_reason, "image prompts");

  const tool = res.content.find((b) => b.type === "tool_use");
  if (!tool || tool.type !== "tool_use") throw new Error("No image prompts returned from Claude. Try again.");
  const input = tool.input as Record<string, unknown>;
  if (!Array.isArray(input.beats) || input.beats.length === 0) throw new Error("Claude returned no beats. Try again.");

  const beats = ImagePromptsSchema.parse(input).beats;
  const totalSaved = beats.length;

  await supabase.from("project_beats").delete().eq("project_id", projectId);
  const { error: insertError } = await supabase.from("project_beats").insert(
    beats.map((b) => ({
      project_id: projectId,
      beat_number: b.beatNumber,
      script_segment: b.scriptSegment,
      image_prompt: b.imagePrompt,
      camera: b.camera,
      lighting: b.lighting,
      mood: b.mood,
      action: b.action,
    }))
  );
  if (insertError) throw new Error(`Failed to save beats: ${insertError.message}`);

  await supabase.from("projects").update({ current_state: 14 }).eq("id", projectId).eq("user_id", userId);
  send({ type: "done", beatCount: totalSaved });
}

// ── Step 2: Video prompts ──────────────────────────────────────────────────
async function generateVideos(projectId: string, userId: string, send: (data: object) => void) {
  const anthropic = await getAnthropicClient(userId);
  send({ type: "status", message: "Loading beats..." });

  const [beatsRes, projectRes] = await Promise.all([
    supabase.from("project_beats").select("beat_number, script_segment, image_prompt").eq("project_id", projectId).order("beat_number"),
    supabase.from("projects").select("visual_profile").eq("id", projectId).eq("user_id", userId).single(),
  ]);

  if (beatsRes.error || !beatsRes.data?.length) throw new Error("No image beats found — generate image prompts first.");

  const visualProfile = (projectRes.data?.visual_profile ?? null) as VisualProfileOutput | null;
  const beats = beatsRes.data.map((b) => ({
    beatNumber: b.beat_number as number,
    scriptSegment: b.script_segment as string,
    imagePrompt: b.image_prompt as string,
  }));

  const CHUNK_SIZE = 20;
  const chunks: typeof beats[] = [];
  for (let i = 0; i < beats.length; i += CHUNK_SIZE) chunks.push(beats.slice(i, i + CHUNK_SIZE));

  send({ type: "status", message: `Generating motion prompts for ${beats.length} beats...` });

  const allVideoBeats: Array<{ beatNumber: number; videoPrompt: string }> = [];

  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) send({ type: "progress", current: i + 1, total: chunks.length });

    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [{ name: "save_video_prompts", description: "Save video prompts for all beats", input_schema: videoPromptsInputSchema }],
      tool_choice: { type: "tool", name: "save_video_prompts" },
      messages: [{ role: "user", content: buildVideoPromptsPrompt(chunks[i], visualProfile) }],
    });

    assertComplete(res.stop_reason, `video batch ${i + 1}/${chunks.length}`);

    const tool = res.content.find((b) => b.type === "tool_use");
    if (!tool || tool.type !== "tool_use") throw new Error(`No video prompts for batch ${i + 1}`);
    const input = tool.input as Record<string, unknown>;
    if (!Array.isArray(input.beats) || input.beats.length === 0) throw new Error(`Empty video prompts for batch ${i + 1}`);

    allVideoBeats.push(...VideoPromptsSchema.parse(input).beats);
  }

  await Promise.all(
    allVideoBeats.map((b) =>
      supabase.from("project_beats").update({ video_prompt: b.videoPrompt }).eq("project_id", projectId).eq("beat_number", b.beatNumber)
    )
  );

  send({ type: "done", beatCount: allVideoBeats.length });
}

// ── Step 3: Thumbnails ─────────────────────────────────────────────────────
async function generateThumbnails(
  projectId: string,
  userId: string,
  script: string,
  visualProfile: VisualProfileOutput,
  thumbnailAnalysis: ThumbnailAnalysisOutput | undefined,
  send: (data: object) => void
) {
  const anthropic = await getAnthropicClient(userId);
  send({ type: "status", message: "Generating 5 thumbnail concepts..." });

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [{ name: "save_thumbnails", description: "Save 5 thumbnail concepts", input_schema: thumbnailsInputSchema }],
    tool_choice: { type: "tool", name: "save_thumbnails" },
    messages: [{ role: "user", content: buildThumbnailsPrompt(script, visualProfile, thumbnailAnalysis) }],
  });

  assertComplete(res.stop_reason, "thumbnails");

  const tool = res.content.find((b) => b.type === "tool_use");
  if (!tool || tool.type !== "tool_use") throw new Error("No thumbnails returned from Claude");

  const { thumbnails } = ThumbnailsOutputSchema.parse(tool.input);

  await supabase.from("project_thumbnails").delete().eq("project_id", projectId);
  await supabase.from("project_thumbnails").insert(
    thumbnails.map((t) => ({
      project_id: projectId,
      position: t.position,
      title: t.title,
      visual_concept: t.visualConcept,
      text_overlay: t.textOverlay,
      emotion_trigger: t.emotionTrigger,
      style_prompt: t.stylePrompt,
    }))
  );

  send({ type: "done", thumbnailCount: thumbnails.length });
}

// ── Router ─────────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await req.json() as {
    step: "images" | "videos" | "thumbnails";
    projectId: string;
    script?: string;
    visualProfile?: VisualProfileOutput;
    thumbnailAnalysis?: ThumbnailAnalysisOutput;
  };

  const { step, projectId } = body;
  if (!projectId || !step) {
    return NextResponse.json({ error: "projectId and step are required" }, { status: 400 });
  }

  if (step === "images") {
    if (!body.script || !body.visualProfile) {
      return NextResponse.json({ error: "script and visualProfile are required" }, { status: 400 });
    }
    return sseStream((send) =>
      generateImages(projectId, user.id, body.script!, body.visualProfile!, send)
    );
  }

  if (step === "videos") {
    return sseStream((send) => generateVideos(projectId, user.id, send));
  }

  if (step === "thumbnails") {
    if (!body.script || !body.visualProfile) {
      return NextResponse.json({ error: "script and visualProfile are required" }, { status: 400 });
    }
    return sseStream((send) =>
      generateThumbnails(projectId, user.id, body.script!, body.visualProfile!, body.thumbnailAnalysis, send)
    );
  }

  return NextResponse.json({ error: `Unknown step: ${step}` }, { status: 400 });
}
