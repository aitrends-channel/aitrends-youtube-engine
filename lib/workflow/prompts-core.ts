// Core prompt-generation logic shared by the prompts route and the
// 1Click orchestrator. Extracted from the route so it can be called
// server-side (route files may only export request handlers).

import { createHash, randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, SYSTEM_PROMPT } from "@/lib/claude/client";
import { modelParamsFor } from "@/lib/claude/models";
import {
  buildBeatsCached,
  buildBeatsDynamic,
  buildFillPromptsCached,
  buildFillPromptsDynamic,
  buildImagePromptsCached,
  buildImagePromptsDynamic,
  buildConsistencySheetPrompt,
  buildVideoPromptsCached,
  buildVideoPromptsDynamic,
  buildThumbnailsPrompt,
} from "@/lib/claude/prompts";
import {
  BeatsSchema,
  FillPromptsSchema,
  ImagePromptsSchema,
  VideoPromptsSchema,
  ThumbnailsOutputSchema,
} from "@/lib/claude/schemas";
import {
  beatsInputSchema,
  fillPromptsInputSchema,
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
import { friendlyError } from "@/lib/errors/friendly";

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

// How often a live stream re-checks whether the run has been cancelled.
const CANCEL_POLL_MS = 5_000;

// A cancellation carries status 499 (client closed request) so retryClaudeCall
// sees a non-5xx and fails fast. Without it the throw looks like a network
// error and the call the user just cancelled gets re-issued twice.
function cancelledError(): Error {
  const e = new Error(CANCELLED_MSG) as Error & { status: number };
  e.status = 499;
  return e;
}

type PromptsStep = "beats" | "fill" | "images" | "videos";

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
  // Wipe the previous failure so the card stops explaining an attempt the
  // user has just superseded. Deliberately a SEPARATE write from the claim
  // above: if migration 114 hasn't been applied, an unknown column here must
  // not fail the claim and silently disable cancellation for the whole run.
  const { error: clearErr } = await supabase
    .from("projects")
    .update({ prompts_last_error: null, prompts_last_error_step: null, prompts_last_error_at: null })
    .eq("id", projectId)
    .eq("user_id", userId);
  if (clearErr) console.warn("[prompts] could not clear last error (migration 114 applied?)", clearErr.message);
  return runId;
}

// Persist a failure so the prompts page can still explain it after a reload.
// Stores the friendly sentence, not the raw payload, because the page renders
// this verbatim. A user-initiated cancel is not a failure and is skipped.
async function recordPromptsFailure(
  projectId: string,
  userId: string,
  step: PromptsStep,
  err: unknown,
): Promise<void> {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw === CANCELLED_MSG) return;
  const { error } = await supabase
    .from("projects")
    .update({
      prompts_last_error: friendlyError(raw),
      prompts_last_error_step: step,
      prompts_last_error_at: new Date().toISOString(),
    })
    .eq("id", projectId)
    .eq("user_id", userId);
  if (error) console.warn("[prompts] could not persist failure (migration 114 applied?)", error.message);
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

