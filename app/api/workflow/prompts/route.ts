import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
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
import { retryClaudeCall } from "@/lib/claude/retry";
import { extractToolInputFromText } from "@/lib/claude/textFallback";
import type { VisualProfileOutput, ThumbnailAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 800;

function assertComplete(stopReason: string | null | undefined, label: string) {
  if (stopReason === "max_tokens") {
    throw new Error(`Response was cut off during "${label}". Please try again.`);
  }
}

// Cancellation signal for in-flight prompts generation. claimPromptsRun
// writes a fresh UUID on the project at start; assertPromptsRunActive
// re-reads it between chunks and throws if it's been replaced (newer
// run) or nulled (user cleared the step). The error message is unique
// so the SSE wrapper / client can recognize it as a user-driven cancel
// rather than a real failure.
const CANCELLED_MSG = "Prompts generation was cancelled — the step was cleared while in flight.";

async function claimPromptsRun(projectId: string, userId: string): Promise<string | null> {
  const runId = randomUUID();
  const { error } = await supabase
    .from("projects")
    .update({ prompts_active_run_id: runId })
    .eq("id", projectId)
    .eq("user_id", userId);
  if (error) {
    // Likely the migration hasn't run yet (column missing) — degrade to
    // no-cancellation rather than breaking every generation. Log so the
    // operator can spot and apply the migration.
    console.warn("[prompts-cancel] could not claim run id; cancellation disabled for this run", error);
    return null;
  }
  return runId;
}

async function assertPromptsRunActive(projectId: string, runId: string | null): Promise<void> {
  if (!runId) return;
  const { data, error } = await supabase
    .from("projects")
    .select("prompts_active_run_id")
    .eq("id", projectId)
    .single();
  if (error) {
    console.warn("[prompts-cancel] could not read run id; skipping check", error);
    return;
  }
  if (!data || data.prompts_active_run_id !== runId) {
    throw new Error(CANCELLED_MSG);
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
        let closed = false;
        function send(data: object) {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        }
        // SSE comment heartbeat. Image-prompt chunks spend 30-60s
        // blocked inside the Claude streaming call without emitting any
        // SSE bytes; Vercel's edge and intermediate proxies drop quiet
        // connections after ~30s, which the client then reports as a
        // "server closed the connection before finishing" timeout. A
        // ': keepalive\n\n' line every 15s keeps the stream warm
        // without triggering the client's JSON parse path (lines that
        // don't start with `data: ` are ignored).
        const HEARTBEAT_MS = 15_000;
        const heartbeat = setInterval(() => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(`: keepalive\n\n`)); }
          catch { /* controller may already be torn down */ }
        }, HEARTBEAT_MS);
        try {
          await handler(send);
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : "Generation failed" });
        } finally {
          closed = true;
          clearInterval(heartbeat);
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
  console.log(`[image-prompts] start project=${projectId} scriptWords=${script.trim().split(/\s+/).filter(Boolean).length}`);
  const runId = await claimPromptsRun(projectId, userId);
  const anthropic = await getAnthropicClient(userId);

  // Smaller chunks = smaller per-call payload = more chances of getting
  // past KIE+Opus's intermittent 500s. ~500 words/chunk produces ~30
  // beats × ~150 tokens ≈ 4500 output tokens, well under the 8192
  // ceiling, and each call finishes faster (30-60s typical) reducing
  // the surface area for KIE to drop the connection.
  const SCRIPT_CHUNK_WORDS = 500;
  const words = script.trim().split(/\s+/).filter(Boolean);
  const allChunks: string[] = [];
  for (let i = 0; i < words.length; i += SCRIPT_CHUNK_WORDS) {
    allChunks.push(words.slice(i, i + SCRIPT_CHUNK_WORDS).join(" "));
  }
  if (allChunks.length === 0) allChunks.push(script);

  // Sweep partially-written beats from a prior failed run before the
  // resume math looks at them. Without this, a beat with NULL or empty
  // image_prompt counts toward "covered words" — the route skips its
  // chunk and the bad beat is preserved forever. Two narrow deletes
  // keep this explicit; .or() syntax for the empty-string side gets
  // fussy with quoting.
  await supabase
    .from("project_beats")
    .delete()
    .eq("project_id", projectId)
    .is("image_prompt", null);
  await supabase
    .from("project_beats")
    .delete()
    .eq("project_id", projectId)
    .eq("image_prompt", "");

  // Resume support: if this project already has beats from an earlier
  // (timed-out) run, count their cumulative script-segment word count
  // and skip the chunks that prefix has already covered. This way a
  // retry only generates the remaining chunks instead of redoing work.
  const { data: existingBeats } = await supabase
    .from("project_beats")
    .select("beat_number, script_segment")
    .eq("project_id", projectId)
    .order("beat_number", { ascending: true });

  let coveredWords = 0;
  let nextBeatNumber = 1;
  if (existingBeats && existingBeats.length > 0) {
    for (const b of existingBeats) {
      coveredWords += (b.script_segment as string).trim().split(/\s+/).filter(Boolean).length;
    }
    nextBeatNumber = (existingBeats[existingBeats.length - 1].beat_number as number) + 1;
  }

  // Walk through chunks; skip ones whose end-of-script position is
  // already covered. We don't try to be exact — script_segments may
  // not perfectly tile the script — but this is good enough to skip
  // the bulk of redone work.
  const chunksToProcess: { content: string; chunkIndex: number; totalChunks: number }[] = [];
  let walkedWords = 0;
  for (let i = 0; i < allChunks.length; i++) {
    const chunkWords = allChunks[i].split(/\s+/).filter(Boolean).length;
    const chunkEnd = walkedWords + chunkWords;
    // Skip if this chunk's end is already covered by existing beats
    // (with a small slack so near-misses don't force a full redo).
    if (chunkEnd <= coveredWords - 50) {
      walkedWords = chunkEnd;
      continue;
    }
    chunksToProcess.push({ content: allChunks[i], chunkIndex: i, totalChunks: allChunks.length });
    walkedWords = chunkEnd;
  }

  if (chunksToProcess.length === 0 && existingBeats && existingBeats.length > 0) {
    // Already fully done — just bump state and report.
    await supabase.from("projects").update({ current_state: 14 }).eq("id", projectId).eq("user_id", userId);
    send({ type: "done", beatCount: existingBeats.length });
    return;
  }

  const isResume = existingBeats && existingBeats.length > 0 && chunksToProcess.length < allChunks.length;
  console.log(`[image-prompts] plan totalChunks=${allChunks.length} toProcess=${chunksToProcess.length} resume=${isResume} existingBeats=${existingBeats?.length ?? 0} nextBeatNumber=${nextBeatNumber}`);
  send({
    type: "status",
    message: isResume
      ? `Resuming — ${chunksToProcess.length} script segment${chunksToProcess.length === 1 ? "" : "s"} left to process...`
      : `Generating image prompts across ${chunksToProcess.length} script segment${chunksToProcess.length === 1 ? "" : "s"}...`,
  });

  let totalBeatCount = existingBeats?.length ?? 0;

  // Seed the progress bar with the count of chunks the resume math
  // already considers covered. Without this, a retry-from-chunk-N run
  // would render 0% until the first persistence event lands —
  // misleading users into thinking the work restarted.
  const alreadyDoneChunks = allChunks.length - chunksToProcess.length;
  if (allChunks.length > 1) {
    send({ type: "progress", current: alreadyDoneChunks, total: allChunks.length });
  }

  for (const { content, chunkIndex, totalChunks } of chunksToProcess) {
    // Cheap round-trip to check whether we've been cancelled — bail
    // before paying for the next Claude call.
    await assertPromptsRunActive(projectId, runId);

    const t0 = Date.now();
    console.log(`[image-prompts] chunk ${chunkIndex + 1}/${totalChunks} startBeat=${nextBeatNumber} words=${content.split(/\s+/).length}`);

    // Streaming + tool_use on Opus. Streaming keeps KIE's connection
    // warm with continuous delta events, and the SDK rebuilds the full
    // Message via finalMessage() so the parse logic stays the same.
    // Retry policy is bumped specifically for image-prompts (the chunk
    // most affected by KIE upstream blips): 5 attempts with longer
    // backoff buys time for transient KIE issues to clear.
    const res = await retryClaudeCall(
      `image prompts chunk ${chunkIndex + 1}/${totalChunks}`,
      async () => {
        const stream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: 8192,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [{ name: "save_image_prompts", description: "Save image prompts for every visual beat in the chunk", input_schema: imagePromptsInputSchema }],
          tool_choice: { type: "tool", name: "save_image_prompts" },
          messages: [{ role: "user", content: buildImagePromptsPrompt(content, visualProfile, nextBeatNumber) }],
        });
        for await (const _event of stream) { void _event; }
        return stream.finalMessage();
      },
      5
    );

    console.log(`[image-prompts] chunk ${chunkIndex + 1}/${totalChunks} done in ${Date.now() - t0}ms stop=${res.stop_reason}`);
    assertComplete(res.stop_reason, `image prompts chunk ${chunkIndex + 1}/${totalChunks}`);

    let input: Record<string, unknown> | null = null;
    const tool = res.content.find((b) => b.type === "tool_use");
    if (tool && tool.type === "tool_use") {
      input = tool.input as Record<string, unknown>;
    } else {
      const textBlock = res.content.find((b) => b.type === "text");
      const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
      console.log(`[image-prompts] chunk ${chunkIndex + 1} fallback parsing text len=${raw.length} head=${raw.slice(0, 200)}`);
      input = extractToolInputFromText(raw);
      if (input) console.log(`[image-prompts] chunk ${chunkIndex + 1} fallback recovered ${(input.beats as unknown[])?.length ?? 0} beats`);
    }

    if (!input) throw new Error(`No image prompts returned for chunk ${chunkIndex + 1}. Try again — any beats saved so far are preserved.`);
    if (!Array.isArray(input.beats) || input.beats.length === 0) throw new Error(`Chunk ${chunkIndex + 1} returned no beats. Try again — any beats saved so far are preserved.`);

    const parsed = ImagePromptsSchema.safeParse(input);
    if (!parsed.success) {
      // Surface which beats Claude returned blank so the next retry has
      // signal beyond the generic Zod issue list.
      const rawBeats = (input.beats as Array<Record<string, unknown>>) ?? [];
      const blankFields = rawBeats.map((b, i) => {
        const missing = ["imagePrompt", "camera", "lighting", "mood", "action", "scriptSegment"]
          .filter((k) => !b[k] || (typeof b[k] === "string" && (b[k] as string).trim() === ""));
        return missing.length ? `beat#${b.beatNumber ?? i}: missing=${missing.join(",")}` : null;
      }).filter(Boolean);
      console.error(`[image-prompts] chunk ${chunkIndex + 1} schema validation failed`, {
        beatCount: rawBeats.length,
        blankFields,
        zodIssues: parsed.error.issues,
      });
      throw new Error(`Chunk ${chunkIndex + 1} returned beats with missing fields (${blankFields.slice(0, 3).join("; ") || "schema mismatch"}). Try again — any beats saved so far are preserved.`);
    }
    const chunkBeats = parsed.data.beats;

    // Final cancellation check before persistence — the Claude call can
    // take 30-60s, plenty of time for the user to clear the step.
    await assertPromptsRunActive(projectId, runId);

    // Persist this chunk's beats immediately so a later failure
    // doesn't undo this chunk's work.
    const { error: insertError } = await supabase.from("project_beats").insert(
      chunkBeats.map((b) => ({
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
    if (insertError) throw new Error(`Failed to save beats for chunk ${chunkIndex + 1}: ${insertError.message}`);

    totalBeatCount += chunkBeats.length;
    nextBeatNumber = (chunkBeats[chunkBeats.length - 1]?.beatNumber ?? nextBeatNumber + chunkBeats.length - 1) + 1;

    // Emit progress AFTER persistence so the value tracks completed
    // work rather than chunks-just-starting (the old position).
    if (totalChunks > 1) send({ type: "progress", current: chunkIndex + 1, total: totalChunks });
  }

  await supabase.from("projects").update({ current_state: 14 }).eq("id", projectId).eq("user_id", userId);
  send({ type: "done", beatCount: totalBeatCount });
}

// ── Step 2: Video prompts ──────────────────────────────────────────────────
async function generateVideos(projectId: string, userId: string, send: (data: object) => void) {
  const runId = await claimPromptsRun(projectId, userId);
  const anthropic = await getAnthropicClient(userId);
  send({ type: "status", message: "Loading beats..." });

  const [beatsRes, projectRes] = await Promise.all([
    supabase.from("project_beats").select("beat_number, script_segment, image_prompt, video_prompt").eq("project_id", projectId).order("beat_number"),
    supabase.from("projects").select("visual_profile").eq("id", projectId).eq("user_id", userId).single(),
  ]);

  if (beatsRes.error) throw new Error(`Could not load beats: ${beatsRes.error.message}`);
  if (!beatsRes.data?.length) throw new Error("No image beats found. Image prompts may have been cleared or never generated — run the Image Prompts step before this one.");

  const visualProfile = (projectRes.data?.visual_profile ?? null) as VisualProfileOutput | null;

  // Resume support: skip beats that already have a video_prompt from a
  // prior (timed-out / errored) run. Only build chunks from the beats
  // that still need processing.
  const allBeats = beatsRes.data.map((b) => ({
    beatNumber: b.beat_number as number,
    scriptSegment: b.script_segment as string,
    imagePrompt: b.image_prompt as string,
    hasVideoPrompt: !!b.video_prompt,
  }));
  const alreadyDoneCount = allBeats.filter((b) => b.hasVideoPrompt).length;
  const pendingBeats = allBeats
    .filter((b) => !b.hasVideoPrompt)
    .map((b) => ({ beatNumber: b.beatNumber, scriptSegment: b.scriptSegment, imagePrompt: b.imagePrompt }));

  if (pendingBeats.length === 0) {
    send({ type: "status", message: "All video prompts already generated." });
    send({ type: "done", beatCount: allBeats.length });
    return;
  }

  // Smaller chunks + more output headroom. Opus occasionally ignores
  // tool_choice and emits a fake `<tool_calls>` text format; when that
  // happens, larger chunks are more likely to truncate mid-JSON and
  // become unparseable. 5 beats per chunk keeps each call well below
  // the model's tendency to drift, with extractBeatsFromText as the
  // text-mode safety net.
  const CHUNK_SIZE = 5;
  const chunks: typeof pendingBeats[] = [];
  for (let i = 0; i < pendingBeats.length; i += CHUNK_SIZE) chunks.push(pendingBeats.slice(i, i + CHUNK_SIZE));

  // Emit progress as ABSOLUTE chunk-index over the full total (including
  // already-done chunks from a prior run). UI shows e.g. `16/24` on
  // resume instead of restarting at `1/9`.
  const totalChunksAbsolute = Math.ceil(allBeats.length / CHUNK_SIZE);
  const startChunkIdx = Math.floor(alreadyDoneCount / CHUNK_SIZE);

  console.log(`[video-prompts] start project=${projectId} totalBeats=${allBeats.length} alreadyDone=${alreadyDoneCount} pending=${pendingBeats.length} pendingChunks=${chunks.length} totalChunksAbs=${totalChunksAbsolute} startChunkIdx=${startChunkIdx}`);

  send({
    type: "status",
    message: alreadyDoneCount > 0
      ? `Resuming — ${pendingBeats.length} motion prompt${pendingBeats.length === 1 ? "" : "s"} left (${alreadyDoneCount} already done)...`
      : `Generating motion prompts for ${pendingBeats.length} beats...`,
  });

  // Seed the progress bar with the chunks already covered (resume).
  if (totalChunksAbsolute > 1) {
    send({ type: "progress", current: startChunkIdx, total: totalChunksAbsolute });
  }

  for (let i = 0; i < chunks.length; i++) {
    await assertPromptsRunActive(projectId, runId);

    // One retry on tool-use miss — KIE occasionally returns text-only
    // even with tool_choice forced. A fresh call usually picks the tool.
    let res!: Anthropic.Messages.Message;
    let tool: Anthropic.Messages.ContentBlock | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await retryClaudeCall(`video batch ${i + 1}/${chunks.length} (try ${attempt + 1})`, () =>
        anthropic.messages.create({
          model: MODEL,
          max_tokens: 8192,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [{ name: "save_video_prompts", description: "Save video prompts for all beats", input_schema: videoPromptsInputSchema }],
          tool_choice: { type: "tool", name: "save_video_prompts" },
          messages: [{ role: "user", content: buildVideoPromptsPrompt(chunks[i], visualProfile) }],
        })
      );
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

    if (!input) throw new Error(`No video prompts for batch ${i + 1} after retry. Try again — any prompts saved so far are preserved.`);
    if (!Array.isArray(input.beats) || input.beats.length === 0) throw new Error(`Empty video prompts for batch ${i + 1}. Try again — any prompts saved so far are preserved.`);

    const parsed = VideoPromptsSchema.safeParse(input);
    if (!parsed.success) {
      const rawBeats = (input.beats as Array<Record<string, unknown>>) ?? [];
      const blank = rawBeats
        .filter((b) => !b.videoPrompt || (typeof b.videoPrompt === "string" && (b.videoPrompt as string).trim() === ""))
        .map((b) => `beat#${b.beatNumber ?? "?"}`);
      console.error(`[video-prompts] batch ${i + 1} schema validation failed`, {
        beatCount: rawBeats.length,
        blankVideoPrompts: blank,
        zodIssues: parsed.error.issues,
      });
      throw new Error(`Batch ${i + 1} returned beats with missing videoPrompt (${blank.slice(0, 3).join(", ") || "schema mismatch"}). Try again — any prompts saved so far are preserved.`);
    }
    const chunkBeats = parsed.data.beats;

    await assertPromptsRunActive(projectId, runId);

    // Persist this chunk's video prompts immediately so a later failure
    // doesn't undo this chunk's work.
    await Promise.all(
      chunkBeats.map((b) =>
        supabase
          .from("project_beats")
          .update({ video_prompt: b.videoPrompt })
          .eq("project_id", projectId)
          .eq("beat_number", b.beatNumber)
      )
    );

    // Emit progress AFTER persistence so the bar tracks completed work.
    if (totalChunksAbsolute > 1) send({ type: "progress", current: startChunkIdx + i + 1, total: totalChunksAbsolute });
  }

  send({ type: "done", beatCount: allBeats.length });
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

  const res = await retryClaudeCall("thumbnail concepts", () =>
    anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [{ name: "save_thumbnails", description: "Save 5 thumbnail concepts", input_schema: thumbnailsInputSchema }],
      tool_choice: { type: "tool", name: "save_thumbnails" },
      messages: [{ role: "user", content: buildThumbnailsPrompt(script, visualProfile, thumbnailAnalysis) }],
    })
  );

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
