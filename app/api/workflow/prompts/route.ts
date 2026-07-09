import { NextResponse } from "next/server";
import { createHash, randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import {
  buildImagePromptsCached,
  buildImagePromptsDynamic,
  buildVideoPromptsCached,
  buildVideoPromptsDynamic,
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
import { getConcurrencyConfig } from "@/lib/concurrency-config";
import { logAnthropicCost } from "@/lib/costs";
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

type PromptsStep = "images" | "videos";

async function claimPromptsRun(projectId: string, userId: string, step: PromptsStep): Promise<string | null> {
  const runId = randomUUID();
  // Write run_id + step + reset stop_requested so the client can tell
  // on refresh which step owns this run AND so a stale "stop requested"
  // flag from a prior aborted-but-not-cleaned-up run doesn't
  // instantly cancel this one. The reset matters because the server
  // now only clears stop_requested in releasePromptsRunIfOwned — and
  // that path no-ops if a newer claim races in before it runs.
  const { error } = await supabase
    .from("projects")
    .update({ prompts_active_run_id: runId, prompts_active_step: step, prompts_stop_requested: false })
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
    .select("prompts_active_run_id, prompts_stop_requested")
    .eq("id", projectId)
    .single();
  if (error) {
    console.warn("[prompts-cancel] could not read run id; skipping check", error);
    return;
  }
  // Two cancel signals now:
  //   • run_id mismatch (or null) — a newer claim raced in, or the
  //     project was wiped — same semantics as before.
  //   • stop_requested === true — the client asked to stop without
  //     touching run_id, so the prompts page can keep showing the
  //     "Generating…" indicator on refresh while the in-flight chunk
  //     wraps up. Cleared by releasePromptsRunIfOwned at the end.
  if (!data || data.prompts_active_run_id !== runId || data.prompts_stop_requested === true) {
    throw new Error(CANCELLED_MSG);
  }
}

// Release the active run id ONLY if it's still ours. The success paths
// null it inline; this is the catch-all for error/throw paths so the
// project doesn't get stuck advertising an in-flight run forever — the
// prompts page derives `imageRemoteRunning` from this column and would
// otherwise show "Resuming…" indefinitely after a server-side failure.
// The ownership check protects against clobbering a newer run that
// raced in after ours errored.
async function releasePromptsRunIfOwned(projectId: string, userId: string, runId: string | null): Promise<void> {
  if (!runId) return;
  try {
    const { data } = await supabase
      .from("projects")
      .select("prompts_active_run_id")
      .eq("id", projectId)
      .single();
    if (data?.prompts_active_run_id !== runId) return;
    // Clear stop_requested too — the user-initiated cancel path sets
    // it without touching run_id, expecting this release to wipe both
    // once the in-flight chunk has actually exited. Without this,
    // the next claim still trips assertPromptsRunActive's
    // stop_requested check (claimPromptsRun's reset is a belt-and-
    // braces complement but shouldn't be the only line of defence).
    await supabase
      .from("projects")
      .update({ prompts_active_run_id: null, prompts_active_step: null, prompts_stop_requested: false })
      .eq("id", projectId)
      .eq("user_id", userId);
  } catch (e) {
    console.warn("[prompts-cancel] failed to release run id; UI may show stale Resuming until next claim", e);
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
// Count complete top-level beat objects inside a partial tool_use JSON
// payload. The shape is `{"beats": [{...}, {...}, ...]}`; we find the
// array's first `[`, walk forward bracket-counting (string-aware), and
// tally every time depth returns to 0 — i.e. a beat object just closed.
// Used during Claude streaming to surface per-beat progress in the UI
// before the chunk's bulk DB insert lands.
function countCompleteBeatsInPartialJson(raw: string): number {
  const arrStart = raw.indexOf("[");
  if (arrStart === -1) return 0;
  let depth = 0;
  let inString = false;
  let escape = false;
  let complete = 0;
  for (let i = arrStart; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) complete++;
    }
  }
  return complete;
}

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
        // Wrap enqueue in try/catch so a client disconnect doesn't
        // unwind the generation. When the browser navigates away the
        // controller goes into errored state and any further enqueue
        // throws — without this guard the exception bubbled out of
        // send() into the worker pool and halted server-side work,
        // defeating the whole point of the per-chunk DB persistence
        // and the prompts_active_run_id resume signal.
        function send(data: object) {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // Client disconnected — silently stop trying to push but
            // let the generation keep running. The DB is the source of
            // truth and per-chunk writes carry the work forward.
            closed = true;
          }
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
          catch { closed = true; }
        }, HEARTBEAT_MS);
        try {
          await handler(send);
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : "Generation failed" });
        } finally {
          closed = true;
          clearInterval(heartbeat);
          try { controller.close(); } catch { /* already torn down */ }
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
// the per-call max_tokens ceiling. The startBeat parameter keeps
// numbering continuous across chunks.
async function generateImages(
  projectId: string,
  userId: string,
  script: string,
  visualProfile: VisualProfileOutput,
  send: (data: object) => void,
  model: string,
  promptStyle: "general" | "cinematic" = "general",
) {
  console.log(`[image-prompts] start project=${projectId} scriptWords=${script.trim().split(/\s+/).filter(Boolean).length}`);
  const runId = await claimPromptsRun(projectId, userId, "images");
  // Walk current_state back to "prompts step in progress" (13) so the
  // client can distinguish a fresh image-regen from a fully completed
  // image step. Without this, after a prior successful run left
  // current_state at 14, the prompts page's imageStepCompleteOnServer
  // check (current_state >= 14 && beats.every has imagePrompt) goes
  // true the instant the first regen chunk lands — flipping the
  // StepCard to "done — N beats ready" while chunks 2..N are still
  // generating. The completion path below restores current_state to
  // 14 after the final chunk persists. Video step doesn't touch
  // current_state, so this only affects image runs.
  await supabase
    .from("projects")
    .update({ current_state: 13 })
    .eq("id", projectId)
    .eq("user_id", userId)
    .gte("current_state", 14);
  try {
  const { client: anthropic, routing, takeLastCreditsConsumed } = await getAnthropicClient(userId, "image_prompts");

  // Hash the current script and compare to the hash that was current when
  // the existing beats were generated. If they differ, the script was
  // edited after the previous run and the resume logic below MUST NOT
  // reuse those beats — their script_segments reference content that may
  // no longer exist. Drop them so the chunk walk starts from scratch.
  const scriptHash = createHash("sha256").update(script).digest("hex");
  const { data: priorHashRow } = await supabase
    .from("projects")
    .select("prompts_script_hash")
    .eq("id", projectId)
    .single();
  const priorHash = (priorHashRow?.prompts_script_hash as string | null) ?? null;
  if (priorHash && priorHash !== scriptHash) {
    console.log(`[image-prompts] script changed since last run — discarding old beats project=${projectId}`);
    await supabase.from("project_beats").delete().eq("project_id", projectId);
  }

  // Smaller chunks = smaller per-call payload = more chances of getting
  // past KIE+Opus's intermittent 500s. ~500 words/chunk produces ~30
  // beats × ~150 tokens ≈ 4500 output tokens, well under the 16384
  // ceiling set on the streaming call below, and each call finishes
  // faster (30-60s typical) reducing the surface area for KIE to drop
  // the connection.
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
  // already covered. We don't try to be exact — script_segments rarely
  // tile a chunk's exact word boundary because Claude trims connector
  // words and merges short clauses. We allow up to a CHUNK_SLACK_WORDS
  // undershoot before counting a chunk as "needs redo". Without this
  // a clean stop at 2/8 lands coveredWords at ~950–1000 (sum of chunk
  // 0+1 beat segments), which is short of chunk 1's 1000-word end —
  // the resume math then re-queued chunk 1, the seeded progress event
  // emitted 0/8 (or 1/8), and the user saw "Generating from scratch"
  // even though most of the work was on disk.
  //
  // Note: this is a heuristic. For projects where coverage falls more
  // than CHUNK_SLACK_WORDS short, a chunk WILL still re-run — and the
  // resulting beat inserts collide on (project_id, beat_number) only
  // if nextBeatNumber math collides, which it shouldn't because we
  // continue from existingBeats.last+1. Duplicates would appear as
  // beats spanning the same script_segment, not row-conflict errors.
  // If duplicates show up in practice, switch to an explicit
  // chunk-completion table instead of this word-count heuristic.
  const CHUNK_SLACK_WORDS = 100;
  const chunksToProcess: { content: string; chunkIndex: number; totalChunks: number }[] = [];
  let walkedWords = 0;
  for (let i = 0; i < allChunks.length; i++) {
    const chunkWords = allChunks[i].split(/\s+/).filter(Boolean).length;
    const chunkEnd = walkedWords + chunkWords;
    // Slack only applies when there IS a covered prefix to undershoot.
    // With zero covered words (fresh run), a script shorter than
    // CHUNK_SLACK_WORDS fit entirely inside the slack window and its
    // only chunk was skipped as "already covered" — the run completed
    // with current_state=14 and zero beats, which the prompts page
    // surfaced as "done but beats missing prompts".
    if (coveredWords > 0 && chunkEnd <= coveredWords + CHUNK_SLACK_WORDS) {
      walkedWords = chunkEnd;
      continue;
    }
    chunksToProcess.push({ content: allChunks[i], chunkIndex: i, totalChunks: allChunks.length });
    walkedWords = chunkEnd;
  }

  if (chunksToProcess.length === 0 && existingBeats && existingBeats.length > 0) {
    // Already fully done — just bump state and report. Also refresh
    // prompts_script_hash so a noop re-run after a script edit doesn't
    // leave the project flagged as stale by the UI, and null out
    // prompts_active_run_id so the client doesn't keep interpreting
    // this finished run as "still in progress" — without that release
    // the video StepCard false-positives into a "Resuming — 0/N" state
    // on next page load and looks like video auto-started.
    const { error: updErr } = await supabase
      .from("projects")
      .update({ current_state: 14, prompts_script_hash: scriptHash, prompts_active_run_id: null, prompts_active_step: null, prompts_stop_requested: false })
      .eq("id", projectId)
      .eq("user_id", userId);
    if (updErr) console.error(`[image-prompts] noop-path hash write failed project=${projectId}:`, updErr);
    else console.log(`[image-prompts] noop-path hash written project=${projectId} hash=${scriptHash.slice(0, 12)}…`);
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

  // Cache the static portion (instructions + visual style + rules)
  // once per run. After the first chunk's call lands, every subsequent
  // chunk hits Anthropic's ephemeral cache for this prefix.
  const cachedUserBlock = buildImagePromptsCached(visualProfile, promptStyle);

  // Per-chunk persist gates: chunk i's persist step waits on chunk
  // i-1's gate so beat_number assignment stays monotonic in script
  // order regardless of which Claude call finishes first.
  const persistGates: Array<{ promise: Promise<void>; resolve: () => void; reject: (e: Error) => void }> = [];
  for (let i = 0; i < chunksToProcess.length; i++) {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    persistGates.push({ promise, resolve, reject });
  }

  // Running counter — only mutated inside the gated persist step.
  let runningBeatNumber = nextBeatNumber;

  async function processChunk(taskIdx: number): Promise<number> {
    const { content, chunkIndex, totalChunks } = chunksToProcess[taskIdx];

    await assertPromptsRunActive(projectId, runId);

    const t0 = Date.now();
    console.log(`[image-prompts] chunk ${chunkIndex + 1}/${totalChunks} start (parallel) words=${content.split(/\s+/).length}`);

    // Streaming + tool_use on Opus. Streaming keeps KIE's connection
    // warm with continuous delta events. The cached prefix block hits
    // Anthropic's ephemeral cache after the first chunk lands.
    const res = await retryClaudeCall(
      `image prompts chunk ${chunkIndex + 1}/${totalChunks}`,
      async () => {
        // 16384 (not 8192) so verbose chunks have headroom to finish.
        // Typical 500-word chunk produces ~30 beats × ~150 tokens ≈
        // 4500 output tokens — well inside this ceiling. The bump exists
        // for the ~5% of chunks where Claude writes 3-4 sentence
        // imagePrompts instead of 1-2, or where the script is dense
        // enough to identify 50+ beats per chunk. Those used to hit the
        // 8192 wall, throw `max_tokens`, and discard everything Claude
        // had already written for the chunk; with the larger ceiling
        // they finish naturally. Cost is only paid on chunks that
        // actually exceed 8192 output — average chunks are unaffected
        // since max_tokens is a ceiling, not a target.
        const stream = anthropic.messages.stream({
          model: model,
          max_tokens: 16384,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [{ name: "save_image_prompts", description: "Save image prompts for every visual beat in the chunk", input_schema: imagePromptsInputSchema }],
          tool_choice: { type: "tool", name: "save_image_prompts" },
          messages: [{
            role: "user",
            content: [
              { type: "text", text: cachedUserBlock, cache_control: { type: "ephemeral" } },
              { type: "text", text: buildImagePromptsDynamic(content) },
            ],
          }],
        });
        // Tally beats as they appear in the tool_use JSON stream so the
        // UI can show "section 2 in progress (15 beats so far)" instead
        // of waiting the full 30-60s for the chunk to land in one shot.
        // Each input_json_delta carries another fragment of the
        // tool_use input JSON; we accumulate then re-count complete
        // beat objects, and only emit when the tally goes up.
        let toolJsonAccum = "";
        let lastReportedBeats = 0;
        for await (const ev of stream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") {
            toolJsonAccum += ev.delta.partial_json;
            const completeBeats = countCompleteBeatsInPartialJson(toolJsonAccum);
            if (completeBeats > lastReportedBeats) {
              lastReportedBeats = completeBeats;
              send({
                type: "chunk_beat_progress",
                chunkIndex,
                beatsInChunk: completeBeats,
              });
            }
          }
        }
        return stream.finalMessage();
      },
      5
    );

    console.log(`[image-prompts] chunk ${chunkIndex + 1}/${totalChunks} claude done in ${Date.now() - t0}ms stop=${res.stop_reason}`);
    void logAnthropicCost({
      projectId,
      userId,
      step: "prompts_image",
      model,
      routing,
      usage: res.usage,
      kieCreditsConsumed: takeLastCreditsConsumed(),
    });
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
    const localBeats = parsed.data.beats;

    // Wait my turn before assigning beat numbers and persisting.
    if (taskIdx > 0) await persistGates[taskIdx - 1].promise;

    try {
      // Intentionally NO assertPromptsRunActive here — once Claude has
      // returned beats, always persist them. A user who clicked Stop
      // mid-Claude-call still gets credit for the work that was
      // already paid for (Anthropic charged us regardless), and the
      // prompts page can flip from "0 generated, first segment still
      // processing" to "N generated, ~M remaining" the moment the
      // in-flight chunk lands. The next-chunk assert at the top of
      // processChunk still prevents follow-on chunks from starting.

      // The model numbered beats 1..k locally; shift them into the
      // global sequence starting at runningBeatNumber.
      const offset = runningBeatNumber - 1;
      const finalBeats = localBeats.map((b) => ({ ...b, beatNumber: b.beatNumber + offset }));

      const { error: insertError } = await supabase.from("project_beats").insert(
        finalBeats.map((b) => ({
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

      runningBeatNumber += finalBeats.length;
      persistGates[taskIdx].resolve();
      return finalBeats.length;
    } catch (e) {
      // Unblock every downstream gate so no other worker deadlocks
      // waiting on us. The error itself surfaces via firstError below.
      const err = e instanceof Error ? e : new Error(String(e));
      for (let j = taskIdx; j < chunksToProcess.length; j++) {
        persistGates[j].reject(err);
      }
      throw err;
    }
  }

  // Strict sequential processing by default — one chunk in flight at a time. The
  // resume/progress UX needs each chunk to fully persist (and the
  // progress event to land) before the next starts so the user sees
  // "1/8 → 2/8 → 3/8" cleanly and a mid-run Stop has a well-defined
  // resume point. The prior parallel pool (5 in flight) overlapped
  // Claude calls cleanly but emitted progress events out of script
  // order and could leave partial-chunk gaps on Stop that the
  // word-count-based resume heuristic couldn't reliably skip.
  // Admin-tunable: product_config.batched_processes.image_prompts_chunks.
  const CONCURRENCY = (await getConcurrencyConfig()).image_prompts_chunks;
  let nextIdx = 0;
  let completed = 0;
  let firstError: Error | null = null;

  async function worker() {
    while (true) {
      if (firstError) return;
      const myIdx = nextIdx++;
      if (myIdx >= chunksToProcess.length) return;
      try {
        const added = await processChunk(myIdx);
        totalBeatCount += added;
        completed++;
        if (allChunks.length > 1) {
          send({ type: "progress", current: alreadyDoneChunks + completed, total: allChunks.length });
        }
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, chunksToProcess.length) }, () => worker())
  );
  if (firstError) throw firstError;

  const { error: finalUpdErr } = await supabase
    .from("projects")
    .update({ current_state: 14, prompts_script_hash: scriptHash, prompts_active_run_id: null, prompts_active_step: null, prompts_stop_requested: false })
    .eq("id", projectId)
    .eq("user_id", userId);
  if (finalUpdErr) console.error(`[image-prompts] full-run hash write failed project=${projectId}:`, finalUpdErr);
  else console.log(`[image-prompts] full-run hash written project=${projectId} hash=${scriptHash.slice(0, 12)}… beats=${totalBeatCount}`);
  send({ type: "done", beatCount: totalBeatCount });
  } finally {
    await releasePromptsRunIfOwned(projectId, userId, runId);
  }
}

// ── Step 2: Video prompts ──────────────────────────────────────────────────
async function generateVideos(projectId: string, userId: string, send: (data: object) => void, model: string) {
  const runId = await claimPromptsRun(projectId, userId, "videos");
  try {
  const { client: anthropic, routing, takeLastCreditsConsumed } = await getAnthropicClient(userId, "video_prompts");
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
    await supabase
      .from("projects")
      .update({ prompts_active_run_id: null, prompts_active_step: null, prompts_stop_requested: false })
      .eq("id", projectId)
      .eq("user_id", userId);
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

  // Cache the static portion (instructions + visual style + rules) once
  // per generation run. Anthropic ephemeral caching hits on the second
  // request and onwards, so under concurrency this kicks in within a
  // second or two of the first chunk landing.
  const cachedUserBlock = buildVideoPromptsCached(visualProfile);

  async function processChunk(i: number): Promise<void> {
    await assertPromptsRunActive(projectId, runId);

    // One retry on tool-use miss — KIE occasionally returns text-only
    // even with tool_choice forced. A fresh call usually picks the tool.
    let res!: Anthropic.Messages.Message;
    let tool: Anthropic.Messages.ContentBlock | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await retryClaudeCall(`video batch ${i + 1}/${chunks.length} (try ${attempt + 1})`, () =>
        anthropic.messages.create({
          model: model,
          max_tokens: 8192,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [{ name: "save_video_prompts", description: "Save video prompts for all beats", input_schema: videoPromptsInputSchema }],
          tool_choice: { type: "tool", name: "save_video_prompts" },
          messages: [{
            role: "user",
            content: [
              { type: "text", text: cachedUserBlock, cache_control: { type: "ephemeral" } },
              { type: "text", text: buildVideoPromptsDynamic(chunks[i]) },
            ],
          }],
        })
      );
      tool = res.content.find((b) => b.type === "tool_use");
      const blockTypes = res.content.map((b) => b.type).join(",");
      console.log(`[video-prompts] batch ${i + 1}/${chunks.length} attempt ${attempt + 1} stop=${res.stop_reason} blocks=${blockTypes} tool_use=${!!tool}`);
      void logAnthropicCost({
        projectId,
        userId,
        step: "prompts_video",
        model,
        routing,
        usage: res.usage,
        kieCreditsConsumed: takeLastCreditsConsumed(),
      });
      if (tool && tool.type === "tool_use") break;
    }

    assertComplete(res.stop_reason, `video batch ${i + 1}/${chunks.length}`);

    let input: Record<string, unknown> | null = null;
    if (tool && tool.type === "tool_use") {
      input = tool.input as Record<string, unknown>;
    } else {
      // Fallback path: KIE+Opus sometimes emits the JSON as text instead
      // of invoking the tool, wrapped in a fake `<tool_calls>` shell.
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

    // Intentionally NO assertPromptsRunActive here — once Claude has
    // returned video prompts, always persist them. A user who clicked
    // Stop mid-Claude-call still gets credit for the work that was
    // already paid for (KIE/Anthropic charged us regardless). The
    // next-chunk assert at the top of processChunk still prevents
    // follow-on chunks from starting, and with CONCURRENCY=5 the
    // worst case is 5 in-flight chunks landing after Stop — far
    // better to save those beats than discard them and force the
    // user to regenerate (and re-pay) on the next run. Mirrors the
    // image step's policy at the persist boundary.
    // Batched UPDATE via RPC — each beat has its own video_prompt so
    // we can't collapse with .in(). The helper runs one
    // UPDATE ... FROM (VALUES ...) statement server-side; migration 082.
    const { error: batchErr } = await supabase.rpc("batch_update_beat_video_prompts", {
      p_project_id: projectId,
      p_updates: chunkBeats.map((b) => ({
        beat_number: b.beatNumber,
        video_prompt: b.videoPrompt,
      })),
    });
    if (batchErr) throw new Error(`Failed to persist video prompts for batch ${i + 1}: ${batchErr.message}`);
  }

  // Strict sequential processing — one chunk in flight at a time.
  // Mirrors the image step's choice (see processChunk above): a user-
  // clicked Stop should have a well-defined "current chunk" to finish
  // and a predictable resume point. With parallel workers, Stop wastes
  // up to CONCURRENCY × CHUNK_SIZE beats of KIE compute that we either
  // discard or commit to without the user's intent. Serial means Stop
  // wastes at most one chunk (≤5 beats). Wall-time cost is real
  // (~3-5 min on a 20-chunk project vs ~60s parallel) but bounded —
  // video chunks emit ~250 output tokens and finish in 8-15s.
  // retryClaudeCall absorbs any 429s.
  // Admin-tunable: product_config.batched_processes.video_prompts_chunks.
  const CONCURRENCY = (await getConcurrencyConfig()).video_prompts_chunks;
  let nextIdx = 0;
  let completed = 0;
  let firstError: Error | null = null;

  async function worker() {
    while (true) {
      if (firstError) return;
      const myIdx = nextIdx++;
      if (myIdx >= chunks.length) return;
      try {
        await processChunk(myIdx);
        completed++;
        // Progress tracks completions, not starts — parallel chunks may
        // finish out of order, but the count is monotone.
        if (totalChunksAbsolute > 1) {
          send({ type: "progress", current: startChunkIdx + completed, total: totalChunksAbsolute });
        }
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker())
  );
  if (firstError) throw firstError;

  await supabase
    .from("projects")
    .update({ prompts_active_run_id: null, prompts_active_step: null, prompts_stop_requested: false })
    .eq("id", projectId)
    .eq("user_id", userId);
  send({ type: "done", beatCount: allBeats.length });
  } finally {
    await releasePromptsRunIfOwned(projectId, userId, runId);
  }
}

// ── Step 3: Thumbnails ─────────────────────────────────────────────────────
async function generateThumbnails(
  projectId: string,
  userId: string,
  script: string,
  visualProfile: VisualProfileOutput,
  thumbnailAnalysis: ThumbnailAnalysisOutput | undefined,
  send: (data: object) => void,
  model: string
) {
  const { client: anthropic, routing, takeLastCreditsConsumed } = await getAnthropicClient(userId, "thumbnails");
  send({ type: "status", message: "Generating 5 thumbnail concepts..." });

  // One retry on tool-use miss — KIE intermittently returns a 200 with
  // a text-only content block even when tool_choice forces save_thumbnails.
  // The same pattern is used by the video-prompts step above (see line ~720).
  // A second fresh call almost always picks the tool, so we don't bubble a
  // user-facing error until both tries fail.
  let res!: Anthropic.Messages.Message;
  let tool: Anthropic.Messages.ContentBlock | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await retryClaudeCall(`thumbnail concepts (try ${attempt + 1})`, () =>
      anthropic.messages.create({
        model: model,
        max_tokens: 8192,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [{ name: "save_thumbnails", description: "Save 5 thumbnail concepts", input_schema: thumbnailsInputSchema }],
        tool_choice: { type: "tool", name: "save_thumbnails" },
        messages: [{ role: "user", content: buildThumbnailsPrompt(script, visualProfile, thumbnailAnalysis) }],
      })
    );
    tool = res.content.find((b) => b.type === "tool_use");
    const blockTypes = res.content.map((b) => b.type).join(",");
    console.log(`[thumbnails] attempt ${attempt + 1} stop=${res.stop_reason} blocks=${blockTypes} tool_use=${!!tool}`);
    void logAnthropicCost({
      projectId,
      userId,
      step: "thumbnail_concept",
      model,
      routing,
      usage: res.usage,
      kieCreditsConsumed: takeLastCreditsConsumed(),
    });
    if (tool && tool.type === "tool_use") break;
  }

  assertComplete(res.stop_reason, "thumbnails");

  if (!tool || tool.type !== "tool_use") throw new Error("No thumbnails returned from Claude after 2 attempts");

  const { thumbnails } = ThumbnailsOutputSchema.parse(tool.input);
  // Defensive double-check on top of the Zod .length(5) and the
  // input_schema's minItems/maxItems — if any of those fail open
  // we still catch it here rather than silently saving a short set.
  if (thumbnails.length !== 5) {
    throw new Error(`Expected exactly 5 thumbnail concepts but got ${thumbnails.length}. Retry — Claude occasionally returns a short list.`);
  }

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
  const model = MODEL;

  if (step === "images") {
    if (!body.script || !body.visualProfile) {
      return NextResponse.json({ error: "script and visualProfile are required" }, { status: 400 });
    }
    // Prefer the request body — the client sends the currently-active
    // tab so an in-session switch is honoured even before the PATCH
    // that persists it settles. Fall back to the project row so a
    // reload before generation still uses the persisted style.
    const bodyStyle = (body as { promptStyle?: unknown }).promptStyle;
    let promptStyle: "general" | "cinematic" =
      bodyStyle === "cinematic" ? "cinematic" : bodyStyle === "general" ? "general" : "general";
    if (bodyStyle === undefined) {
      const { data: proj } = await supabase
        .from("projects")
        .select("prompt_style")
        .eq("id", projectId)
        .eq("user_id", user.id)
        .single();
      if ((proj?.prompt_style as string | null) === "cinematic") promptStyle = "cinematic";
    }
    return sseStream((send) =>
      generateImages(projectId, user.id, body.script!, body.visualProfile!, send, model, promptStyle)
    );
  }

  if (step === "videos") {
    return sseStream((send) => generateVideos(projectId, user.id, send, model));
  }

  if (step === "thumbnails") {
    if (!body.script || !body.visualProfile) {
      return NextResponse.json({ error: "script and visualProfile are required" }, { status: 400 });
    }
    return sseStream((send) =>
      generateThumbnails(projectId, user.id, body.script!, body.visualProfile!, body.thumbnailAnalysis, send, model)
    );
  }

  return NextResponse.json({ error: `Unknown step: ${step}` }, { status: 400 });
}