// Non-throwing form of assertPromptsRunActive, for polling from inside a live
// Claude stream. assertPromptsRunActive is only reached BETWEEN chunks, so a
// Stop clicked while a chunk is in flight waits out the whole chunk — and with
// a failing provider that chunk is three attempts each able to sit at the 300s
// idle-abort, i.e. ~15 minutes of "Finishing the current section…". Polling
// this every few seconds lets the abort land in seconds instead.
//
// Fails safe: a DB error returns false (keep working) rather than killing a
// healthy run over a blip.
async function isRunCancelled(projectId: string, runId: string | null): Promise<boolean> {
  if (!runId) return false;
  try {
    const { data, error } = await supabase
      .from("projects")
      .select("prompts_active_run_id, prompts_stop_requested")
      .eq("id", projectId)
      .single();
    if (error || !data) return false;
    return data.prompts_active_run_id !== runId || data.prompts_stop_requested === true;
  } catch {
    return false;
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

export function sseStream(handler: (send: (data: object) => void) => Promise<void>): Response {
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
export async function generateImages(
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

  // ~200 words/chunk. Beat density runs high (~1 beat per 8 words → a
  // 300-word chunk produced 38+ beats and, in Opus's verbose <tool_calls>
  // text fallback, overran 12288 tokens → stop=max_tokens truncation).
  // 200 words caps a chunk at ~25 beats, whose verbose fallback stays
  // comfortably under 12288 even for dense content. The ceiling can't just
  // be raised — 16384 triggers the ~129s first-token latency cliff — so
  // the chunk size is the lever. Smaller chunks = more chunks, but
  // concurrency (3) and per-chunk persistence + resume absorb that.
  const SCRIPT_CHUNK_WORDS = 200;
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

  // Whole-script consistency sheet — one call up front (full script +
  // visual style) so every chunk reuses IDENTICAL character/location/
  // style wording. Without this, each ~500-word chunk builds its own
  // sheet and a recurring character drifts between chunks. Best-effort:
  // on failure we fall back to per-chunk sheets (the builder handles an
  // empty string). Only runs when there are chunks to process (the noop
  // resume path already returned above).
  let consistencySheet = "";
  try {
    send({ type: "status", message: "Building character & style consistency sheet…" });
    const sheetMsg = await retryClaudeCall("consistency sheet", () =>
      anthropic.messages.create({
        model,
        max_tokens: 2000,
        system: [{ type: "text", text: SYSTEM_PROMPT }],
        messages: [{ role: "user", content: buildConsistencySheetPrompt(script, visualProfile) }],
      }),
    );
    consistencySheet = sheetMsg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    console.log(`[image-prompts] consistency sheet built (${consistencySheet.length} chars)`);
  } catch (err) {
    console.warn("[image-prompts] consistency sheet failed — falling back to per-chunk:", err instanceof Error ? err.message : err);
  }

  // Cache the static portion (instructions + consistency sheet + visual
  // style + rules) once per run. After the first chunk's call lands,
  // every subsequent chunk hits Anthropic's ephemeral cache for this
  // prefix — and every chunk sees the same locked descriptions.
  const cachedUserBlock = buildImagePromptsCached(visualProfile, promptStyle, consistencySheet);

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

  // Generate + validate beats for one span of script text. On a
  // max_tokens truncation the span is split in half and each half is
  // regenerated recursively — a beat-dense span (e.g. a 200-word chunk
  // that expands to 40+ beats and, in Opus's verbose <tool_calls> text
  // fallback, overruns the 12288 ceiling) would otherwise truncate
  // DETERMINISTICALLY: assertComplete threw, the run failed, and the
  // resume path re-queued the exact same span → the retry re-truncated
  // → the user was stuck ("Response was cut off during chunk 6/8. Please
  // try again." on every attempt). Splitting shrinks each Claude call's
  // output until it fits, so a dense span self-heals instead of trapping
  // the run. Returns beats with the model's LOCAL 1..k numbering; the
  // caller reassigns global beat numbers by array index, so duplicate
  // local numbers across split halves don't matter.
  async function genBeatsForText(
    text: string,
    chunkIndex: number,
    totalChunks: number,
    depth: number,
  ): Promise<ReturnType<typeof ImagePromptsSchema.parse>["beats"]> {
    // Depth 4 halves a 200-word chunk down to ~12-word pieces
    // (200→100→50→25→12); a piece that small overrunning 12288 tokens
    // means the model is looping, so we stop splitting and surface the
    // truncation rather than fan out indefinitely. MIN_SPLIT_WORDS keeps
    // us from splitting a span so short the halves can't form coherent
    // beats.
    const MAX_SPLIT_DEPTH = 4;
    const MIN_SPLIT_WORDS = 24;
    const label = `image prompts chunk ${chunkIndex + 1}/${totalChunks}${depth > 0 ? ` (split d${depth})` : ""}`;

    const t0 = Date.now();
    console.log(`[image-prompts] ${label} start words=${text.split(/\s+/).filter(Boolean).length}`);

    // Streaming + tool_use on Opus. Streaming keeps KIE's connection
    // warm with continuous delta events. The cached prefix block hits
    // Anthropic's ephemeral cache after the first chunk lands.
    // Extraction lives INSIDE the retry closure so a KIE stream that
    // completes "successfully" but empty (no tool_use, no recoverable
    // text — a known intermittent KIE gateway quirk) is thrown here and
    // retried, instead of escaping the retry wrapper and hard-failing
    // the whole run. retryClaudeCall treats a status-less throw as
    // transient, so these empty responses get retried. Capped at 3 (not
    // more): each empty is a full ~30-60s stream, and this closure's
    // attempts share the budget with the whole chunk — 5+ slow empties
    // across several chunks can push a multi-chunk run past the 800s
    // function ceiling, time out mid-run, and strand prompts_active_run_id
    // set (the client then polls forever, pinned at ~95%). 3 bounds a
    // chunk's worst case to ~3 min, under the poll-loop stall watchdog.
    // Truncation (max_tokens) is deliberately NOT thrown here — a
    // truncated response still carries partial content and is handled by
    // the split path below rather than burning identical retries.
    const { res, input } = await retryClaudeCall(
      label,
      async (): Promise<{ res: Anthropic.Messages.Message; input: Record<string, unknown> | null }> => {
        // 12288. Two competing constraints, measured directly against KIE:
        //   • first-token latency is fast for every ceiling BELOW 16384
        //     (~16-25s) but jumps to ~129s at exactly 16384 — a sharp
        //     cliff. That 2-min silent gap was what tripped the idle-abort
        //     / stall watchdog, so we must stay under 16384.
        //   • Opus intermittently ignores tool_choice and emits a VERBOSE
        //     `<tool_calls>` *text* block instead of a compact tool_use;
        //     8192 truncated that fallback mid-beats (stop=max_tokens).
        // 12288 threads both: fast first token AND enough headroom for the
        // verbose fallback of a ~300-word (~17-beat) chunk. Do NOT set 16384
        // (first-token cliff) and do NOT drop back to 8192 (truncates the
        // fallback). Re-measure both if you change either number.
        // Server-side idle-abort. KIE intermittently accepts a request
        // (its dashboard shows "running", duration 0, 0 credits) but then
        // forwards ZERO bytes — the stream sits open indefinitely. Without
        // this guard the for-await below blocks until the 800s function
        // ceiling, which strands prompts_active_run_id and pins the UI at
        // ~95% (or freezes mid-run, e.g. "section 4/5"). We arm a timer
        // that aborts the stream if no event arrives for STREAM_IDLE_MS,
        // then let retryClaudeCall reissue a FRESH request (a brand-new
        // request is rarely stuck the same way). The timer resets on every
        // event, so a slow-but-live stream — these dense chunks legitimately
        // take 4-5 min of continuous deltas — is never aborted; only a
        // genuinely silent connection trips it.
        const ac = new AbortController();
        // 300s, not 120s: KIE's measured time-to-first-token on big Opus
        // tool_use calls is ~130s (only `ping`s stream in that window), so
        // 120s aborted valid requests ~1s before content arrived. 300s
        // clears that with margin while still catching a genuinely dead
        // connection. The timer resets on EVERY event — including the pings
        // (now forwarded to the client as keepalives) — so a live-but-slow
        // stream is never aborted; only true silence trips it.
        const STREAM_IDLE_MS = 300_000;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(
            () => ac.abort(new Error(`KIE stream idle >${STREAM_IDLE_MS}ms — aborting to retry with a fresh request`)),
            STREAM_IDLE_MS,
          );
        };
        const stream = anthropic.messages.stream({
          ...modelParamsFor(model),
          max_tokens: 12288,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [{ name: "save_image_prompts", description: "Save image prompts for every visual beat in the chunk", input_schema: imagePromptsInputSchema }],
          tool_choice: { type: "tool", name: "save_image_prompts" },
          messages: [{
            role: "user",
            content: [
              { type: "text", text: cachedUserBlock, cache_control: { type: "ephemeral" } },
              { type: "text", text: buildImagePromptsDynamic(text) },
            ],
          }],
        }, { signal: ac.signal });
        try {
          // Tally beats as they appear in the tool_use JSON stream so the
          // UI can show "section 2 in progress (15 beats so far)" instead
          // of waiting the full 30-60s for the chunk to land in one shot.
          // Each input_json_delta carries another fragment of the
          // tool_use input JSON; we accumulate then re-count complete
          // beat objects, and only emit when the tally goes up.
          armIdle();
          let toolJsonAccum = "";
          let lastReportedBeats = 0;
          // Throttle for keepalives on non-beat activity. Date.now() is
          // fine here (normal route, not a workflow sandbox).
          let lastKeepalive = Date.now();
          for await (const ev of stream) {
            armIdle();
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
                lastKeepalive = Date.now();
              }
            } else if (Date.now() - lastKeepalive > 10_000) {
              // Keepalive on ANY other stream activity — throttled to ~10s.
              // This is essential for the case where Opus ignores tool_choice
              // and returns the verbose <tool_calls> TEXT fallback: its
              // deltas are `text_delta`, so the input_json_delta branch above
              // never fires, NO beat progress is produced, and KIE sends no
              // pings during active text streaming — the client would sit
              // silent for the whole (multi-minute) chunk and trip its
              // progress watchdog even though the server is streaming fine.
              // Also covers the ping/message_start first-token gap.
              send({
                type: "chunk_beat_progress",
                chunkIndex,
                beatsInChunk: lastReportedBeats,
              });
              lastKeepalive = Date.now();
            }
          }
          const message = await stream.finalMessage();

          // Pull the beats out of the tool_use block, falling back to the
          // text-mode parser for the case where Opus emits a fake
          // <tool_calls> text block instead of invoking the tool.
          let extracted: Record<string, unknown> | null = null;
          const toolBlock = message.content.find((b) => b.type === "tool_use");
          if (toolBlock && toolBlock.type === "tool_use") {
            extracted = toolBlock.input as Record<string, unknown>;
          } else {
            const textBlock = message.content.find((b) => b.type === "text");
            const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
            console.log(`[image-prompts] chunk ${chunkIndex + 1} fallback parsing text len=${raw.length} head=${raw.slice(0, 200)}`);
            extracted = extractToolInputFromText(raw);
            if (extracted) console.log(`[image-prompts] chunk ${chunkIndex + 1} fallback recovered ${(extracted.beats as unknown[])?.length ?? 0} beats`);
          }

          // Only retry genuinely EMPTY responses. A truncated (max_tokens)
          // response has content and is handled by assertComplete outside.
          if (message.stop_reason !== "max_tokens") {
            if (!extracted) {
              throw new Error(`No image prompts returned for chunk ${chunkIndex + 1} — KIE returned an empty response; retrying.`);
            }
            if (!Array.isArray(extracted.beats) || extracted.beats.length === 0) {
              throw new Error(`Chunk ${chunkIndex + 1} returned no beats — empty response; retrying.`);
            }
          }
          return { res: message, input: extracted };
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
      },
      3
    );

    console.log(`[image-prompts] ${label} claude done in ${Date.now() - t0}ms stop=${res.stop_reason}`);
    void logAnthropicCost({
      projectId,
      userId,
      step: "prompts_image",
      model,
      routing,
      usage: res.usage,
      kieCreditsConsumed: takeLastCreditsConsumed(),
    });

    // Truncated: split the span and regenerate each half so the dense
    // section self-heals instead of hard-failing the run (see the
    // header comment). Only give up — surfacing the cut-off error via
    // assertComplete — once the span is too small to split further,
    // which for a legitimately-sized script effectively never happens.
    if (res.stop_reason === "max_tokens") {
      const words = text.trim().split(/\s+/).filter(Boolean);
      if (depth < MAX_SPLIT_DEPTH && words.length > MIN_SPLIT_WORDS) {
        const mid = Math.ceil(words.length / 2);
        console.warn(`[image-prompts] ${label} truncated (${words.length} words) — splitting into ${mid} + ${words.length - mid} and regenerating`);
        send({ type: "status", message: "A dense section exceeded the limit — splitting it into smaller pieces…" });
        const left = await genBeatsForText(words.slice(0, mid).join(" "), chunkIndex, totalChunks, depth + 1);
        const right = await genBeatsForText(words.slice(mid).join(" "), chunkIndex, totalChunks, depth + 1);
        return [...left, ...right];
      }
      // Span already minimal — this is a real, unrecoverable truncation.
      assertComplete(res.stop_reason, label);
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
      console.error(`[image-prompts] ${label} schema validation failed`, {
        beatCount: rawBeats.length,
        blankFields,
        zodIssues: parsed.error.issues,
      });
      throw new Error(`Chunk ${chunkIndex + 1} returned beats with missing fields (${blankFields.slice(0, 3).join("; ") || "schema mismatch"}). Try again — any beats saved so far are preserved.`);
    }
    return parsed.data.beats;
  }

  async function processChunk(taskIdx: number): Promise<number> {
    const { content, chunkIndex, totalChunks } = chunksToProcess[taskIdx];

    await assertPromptsRunActive(projectId, runId);

    const localBeats = await genBeatsForText(content, chunkIndex, totalChunks, 0);

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

      // Assign global beat numbers by array position rather than trusting
      // the model's local numbering. localBeats is already in script order
      // (a single call's 1..k, or the concatenation of split halves each
      // restarting at 1 — which would collide if we added an offset to the
      // model's number). Index-based numbering keeps the global sequence
      // gapless and monotonic regardless of how many splits produced it.
      const finalBeats = localBeats.map((b, i) => ({ ...b, beatNumber: runningBeatNumber + i }));

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
  } catch (err) {
    await recordPromptsFailure(projectId, userId, "images", err);
    throw err;
  } finally {
    await releasePromptsRunIfOwned(projectId, userId, runId);
  }
}


// ── Step 1: Beats (segmentation only) ──────────────────────────────────────
//
// Splits the script into beats and writes script_segment ONLY, leaving every
// prompt field null. That gap is the whole point: the user can merge stub
// beats here for free, because nothing derived from the segment exists yet.
//
// Structurally a trimmed generateImages: same chunk walk, same word-coverage
// resume, same persist gates for monotonic beat numbers, same recursive split
// when a dense chunk truncates. What it drops is the consistency sheet and
// the visual profile — neither affects where a beat starts and ends.
export async function generateBeats(
  projectId: string,
  userId: string,
  script: string,
  send: (data: object) => void,
  model: string,
  promptStyle: "general" | "cinematic" = "general",
) {
  console.log(`[beats] start project=${projectId} scriptWords=${script.trim().split(/\s+/).filter(Boolean).length}`);
  const runId = await claimPromptsRun(projectId, userId, "beats");
  // Same walk-back as the image step: beats existing without prompts is
  // "prompts in progress", not done.
  await supabase
    .from("projects")
    .update({ current_state: 13 })
    .eq("id", projectId)
    .eq("user_id", userId)
    .gte("current_state", 14);
  try {
    // Segmentation has its own routing/provider slug (the admin's Prompts card
    // sets it alongside image_prompts and video_prompts). Prompt-writing passes
    // below still use image_prompts.
    const { client: anthropic, routing, takeLastCreditsConsumed } = await getAnthropicClient(userId, "beats");

    const scriptHash = createHash("sha256").update(script).digest("hex");
    const { data: priorHashRow } = await supabase
      .from("projects")
      .select("prompts_script_hash")
      .eq("id", projectId)
      .single();
    const priorHash = (priorHashRow?.prompts_script_hash as string | null) ?? null;
    if (priorHash && priorHash !== scriptHash) {
      console.log(`[beats] script changed since last run — discarding old beats project=${projectId}`);
      await supabase.from("project_beats").delete().eq("project_id", projectId);
    }

    const SCRIPT_CHUNK_WORDS = 200;
    const words = script.trim().split(/\s+/).filter(Boolean);
    const allChunks: string[] = [];
    for (let i = 0; i < words.length; i += SCRIPT_CHUNK_WORDS) {
      allChunks.push(words.slice(i, i + SCRIPT_CHUNK_WORDS).join(" "));
    }
    if (allChunks.length === 0) allChunks.push(script);

    // Sweep debris from a prior failed run. NOTE the difference from
    // generateImages, which deletes beats with a null image_prompt: here a
    // null image_prompt is the expected, correct state, so the only thing
    // that counts as debris is a beat with no segment at all.
    await supabase.from("project_beats").delete().eq("project_id", projectId).is("script_segment", null);
    await supabase.from("project_beats").delete().eq("project_id", projectId).eq("script_segment", "");

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

    const CHUNK_SLACK_WORDS = 100;
    const chunksToProcess: { content: string; chunkIndex: number; totalChunks: number }[] = [];
    let walkedWords = 0;
    for (let i = 0; i < allChunks.length; i++) {
      const chunkWords = allChunks[i].split(/\s+/).filter(Boolean).length;
      const chunkEnd = walkedWords + chunkWords;
      if (coveredWords > 0 && chunkEnd <= coveredWords + CHUNK_SLACK_WORDS) {
        walkedWords = chunkEnd;
        continue;
      }
      chunksToProcess.push({ content: allChunks[i], chunkIndex: i, totalChunks: allChunks.length });
      walkedWords = chunkEnd;
    }

    if (chunksToProcess.length === 0 && existingBeats && existingBeats.length > 0) {
      // Already segmented. Unlike the image step this does NOT advance
      // current_state to 14 — prompts still have to be written.
      await supabase
        .from("projects")
        .update({ prompts_script_hash: scriptHash, prompts_active_run_id: null, prompts_active_step: null, prompts_stop_requested: false })
        .eq("id", projectId)
        .eq("user_id", userId);
      send({ type: "done", beatCount: existingBeats.length });
      return;
    }

    const isResume = existingBeats && existingBeats.length > 0 && chunksToProcess.length < allChunks.length;
    send({
      type: "status",
      message: isResume
        ? `Resuming — ${chunksToProcess.length} script segment${chunksToProcess.length === 1 ? "" : "s"} left to split...`
        : `Splitting the script across ${chunksToProcess.length} segment${chunksToProcess.length === 1 ? "" : "s"}...`,
    });

    const alreadyDoneChunks = allChunks.length - chunksToProcess.length;
    if (allChunks.length > 1) send({ type: "progress", current: alreadyDoneChunks, total: allChunks.length });

    const cachedUserBlock = buildBeatsCached(promptStyle);

    const persistGates: Array<{ promise: Promise<void>; resolve: () => void; reject: (e: Error) => void }> = [];
    for (let i = 0; i < chunksToProcess.length; i++) {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      persistGates.push({ promise, resolve, reject });
    }
    let runningBeatNumber = nextBeatNumber;

    async function genSegmentsForText(
      text: string,
      chunkIndex: number,
      totalChunks: number,
      depth: number,
    ): Promise<ReturnType<typeof BeatsSchema.parse>["beats"]> {
      const MAX_SPLIT_DEPTH = 4;
      const MIN_SPLIT_WORDS = 24;
      const label = `beats chunk ${chunkIndex + 1}/${totalChunks}${depth > 0 ? ` (split d${depth})` : ""}`;

      const { res, input } = await retryClaudeCall(
        label,
        async (): Promise<{ res: Anthropic.Messages.Message; input: Record<string, unknown> | null }> => {
          const ac = new AbortController();
          const STREAM_IDLE_MS = 300_000;
          let idleTimer: ReturnType<typeof setTimeout> | null = null;
          const armIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(
              () => ac.abort(new Error(`KIE stream idle >${STREAM_IDLE_MS}ms — aborting to retry with a fresh request`)),
              STREAM_IDLE_MS,
            );
          };
          // 8192, not the image step's 12288: this pass emits only
          // beatNumber + scriptSegment, roughly a fifth of the tokens, so
          // 8192 clears even the verbose <tool_calls> text fallback while
          // staying well under the 16384 first-token latency cliff.
          const stream = anthropic.messages.stream({
            ...modelParamsFor(model),
            max_tokens: 8192,
            system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            tools: [{ name: "save_beats", description: "Save the script split into visual beats", input_schema: beatsInputSchema }],
            tool_choice: { type: "tool", name: "save_beats" },
            messages: [{
              role: "user",
              content: [
                { type: "text", text: cachedUserBlock, cache_control: { type: "ephemeral" } },
                { type: "text", text: buildBeatsDynamic(text) },
              ],
            }],
          }, { signal: ac.signal });
          let cancelled = false;
          try {
            armIdle();
            let toolJsonAccum = "";
            let lastReportedBeats = 0;
            let lastCancelCheck = Date.now();
            for await (const ev of stream) {
              armIdle();
              // Honour a Stop mid-stream instead of at the next chunk boundary.
              if (Date.now() - lastCancelCheck > CANCEL_POLL_MS) {
                lastCancelCheck = Date.now();
                if (await isRunCancelled(projectId, runId)) {
                  cancelled = true;
                  ac.abort(cancelledError());
                  break;
                }
              }
              if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") {
                toolJsonAccum += ev.delta.partial_json;
                const complete = countCompleteBeatsInPartialJson(toolJsonAccum);
                if (complete > lastReportedBeats) {
                  lastReportedBeats = complete;
                  send({ type: "chunk_beat_progress", chunkIndex, beatsInChunk: complete });
                }
              }
            }
          } finally {
            if (idleTimer) clearTimeout(idleTimer);
          }
          if (cancelled) throw cancelledError();
          const message = await stream.finalMessage();
          const toolBlock = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          let extracted = (toolBlock?.input as Record<string, unknown> | undefined) ?? null;
          if (!extracted) {
            // Same fallback as the image step: Opus intermittently ignores
            // tool_choice and emits the tool call as text.
            const text = message.content
              .filter((b): b is Anthropic.TextBlock => b.type === "text")
              .map((b) => b.text).join("\n");
            extracted = extractToolInputFromText(text) as Record<string, unknown> | null;
          }
          if (!extracted && message.stop_reason !== "max_tokens") {
            throw new Error(`${label}: provider returned no beats`);
          }
          return { res: message, input: extracted };
        },
      );

      // Segmentation is cheap but not free, and it lands under the same
      // "Prompts" column as the pass that used to do both jobs — so a
      // three-step project's cost has to add up to the same place.
      void logAnthropicCost({
        projectId,
        userId,
        step: "prompts_image",
        model,
        routing,
        usage: res.usage,
        kieCreditsConsumed: takeLastCreditsConsumed(),
      });

      if (res.stop_reason === "max_tokens") {
        const spanWords = text.split(/\s+/).filter(Boolean).length;
        if (depth < MAX_SPLIT_DEPTH && spanWords >= MIN_SPLIT_WORDS * 2) {
          const w = text.split(/\s+/).filter(Boolean);
          const mid = Math.floor(w.length / 2);
          const left = await genSegmentsForText(w.slice(0, mid).join(" "), chunkIndex, totalChunks, depth + 1);
          const right = await genSegmentsForText(w.slice(mid).join(" "), chunkIndex, totalChunks, depth + 1);
          return [...left, ...right];
        }
        assertComplete(res.stop_reason, label);
      }

      const parsed = BeatsSchema.safeParse(input);
      if (!parsed.success) {
        console.error(`[beats] ${label} schema validation failed`, { zodIssues: parsed.error.issues });
        throw new Error(`Chunk ${chunkIndex + 1} returned unusable beats. Try again — any beats saved so far are preserved.`);
      }
      return parsed.data.beats;
    }

    async function processChunk(taskIdx: number): Promise<number> {
      const { content, chunkIndex, totalChunks } = chunksToProcess[taskIdx];
      await assertPromptsRunActive(projectId, runId);
      const localBeats = await genSegmentsForText(content, chunkIndex, totalChunks, 0);
      if (taskIdx > 0) await persistGates[taskIdx - 1].promise;
      try {
        const finalBeats = localBeats.map((b, i) => ({ ...b, beatNumber: runningBeatNumber + i }));
        const { error: insertError } = await supabase.from("project_beats").insert(
          finalBeats.map((b) => ({
            project_id: projectId,
            beat_number: b.beatNumber,
            script_segment: b.scriptSegment,
          })),
        );
        if (insertError) throw new Error(`Failed to save beats for chunk ${chunkIndex + 1}: ${insertError.message}`);
        runningBeatNumber += finalBeats.length;
        persistGates[taskIdx].resolve();
        return finalBeats.length;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        for (let j = taskIdx; j < chunksToProcess.length; j++) persistGates[j].reject(err);
        throw err;
      }
    }

    const CONCURRENCY = (await getConcurrencyConfig()).image_prompts_chunks;
    let nextIdx = 0;
    let completed = 0;
    let totalBeatCount = existingBeats?.length ?? 0;
    let firstError: Error | null = null;

    async function worker() {
      while (true) {
        if (firstError) return;
        const myIdx = nextIdx++;
        if (myIdx >= chunksToProcess.length) return;
        try {
          totalBeatCount += await processChunk(myIdx);
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
      Array.from({ length: Math.min(CONCURRENCY, chunksToProcess.length) }, () => worker()),
    );
    if (firstError) throw firstError;

    // Deliberately does NOT set current_state = 14: the prompts step is not
    // complete until image prompts exist. Only the hash is recorded, so a
    // later script edit still invalidates these beats.
    const { error: finalUpdErr } = await supabase
      .from("projects")
      .update({ prompts_script_hash: scriptHash, prompts_active_run_id: null, prompts_active_step: null, prompts_stop_requested: false })
      .eq("id", projectId)
      .eq("user_id", userId);
    if (finalUpdErr) console.error(`[beats] hash write failed project=${projectId}:`, finalUpdErr);
    console.log(`[beats] done project=${projectId} beats=${totalBeatCount}`);
    send({ type: "done", beatCount: totalBeatCount });
  } catch (err) {
    await recordPromptsFailure(projectId, userId, "beats", err);
    throw err;
  } finally {
    await releasePromptsRunIfOwned(projectId, userId, runId);
  }
}

// ── Step 2: Fill prompts onto existing beats ───────────────────────────────
//
// The half of the old combined pass that generateBeats deliberately leaves
// undone: write image_prompt/camera/lighting/mood/action onto beats that
// already have a segment. The segmentation is an INPUT here — the user may
// have merged beats in the gap between the two passes, and preserving that
// decision is the entire reason the step was split.
//
// Structurally this is generateVideos, not generateImages: it batches BEATS
// rather than walking script chunks, and it UPDATEs rows rather than inserting
// them, so no path through here can delete a beat. It does borrow
// generateImages' streaming machinery (idle-abort, per-beat progress ticks,
// verbose-text fallback) because its output is the same size per beat and hits
// the same KIE quirks.
//
// This is also where a merge lands: migration 115 nulls the survivor's stale
// prompt, so the merged beat shows up as pending and gets rewritten against
// its new, longer text — which is why that migration can only be applied once
// this function is live.
export async function fillPrompts(
  projectId: string,
  userId: string,
  visualProfile: VisualProfileOutput,
  send: (data: object) => void,
  model: string,
  promptStyle: "general" | "cinematic" = "general",
) {
  const runId = await claimPromptsRun(projectId, userId, "fill");
  // A re-fill after a merge starts from a project that already reads as
  // complete (current_state 14). Walk it back, or the client calls the step
  // done while a beat is still missing its prompt.
  await supabase
    .from("projects")
    .update({ current_state: 13 })
    .eq("id", projectId)
    .eq("user_id", userId)
    .gte("current_state", 14);
  try {
    const { client: anthropic, routing, takeLastCreditsConsumed } = await getAnthropicClient(userId, "image_prompts");
    send({ type: "status", message: "Loading beats..." });

    // Same debris sweep as generateBeats: a beat with no segment has no
    // narration to illustrate, so it can never be filled and would fail every
    // batch it landed in. Deleting leaves a beat_number gap, which generateBeats
    // already tolerates.
    await supabase.from("project_beats").delete().eq("project_id", projectId).is("script_segment", null);
    await supabase.from("project_beats").delete().eq("project_id", projectId).eq("script_segment", "");

    const { data: beatRows, error: beatsErr } = await supabase
      .from("project_beats")
      .select("beat_number, script_segment, image_prompt")
      .eq("project_id", projectId)
      .order("beat_number", { ascending: true });
    if (beatsErr) throw new Error(`Could not load beats: ${beatsErr.message}`);
    if (!beatRows?.length) throw new Error("No beats found. Run the Beats step first — it splits your script into the beats these prompts are written for.");

    const allBeats = beatRows.map((b) => ({
      beatNumber: b.beat_number as number,
      scriptSegment: b.script_segment as string,
      hasPrompt: !!(b.image_prompt as string | null)?.trim(),
    }));
    const pending = allBeats
      .filter((b) => !b.hasPrompt)
      .map((b) => ({ beatNumber: b.beatNumber, scriptSegment: b.scriptSegment }));
    const alreadyDoneCount = allBeats.length - pending.length;

    if (pending.length === 0) {
      // Every beat already carries a prompt — mark the step complete rather
      // than no-oping, because the caller may be resuming a run that died
      // between its last batch and this write.
      send({ type: "status", message: "All image prompts already written." });
      await supabase
        .from("projects")
        .update({ current_state: 14, prompts_active_run_id: null, prompts_active_step: null, prompts_stop_requested: false })
        .eq("id", projectId)
        .eq("user_id", userId);
      send({ type: "done", beatCount: allBeats.length });
      return;
    }

    console.log(`[fill-prompts] start project=${projectId} beats=${allBeats.length} pending=${pending.length} style=${promptStyle}`);

    // 8 beats per batch against max_tokens 8192. A filled beat runs ~250
    // output tokens (a self-contained image prompt repeats every locked
    // character description verbatim, plus four short phrases), so a batch
    // lands near 2000 — with room for Opus's verbose <tool_calls> text
    // fallback, which roughly doubles it. Same ceiling reasoning as the other
    // passes: staying under 16384 avoids the ~129s first-token latency cliff,
    // so batch size is the lever, not max_tokens.
    const BATCH_SIZE = 8;
    const batches: typeof pending[] = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) batches.push(pending.slice(i, i + BATCH_SIZE));

    // Progress is absolute over the whole project so a resume reads
    // "12/20", not a fresh "1/8".
    const totalBatchesAbsolute = Math.ceil(allBeats.length / BATCH_SIZE);
    const startBatchIdx = Math.floor(alreadyDoneCount / BATCH_SIZE);

    send({
      type: "status",
      message: alreadyDoneCount > 0
        ? `Resuming — ${pending.length} beat${pending.length === 1 ? "" : "s"} still need prompts (${alreadyDoneCount} already written)...`
        : `Writing image prompts for ${pending.length} beats...`,
    });
    if (totalBatchesAbsolute > 1) send({ type: "progress", current: startBatchIdx, total: totalBatchesAbsolute });

    // Whole-script consistency sheet, same as the combined pass: one call up
    // front so every batch reuses IDENTICAL character/location/style wording
    // instead of each inventing its own and drifting. The script is rebuilt
    // from the beat segments rather than read from projects.script — after a
    // merge the segments ARE what gets narrated, and they can't be stale.
    // Best-effort: the builder falls back to a per-batch sheet on failure.
    let consistencySheet = "";
    try {
      send({ type: "status", message: "Building character & style consistency sheet…" });
      const narration = allBeats.map((b) => b.scriptSegment).join(" ");
      const sheetMsg = await retryClaudeCall("consistency sheet", () =>
        anthropic.messages.create({
          model,
          max_tokens: 2000,
          system: [{ type: "text", text: SYSTEM_PROMPT }],
          messages: [{ role: "user", content: buildConsistencySheetPrompt(narration, visualProfile) }],
        }),
      );
      consistencySheet = sheetMsg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      console.log(`[fill-prompts] consistency sheet built (${consistencySheet.length} chars)`);
      void logAnthropicCost({
        projectId,
        userId,
        step: "prompts_image",
        model,
        routing,
        usage: sheetMsg.usage,
        kieCreditsConsumed: takeLastCreditsConsumed(),
      });
    } catch (err) {
      console.warn("[fill-prompts] consistency sheet failed — falling back to per-batch:", err instanceof Error ? err.message : err);
    }

    const cachedUserBlock = buildFillPromptsCached(visualProfile, promptStyle, consistencySheet);

    // Generate prompts for one batch of beats. On a max_tokens truncation the
    // batch is halved and each half regenerated — the same self-heal as the
    // image pass, except the unit being split is beats rather than words. A
    // dense batch would otherwise truncate deterministically: the resume path
    // re-queues the identical beats and the retry re-truncates.
    async function genFillForBeats(
      batch: typeof pending,
      batchLabel: string,
      depth: number,
    ): Promise<ReturnType<typeof FillPromptsSchema.parse>["beats"]> {
      const MAX_SPLIT_DEPTH = 3;
      const label = `${batchLabel}${depth > 0 ? ` (split d${depth})` : ""}`;
      const t0 = Date.now();

      const { res, input } = await retryClaudeCall(
        label,
        async (): Promise<{ res: Anthropic.Messages.Message; input: Record<string, unknown> | null }> => {
          const ac = new AbortController();
          const STREAM_IDLE_MS = 300_000;
          let idleTimer: ReturnType<typeof setTimeout> | null = null;
          const armIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(
              () => ac.abort(new Error(`KIE stream idle >${STREAM_IDLE_MS}ms — aborting to retry with a fresh request`)),
              STREAM_IDLE_MS,
            );
          };
          const stream = anthropic.messages.stream({
            ...modelParamsFor(model),
            max_tokens: 8192,
            system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            tools: [{ name: "save_fill_prompts", description: "Save an image prompt for each beat you were given", input_schema: fillPromptsInputSchema }],
            tool_choice: { type: "tool", name: "save_fill_prompts" },
            messages: [{
              role: "user",
              content: [
                { type: "text", text: cachedUserBlock, cache_control: { type: "ephemeral" } },
                { type: "text", text: buildFillPromptsDynamic(batch) },
              ],
            }],
          }, { signal: ac.signal });
          let cancelled = false;
          try {
            armIdle();
            let toolJsonAccum = "";
            let lastReportedBeats = 0;
            let lastKeepalive = Date.now();
            let lastCancelCheck = Date.now();
            for await (const ev of stream) {
              armIdle();
              if (Date.now() - lastCancelCheck > CANCEL_POLL_MS) {
                lastCancelCheck = Date.now();
                if (await isRunCancelled(projectId, runId)) {
                  cancelled = true;
                  ac.abort(cancelledError());
                  break;
                }
              }
              if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") {
                toolJsonAccum += ev.delta.partial_json;
                const complete = countCompleteBeatsInPartialJson(toolJsonAccum);
                if (complete > lastReportedBeats) {
                  lastReportedBeats = complete;
                  send({ type: "chunk_beat_progress", chunkIndex: startBatchIdx, beatsInChunk: complete });
                  lastKeepalive = Date.now();
                }
              } else if (Date.now() - lastKeepalive > 10_000) {
                // Keepalive on any other activity, throttled. Essential for
                // the verbose text fallback, whose deltas are text_delta —
                // the branch above never fires and the client would sit
                // silent through a multi-minute batch and trip its own
                // progress watchdog.
                send({ type: "chunk_beat_progress", chunkIndex: startBatchIdx, beatsInChunk: lastReportedBeats });
                lastKeepalive = Date.now();
              }
            }
          } finally {
            if (idleTimer) clearTimeout(idleTimer);
          }
          if (cancelled) throw cancelledError();
          const message = await stream.finalMessage();

          let extracted: Record<string, unknown> | null = null;
          const toolBlock = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          if (toolBlock) {
            extracted = toolBlock.input as Record<string, unknown>;
          } else {
            const raw = message.content
              .filter((b): b is Anthropic.TextBlock => b.type === "text")
              .map((b) => b.text).join("\n");
            console.log(`[fill-prompts] ${label} fallback parsing text len=${raw.length} head=${raw.slice(0, 200)}`);
            extracted = extractToolInputFromText(raw);
            if (extracted) console.log(`[fill-prompts] ${label} fallback recovered ${(extracted.beats as unknown[])?.length ?? 0} beats`);
          }

          // Only genuinely empty responses are retried here — a truncated one
          // carries partial content and is handled by the split below.
          if (message.stop_reason !== "max_tokens") {
            if (!extracted) throw new Error(`${label}: provider returned an empty response; retrying.`);
            if (!Array.isArray(extracted.beats) || extracted.beats.length === 0) {
              throw new Error(`${label}: provider returned no prompts; retrying.`);
            }
          }
          return { res: message, input: extracted };
        },
        3,
      );

      console.log(`[fill-prompts] ${label} claude done in ${Date.now() - t0}ms stop=${res.stop_reason}`);
      void logAnthropicCost({
        projectId,
        userId,
        step: "prompts_image",
        model,
        routing,
        usage: res.usage,
        kieCreditsConsumed: takeLastCreditsConsumed(),
      });

      if (res.stop_reason === "max_tokens") {
        if (depth < MAX_SPLIT_DEPTH && batch.length > 1) {
          const mid = Math.ceil(batch.length / 2);
          console.warn(`[fill-prompts] ${label} truncated (${batch.length} beats) — splitting into ${mid} + ${batch.length - mid}`);
          send({ type: "status", message: "A dense section exceeded the limit — splitting it into smaller pieces…" });
          const left = await genFillForBeats(batch.slice(0, mid), batchLabel, depth + 1);
          const right = await genFillForBeats(batch.slice(mid), batchLabel, depth + 1);
          return [...left, ...right];
        }
        // A single beat that can't fit 8192 tokens means the model is looping.
        assertComplete(res.stop_reason, label);
      }

      const parsed = FillPromptsSchema.safeParse(input);
      if (!parsed.success) {
        const rawBeats = ((input?.beats as Array<Record<string, unknown>>) ?? []);
        const blankFields = rawBeats.map((b, i) => {
          const missing = ["imagePrompt", "camera", "lighting", "mood", "action"]
            .filter((k) => !b[k] || (typeof b[k] === "string" && (b[k] as string).trim() === ""));
          return missing.length ? `beat#${b.beatNumber ?? i}: missing=${missing.join(",")}` : null;
        }).filter(Boolean);
        console.error(`[fill-prompts] ${label} schema validation failed`, {
          beatCount: rawBeats.length,
          blankFields,
          zodIssues: parsed.error.issues,
        });
        throw new Error(`${label} returned prompts with missing fields (${blankFields.slice(0, 3).join("; ") || "schema mismatch"}). Try again — prompts saved so far are kept.`);
      }
      return parsed.data.beats;
    }

    async function processBatch(i: number): Promise<void> {
      await assertPromptsRunActive(projectId, runId);
      const batch = batches[i];
      const label = `fill batch ${i + 1}/${batches.length}`;
      // Beat numbers and run id on every batch: when a step stalls while the
      // cost ledger keeps growing, this is what distinguishes "the model kept
      // being asked" from "a second run took over" from "the writes went
      // nowhere".
      console.log(`[fill-prompts] ${label} start beats=${batch[0]?.beatNumber}-${batch[batch.length - 1]?.beatNumber} run=${runId}`);
      const filled = await genFillForBeats(batch, label, 0);

      // Keep only beats this batch actually asked for. The model is told not
      // to invent beat numbers, but the RPC updates by number — a
      // hallucinated one would silently overwrite a beat the user has
      // already paid for and approved, possibly outside this batch.
      const requested = new Set(batch.map((b) => b.beatNumber));
      const usable = filled.filter((b) => requested.has(b.beatNumber));
      const strays = filled.length - usable.length;
      if (strays > 0) console.warn(`[fill-prompts] ${label} dropped ${strays} beat(s) with numbers outside the batch`);
      if (usable.length === 0) {
        throw new Error(`${label} returned no prompts for the beats it was given. Try again — prompts saved so far are kept.`);
      }
      // Deliberately no assertPromptsRunActive between Claude returning and
      // this write: the work is already paid for, so a mid-call Stop still
      // banks it. The assert at the top of the next batch stops the run.
      const { data: updatedRows, error: batchErr } = await supabase.rpc("batch_update_beat_image_prompts", {
        p_project_id: projectId,
        p_updates: usable.map((b) => ({
          beat_number: b.beatNumber,
          image_prompt: b.imagePrompt,
          camera: b.camera,
          lighting: b.lighting,
          mood: b.mood,
          action: b.action,
        })),
      });
      if (batchErr) throw new Error(`Failed to save prompts for ${label}: ${batchErr.message}`);
      // The RPC returns how many rows it actually touched, and we used to
      // ignore it — so a write that matched nothing was indistinguishable from
      // success. That is the one shape that burns credits invisibly: the model
      // call is already billed by the time we get here, and a silent zero-row
      // write leaves the step looking stuck while the ledger keeps climbing.
      // Log every write, and treat a zero as the failure it is.
      const written = typeof updatedRows === "number" ? updatedRows : null;
      console.log(`[fill-prompts] ${label} wrote ${written ?? "?"}/${usable.length} beat(s) run=${runId}`);
      if (written === 0) {
        throw new Error(
          `${label}: the database rejected all ${usable.length} prompts (0 rows updated) — the beats may have been ` +
          `renumbered or deleted mid-run. Prompts saved so far are kept.`,
        );
      }
      // A short batch leaves its missing beats pending, which the next run
      // picks up — but say so, rather than letting the step look complete.
      if (usable.length < batch.length) {
        console.warn(`[fill-prompts] ${label} filled ${usable.length}/${batch.length} beats — the rest stay pending`);
      }
    }

    // Admin-tunable, shared with the combined image pass — same provider,
    // same call size, so the same concurrency ceiling applies.
    const CONCURRENCY = (await getConcurrencyConfig()).image_prompts_chunks;
    let nextIdx = 0;
    let completed = 0;
    let firstError: Error | null = null;

    async function worker() {
      while (true) {
        if (firstError) return;
        const myIdx = nextIdx++;
        if (myIdx >= batches.length) return;
        try {
          await processBatch(myIdx);
          completed++;
          if (totalBatchesAbsolute > 1) {
            send({ type: "progress", current: Math.min(startBatchIdx + completed, totalBatchesAbsolute), total: totalBatchesAbsolute });
          }
        } catch (err) {
          if (!firstError) firstError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()),
    );
    if (firstError) throw firstError;

    // current_state 14 is the client's completion signal and it means every
    // beat has a prompt — so re-read rather than inferring it from the batch
    // count. A batch that came back short leaves the step resumable instead
    // of claiming a completeness that isn't there.
    const { data: afterRows } = await supabase
      .from("project_beats")
      .select("image_prompt")
      .eq("project_id", projectId);
    const stillMissing = (afterRows ?? []).filter((r) => !(r.image_prompt as string | null)?.trim()).length;
    if (stillMissing > 0) {
      throw new Error(`${stillMissing} beat${stillMissing === 1 ? "" : "s"} still need a prompt. Click Resume to finish them — prompts saved so far are kept.`);
    }
    const { error: finalUpdErr } = await supabase
      .from("projects")
      .update({ current_state: 14, prompts_active_run_id: null, prompts_active_step: null, prompts_stop_requested: false })
      .eq("id", projectId)
      .eq("user_id", userId);
    if (finalUpdErr) console.error(`[fill-prompts] completion write failed project=${projectId}:`, finalUpdErr);
    console.log(`[fill-prompts] done project=${projectId} beats=${allBeats.length}`);
    send({ type: "done", beatCount: allBeats.length });
  } catch (err) {
    await recordPromptsFailure(projectId, userId, "fill", err);
    throw err;
  } finally {
    await releasePromptsRunIfOwned(projectId, userId, runId);
  }
}

