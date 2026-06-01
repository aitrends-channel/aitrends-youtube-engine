import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
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

export const maxDuration = 800;

function assertComplete(stopReason: string | null | undefined, label: string) {
  if (stopReason === "max_tokens") {
    throw new Error(`Response was cut off during "${label}". Please try again.`);
  }
}

// KIE+Opus occasionally ignores tool_choice forcing and emits a *fake*
// tool-call structure as plain text (e.g. `<tool_calls>[{"input":
// {"beats":[...]}}]</tool_calls>`). A naive greedy regex either grabs
// too much (post-amble commentary) or too little (truncated tail). This
// parser:
//   1. Locates `"beats"` anywhere in the text (handles wrapper formats).
//   2. Bracket-counts (string-aware) to find the matching `]`.
//   3. Falls back to extracting complete beat objects via regex when
//      the array is truncated mid-write.
function extractBeatsFromText(raw: string): { beats: Array<{ beatNumber: number; videoPrompt: string }> } | null {
  const beatsKeyIdx = raw.indexOf('"beats"');
  if (beatsKeyIdx === -1) return null;
  const arrStart = raw.indexOf("[", beatsKeyIdx);
  if (arrStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let arrEnd = -1;
  for (let j = arrStart; j < raw.length; j++) {
    const ch = raw[j];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) { arrEnd = j; break; } }
  }

  if (arrEnd !== -1) {
    try {
      const arr = JSON.parse(raw.slice(arrStart, arrEnd + 1));
      if (Array.isArray(arr) && arr.length > 0) return { beats: arr };
    } catch { /* fall through to per-beat recovery */ }
  }

  const beats: Array<{ beatNumber: number; videoPrompt: string }> = [];
  const beatRe = /\{\s*"beatNumber"\s*:\s*(\d+)\s*,\s*"videoPrompt"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  const partial = raw.slice(arrStart);
  let m: RegExpExecArray | null;
  while ((m = beatRe.exec(partial)) !== null) {
    try {
      beats.push({
        beatNumber: parseInt(m[1], 10),
        videoPrompt: JSON.parse(`"${m[2]}"`),
      });
    } catch { /* skip malformed beat */ }
  }
  return beats.length > 0 ? { beats } : null;
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
//
// Beats are identified semantically (one per new action/subject/fact/etc)
// rather than mechanically by word count. The model decides how many
// beats each script chunk needs; we never cap or summarize. For
// long-form scripts that would produce 50-150+ beats overall, we chunk
// the script BEFORE sending so each Claude call's output stays under
// the 8192-token ceiling. The startBeat parameter keeps numbering
// continuous across chunks.
async function generateImages(
  projectId: string,
  userId: string,
  script: string,
  visualProfile: VisualProfileOutput,
  send: (data: object) => void
) {
  const anthropic = await getAnthropicClient(userId);

  // Each beat's structured output runs ~80-120 output tokens (segment +
  // imagePrompt + camera + lighting + mood + action). Opus's per-call
  // ceiling is 8192 — chunking the script at ~1500 words keeps the
  // expected ~60-100 beats per chunk well under that ceiling with
  // headroom for the model's preamble and JSON overhead.
  const SCRIPT_CHUNK_WORDS = 1500;
  const words = script.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += SCRIPT_CHUNK_WORDS) {
    chunks.push(words.slice(i, i + SCRIPT_CHUNK_WORDS).join(" "));
  }
  if (chunks.length === 0) chunks.push(script);

  send({ type: "status", message: `Generating image prompts across ${chunks.length} script segment${chunks.length === 1 ? "" : "s"}...` });

  type ImageBeat = {
    beatNumber: number;
    scriptSegment: string;
    imagePrompt: string;
    camera: string;
    lighting: string;
    mood: string;
    action: string;
  };
  const allBeats: ImageBeat[] = [];
  let nextBeatNumber = 1;

  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) send({ type: "progress", current: i + 1, total: chunks.length });

    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [{ name: "save_image_prompts", description: "Save image prompts for every visual beat in the chunk", input_schema: imagePromptsInputSchema }],
      tool_choice: { type: "tool", name: "save_image_prompts" },
      messages: [{ role: "user", content: buildImagePromptsPrompt(chunks[i], visualProfile, nextBeatNumber) }],
    });

    assertComplete(res.stop_reason, `image prompts chunk ${i + 1}/${chunks.length}`);

    const tool = res.content.find((b) => b.type === "tool_use");
    if (!tool || tool.type !== "tool_use") throw new Error(`No image prompts returned for chunk ${i + 1}. Try again.`);
    const input = tool.input as Record<string, unknown>;
    if (!Array.isArray(input.beats) || input.beats.length === 0) throw new Error(`Chunk ${i + 1} returned no beats. Try again.`);

    const chunkBeats = ImagePromptsSchema.parse(input).beats;
    allBeats.push(...chunkBeats);
    nextBeatNumber = (chunkBeats[chunkBeats.length - 1]?.beatNumber ?? nextBeatNumber + chunkBeats.length - 1) + 1;
  }

  await supabase.from("project_beats").delete().eq("project_id", projectId);
  const { error: insertError } = await supabase.from("project_beats").insert(
    allBeats.map((b) => ({
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
  send({ type: "done", beatCount: allBeats.length });
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

  // Smaller chunks + more output headroom. Opus occasionally ignores
  // tool_choice and emits a fake `<tool_calls>` text format; when that
  // happens, larger chunks are more likely to truncate mid-JSON and
  // become unparseable. 5 beats per chunk keeps each call well below
  // the model's tendency to drift, with extractBeatsFromText as the
  // text-mode safety net.
  const CHUNK_SIZE = 5;
  const chunks: typeof beats[] = [];
  for (let i = 0; i < beats.length; i += CHUNK_SIZE) chunks.push(beats.slice(i, i + CHUNK_SIZE));

  send({ type: "status", message: `Generating motion prompts for ${beats.length} beats...` });

  const allVideoBeats: Array<{ beatNumber: number; videoPrompt: string }> = [];

  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) send({ type: "progress", current: i + 1, total: chunks.length });

    // One retry on tool-use miss — KIE occasionally returns text-only
    // even with tool_choice forced. A fresh call usually picks the tool.
    let res!: Anthropic.Messages.Message;
    let tool: Anthropic.Messages.ContentBlock | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 8192,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [{ name: "save_video_prompts", description: "Save video prompts for all beats", input_schema: videoPromptsInputSchema }],
        tool_choice: { type: "tool", name: "save_video_prompts" },
        messages: [{ role: "user", content: buildVideoPromptsPrompt(chunks[i], visualProfile) }],
      });
      tool = res.content.find((b) => b.type === "tool_use");
      const blockTypes = res.content.map((b) => b.type).join(",");
      console.log(`[video-prompts] batch ${i + 1}/${chunks.length} attempt ${attempt + 1} stop=${res.stop_reason} blocks=${blockTypes} tool_use=${!!tool}`);
      if (tool && tool.type === "tool_use") break;
    }

    assertComplete(res.stop_reason, `video batch ${i + 1}/${chunks.length}`);

    // Preferred path: model used the tool, take its input directly.
    let input: Record<string, unknown> | null = null;
    if (tool && tool.type === "tool_use") {
      input = tool.input as Record<string, unknown>;
    } else {
      // Fallback path: KIE+Opus sometimes emits the JSON as text instead
      // of invoking the tool, wrapped in a fake `<tool_calls>` shell.
      // extractBeatsFromText handles wrapper detection, string-aware
      // bracket counting, and per-beat recovery for truncated tails.
      const textBlock = res.content.find((b) => b.type === "text");
      const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
      console.log(`[video-prompts] batch ${i + 1} fallback parsing text len=${raw.length} head=${raw.slice(0, 200)}`);
      const parsed = extractBeatsFromText(raw);
      if (parsed) {
        input = parsed as unknown as Record<string, unknown>;
        console.log(`[video-prompts] batch ${i + 1} fallback recovered ${parsed.beats.length} beats`);
      }
    }

    if (!input) throw new Error(`No video prompts for batch ${i + 1} after retry`);
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