// ── Step 2: Video prompts ──────────────────────────────────────────────────
export async function generateVideos(projectId: string, userId: string, send: (data: object) => void, model: string) {
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
  // A motion prompt describes how to animate THIS beat's image, so a beat with
  // no image prompt has nothing to derive from — the model would be handed a
  // null and invent a shot. Those beats are skipped rather than filled with
  // guesses; the next run picks them up once their image prompt exists.
  const pendingBeats = allBeats
    .filter((b) => !b.hasVideoPrompt && !!b.imagePrompt?.trim())
    .map((b) => ({ beatNumber: b.beatNumber, scriptSegment: b.scriptSegment, imagePrompt: b.imagePrompt }));
  const skippedNoImagePrompt = allBeats.filter((b) => !b.hasVideoPrompt && !b.imagePrompt?.trim()).length;
  if (skippedNoImagePrompt > 0) {
    console.warn(`[video-prompts] skipping ${skippedNoImagePrompt} beat(s) with no image prompt project=${projectId}`);
  }

  if (pendingBeats.length === 0 && alreadyDoneCount === 0) {
    throw new Error("No image prompts yet. Run Image Prompts first — a motion prompt is written from its beat's image prompt.");
  }

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
          ...modelParamsFor(model),
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
  } catch (err) {
    await recordPromptsFailure(projectId, userId, "videos", err);
    throw err;
  } finally {
    await releasePromptsRunIfOwned(projectId, userId, runId);
  }
}

// ── Step 3: Thumbnails ─────────────────────────────────────────────────────
export async function generateThumbnails(
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
        ...modelParamsFor(model),
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
