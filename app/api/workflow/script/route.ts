import { randomUUID } from "crypto";
import { getAnthropicClient, SYSTEM_PROMPT } from "@/lib/claude/client";
import { resolveDefaultModel } from "@/lib/claude/models";
import { buildScriptPrompt, getEffectiveScriptTargetWordCount } from "@/lib/claude/prompts";
import { retryClaudeCall } from "@/lib/claude/retry";
import { stripCaptionCues } from "@/lib/youtube/supadata";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { logAnthropicCost } from "@/lib/costs";
import type { ChannelAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";
import { requireActiveSubscription } from "@/lib/subscription";

export const maxDuration = 800;

// Cancellation signal for in-flight script generation. claimScriptRun
// writes a fresh UUID on the project at start; assertScriptRunActive
// re-reads it between text deltas and throws if it's been replaced
// (newer run) or nulled (e.g. force-cleared). The message is unique so
// the catch handler can recognize a cancellation and skip overwriting
// the newer run's output. Works for both real-streaming (direct
// Anthropic) and batched (KIE proxy) — the run-id check happens at
// our function boundary, not the upstream's.
const CANCELLED_MSG = "Script generation was cancelled — replaced by a newer run.";

async function claimScriptRun(projectId: string, userId: string): Promise<string | null> {
  const runId = randomUUID();
  const { error } = await supabase
    .from("projects")
    .update({ script_active_run_id: runId })
    .eq("id", projectId)
    .eq("user_id", userId);
  if (error) {
    console.warn("[script-cancel] could not claim run id; cancellation disabled for this run", error);
    return null;
  }
  return runId;
}

async function assertScriptRunActive(projectId: string, runId: string | null): Promise<void> {
  if (!runId) return;
  const { data, error } = await supabase
    .from("projects")
    .select("script_active_run_id")
    .eq("id", projectId)
    .single();
  if (error) {
    console.warn("[script-cancel] could not read run id; skipping check", error);
    return;
  }
  if (!data || data.script_active_run_id !== runId) {
    throw new Error(CANCELLED_MSG);
  }
}

// claude-opus-4-7 supports up to 32K output tokens per call. At ~1.6
// tokens/word that's ~20K words in a single shot — wide enough that we
// no longer need a Gemini fallback for long-form scripts. Opus stays
// on the line all the way through.
const OPUS_MAX_OUTPUT_TOKENS = 32000;

// Checkpoint cadence — every ~3000 chars of streamed output we
// fire-and-forget an UPDATE of projects.script with the running
// accumulated text. At ~80 chars/sec of natural speech that's a
// checkpoint roughly every 30s, bounding worst-case data loss to a
// single checkpoint window if Vercel hard-kills us mid-stream.
const CHECKPOINT_INTERVAL = 3000;

// Soft deadline that's ~80s under the route's maxDuration=800s. When
// elapsed time crosses this, we abort the upstream stream ourselves
// and run the partial-save path so the user has something to Continue
// from. The 80s buffer covers the trim/strip/final-save tail.
const SOFT_DEADLINE_MS = 720_000;

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// Detects an LLM repetition death-spiral. When a model thinks it's done
// but still has token budget left, it falls into loops like
// "Sleep. Sleep. Sleep. Goodnight. Sleep. Sleep." with very low lexical
// diversity. Returns true when the tail of the text has dropped below
// the unique-word ratio threshold over a long enough window.
function isInRepetitionSpiral(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 250) return false; // not enough signal yet
  const tail = words.slice(-200);
  const unique = new Set(tail.map((w) => w.toLowerCase().replace(/[.,!?;:"']/g, "")));
  // Normal prose hovers at 50-70% unique words across 200 words. Real
  // spirals collapse to <15%. 25% is well below natural prose and
  // wouldn't fire on legitimate repetition (refrains, etc.).
  return unique.size / tail.length < 0.25;
}

// Walk backward from the end and chop everything that looks like a
// spiral tail. Stops at the first sentence boundary preceded by a
// healthy lexical-diversity window.
function trimRepetitionTail(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 250) return text.trim();

  // Find the latest 100-word window where unique-word ratio is healthy.
  let cutoffWordIdx = words.length;
  for (let end = words.length; end >= 250; end -= 50) {
    const window = words.slice(end - 100, end);
    const unique = new Set(window.map((w) => w.toLowerCase().replace(/[.,!?;:"']/g, "")));
    if (unique.size / window.length >= 0.5) {
      cutoffWordIdx = end;
      break;
    }
  }
  if (cutoffWordIdx >= words.length) return text.trim();

  // Trim to that word index, then walk back to the nearest sentence end
  // so we don't cut mid-thought.
  const truncated = words.slice(0, cutoffWordIdx).join(" ");
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("!"),
    truncated.lastIndexOf("?")
  );
  if (lastSentenceEnd > 0) return truncated.slice(0, lastSentenceEnd + 1).trim();
  return truncated.trim();
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const expired = requireActiveSubscription(user);
  if (expired) return expired;

  try {
    const { projectId, analysis, topic, mode } = await req.json() as {
      projectId: string;
      analysis: ChannelAnalysisOutput;
      topic: string;
      mode?: "fresh" | "continue";
    };
    const modelParams = await resolveDefaultModel();
    const model = modelParams.model;

    if (!analysis || !topic) {
      return new Response("Missing analysis or topic", { status: 400 });
    }

    // Continue mode reads the partial script saved by a prior user-Stop
    // and feeds it back as an assistant prefill so the model picks up
    // exactly where it left off. Cheaper than rerunning from scratch
    // because we only pay for the continuation tokens, not the entire
    // script. Works on both direct Anthropic and KIE proxy because both
    // accept role: "assistant" as the final turn.
    let existingScript = "";
    if (mode === "continue") {
      const { data: row } = await supabase
        .from("projects")
        .select("script")
        .eq("id", projectId)
        .eq("user_id", user.id)
        .single();
      existingScript = ((row?.script as string | null) ?? "").trim();
      if (!existingScript) {
        return new Response("Nothing to continue — no saved draft on this project", { status: 400 });
      }
    }

    // Cap at the 45-min consent gate from the channel step — channels
    // whose true average is past that produce a longer
    // analysis.targetWordCount, but we don't want to ask the model for
    // a >45min script. Sub-threshold channels pass through unchanged.
    const target = getEffectiveScriptTargetWordCount(analysis);
    const initialPrompt = buildScriptPrompt(analysis, topic);
    const activeModel = model;

    // Token budget. Sub-threshold channels stay on the full Opus ceiling
    // (32K) so a script that wants to run a touch long isn't artificially
    // truncated — same behavior as before. Compressed runs (channel's
    // natural avg > 45min, so target was clamped) instead get a tight
    // budget scaled to the target. Without this, the model has ~20K
    // words of output budget but a 5400-word target — it routinely
    // drifts to 9-12K words, blowing past the soft deadline and giving
    // the user the "too slow" experience. 1.8 tokens/word + a 500-token
    // buffer covers natural variance without inviting drift.
    const isCompressed = (analysis.targetWordCount ?? 0) > target;
    const maxTokens = isCompressed
      ? Math.min(OPUS_MAX_OUTPUT_TOKENS, Math.ceil(target * 1.8) + 500)
      : OPUS_MAX_OUTPUT_TOKENS;

    // Claim the run BEFORE returning the stream so the project row
     // already reflects "in flight" by the time the client receives the
     // first byte. A second click between this and the next claim will
     // overwrite the UUID and the older run's assertScriptRunActive
     // will trip.
    const runId = await claimScriptRun(projectId, user.id);

    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        // Continue mode seeds accumulated with the existing partial so
        // the spiral / repetition checks see the full context and the
        // final save concatenates correctly. The client also pre-loads
        // its display from the same project.script row.
        let accumulated = existingScript;
        let cancelled = false;
        // Soft deadline tracking — when we cross SOFT_DEADLINE_MS we
        // flip this flag, abort the upstream stream, and let the
        // final-save path persist what we have. Vercel would otherwise
        // hard-kill us at maxDuration with no chance to save.
        const startedAt = Date.now();
        let deadlineHit = false;

        function send(data: object) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // Client disconnected; subsequent enqueues become no-ops.
          }
        }

        // Checkpoint save — fire-and-forget UPDATE of projects.script
        // with the running text so a hard-kill at any point leaves a
        // recent draft the user can Continue from. Ownership-checked
        // (script_active_run_id = runId) so a stale checkpoint from
        // an older run can't clobber a newer run's data. In-flight
        // guard avoids overlapping requests landing out of order —
        // we'd rather drop a checkpoint than risk an older payload
        // overwriting a newer one.
        let checkpointInFlight = false;
        const fireCheckpoint = (text: string) => {
          if (checkpointInFlight || !runId) return;
          checkpointInFlight = true;
          const snapshot = text;
          supabase
            .from("projects")
            .update({
              script: snapshot,
              word_count: countWords(snapshot),
              selected_topic: topic,
            })
            .eq("id", projectId)
            .eq("user_id", user.id)
            .eq("script_active_run_id", runId)
            .then(
              () => { checkpointInFlight = false; },
              () => { checkpointInFlight = false; },
            );
        };

        // Check for spirals only every N characters of new content — the
        // detection is O(window) and we don't want to run it on every
        // single token delta.
        let charsUntilNextCheck = 0;
        let spiralAborted = false;
        const SPIRAL_CHECK_INTERVAL = 400;
        // Run-id check has its own throttle — re-reading the project row
        // on every delta would hammer Supabase. ~every 1500 chars (~5s
        // of natural speech) keeps the cost negligible and bounds the
        // worst-case duplicate-Claude-spend on a stale run to a few
        // seconds of tokens.
        let charsUntilRunCheck = 0;
        const RUN_CHECK_INTERVAL = 1500;
        let charsUntilCheckpoint = 0;

        const sendText = (text: string): void | "abort" => {
          accumulated += text;
          send({ text });
          charsUntilNextCheck -= text.length;
          if (charsUntilNextCheck <= 0) {
            charsUntilNextCheck = SPIRAL_CHECK_INTERVAL;
            if (isInRepetitionSpiral(accumulated)) {
              spiralAborted = true;
              return "abort";
            }
          }
          charsUntilRunCheck -= text.length;
          if (charsUntilRunCheck <= 0) {
            charsUntilRunCheck = RUN_CHECK_INTERVAL;
            // Fire-and-forget the run check — if it throws, set the
            // cancelled flag so the next sendText returns "abort". We
            // don't await here because sendText is called synchronously
            // by the streaming SDK callback signature.
            assertScriptRunActive(projectId, runId).catch((err) => {
              if (err instanceof Error && err.message === CANCELLED_MSG) {
                cancelled = true;
              }
            });
          }
          charsUntilCheckpoint -= text.length;
          if (charsUntilCheckpoint <= 0) {
            charsUntilCheckpoint = CHECKPOINT_INTERVAL;
            fireCheckpoint(accumulated);
          }
          // Soft deadline — cheap clock check, no IO. If we're past
          // the budget, surface a status frame to the client (so the
          // UI can show "stopped at time limit") then abort.
          if (!deadlineHit && (Date.now() - startedAt) > SOFT_DEADLINE_MS) {
            deadlineHit = true;
            send({ deadlineHit: true });
            return "abort";
          }
          if (cancelled) return "abort";
        };

        try {
          send({ model: activeModel, target });

          // Length-goal directive: even with the full Opus budget,
          // models tend to wrap up early on creative writing. The
          // structural prompt + explicit target nudges Opus to actually
          // aim for the right length instead of landing 30% short. No
          // hard enforcement after generation (no trim, no extend).
          //
          // The "compressed" branch fires for channels whose natural
          // average exceeds the 45-min consent gate from the channel
          // step. In that case `target` is the capped value, NOT the
          // channel's true average — so the prompt needs to flag the
          // compression explicitly and remind the model to preserve the
          // full beginning → middle → end arc, not lop off the middle.
          const lengthGoal = isCompressed
            ? `LENGTH GOAL\nThis script must land at approximately ${target.toLocaleString()} words — a compressed version of the channel's natural length. STAY AT THAT TARGET — do not exceed it. The compression comes from tighter pacing across all phases (hook, development, ending), not from cutting any phase entirely.`
            : `LENGTH GOAL\nThis script should be approximately ${target.toLocaleString()} words to match the channel's natural video length. Aim for that target — don't summarize or wrap up early.`;
          const sectionCount = Math.max(6, Math.ceil(target / 800));
          const userPrompt = `${lengthGoal}\n\nSTRUCTURE: roughly ${sectionCount} narrative sections of about ${Math.round(target / sectionCount)} words each, different angles, seamless transitions, do NOT label them in output. The arc still runs hook → development → ending CTA across those sections — preserve the channel's signature opening and ending moves.\n\n${initialPrompt}`;

          // Continue-mode prefix nudges the model to splice cleanly
          // rather than restating context or wrapping up early. The
          // existing text goes in as the assistant turn — the model
          // sees it as words it just wrote and continues naturally.
          const continueDirective = mode === "continue"
            ? "\n\nThe script below has already been started — pick up exactly where it ends, mid-sentence if needed, with the same voice and pacing. Do not recap, restate, or summarize what's been written. Continue smoothly until the natural end of the piece."
            : "";

          const { client: anthropic, routing, takeLastCreditsConsumed } = await getAnthropicClient(user.id, "script");
          await retryClaudeCall("script (Opus)", async () => {
            if (accumulated.length > existingScript.length) return; // already past first attempt with new content emitted; skip retries
            const opusMessages: { role: "user" | "assistant"; content: string }[] = [
              { role: "user", content: userPrompt + continueDirective },
            ];
            if (mode === "continue") opusMessages.push({ role: "assistant", content: existingScript });
            // Per-request timeout override. The default Anthropic client
            // timeout (180s, see lib/claude/client.ts) is fine for
            // analyze/ideas/thumbnails — sub-minute calls. Script
            // generation routinely needs longer, especially on KIE which
            // buffers the stream server-side and delivers nothing until
            // generation completes. 700s sits just inside the route's
            // 720s soft-deadline so the route's own deadline path still
            // gets to save a partial.
            const stream = anthropic.messages.stream({
              ...modelParams,
              max_tokens: maxTokens,
              system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
              messages: opusMessages,
            }, { timeout: 700_000 });
            for await (const event of stream) {
              if (spiralAborted || cancelled || deadlineHit) {
                try { stream.abort(); } catch { /* ignore */ }
                break;
              }
              if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                sendText(event.delta.text);
              }
            }
            // Pull final usage after the stream drains. Async so it
            // can't block the script-emit path; logAnthropicCost is
            // fail-soft on its own and routes to kie_credits when
            // we're going through KIE, claude_tokens otherwise.
            try {
              const finalMsg = await stream.finalMessage();
              void logAnthropicCost({
                projectId,
                userId: user.id,
                step: "script",
                model,
                routing,
                usage: finalMsg.usage,
                kieCreditsConsumed: takeLastCreditsConsumed(),
              });
            } catch { /* finalMessage may throw if the stream was aborted */ }
          });

          // If we detected a spiral mid-stream, trim it back to clean
          // prose. Even without detection, run the trim — penalties
          // help but the model can still drift in the last few hundred
          // words, and the trim is a cheap no-op on healthy text.
          let finalScript = accumulated.trim();
          const trimmed = trimRepetitionTail(finalScript);
          if (trimmed !== finalScript && trimmed.length > 0) {
            finalScript = trimmed;
            send({ replace: finalScript });
          }
          // Strip any [Music] / [Applause] / etc. SFX cues the model
          // picked up from training transcripts. Belt-and-suspenders on
          // top of the source-transcript strip — old cached projects
          // can still produce them.
          const stripped = stripCaptionCues(finalScript);
          if (stripped !== finalScript && stripped.length > 0) {
            finalScript = stripped;
            send({ replace: finalScript });
          }
          const wordCount = countWords(finalScript);
          // Atomic conditional update: only write if our run still owns
          // the active_run_id. A second click that overwrote our UUID
          // means the new run will produce its own final save; ours
          // would just clobber it otherwise.
          //
          // Soft-deadline branch: when we bailed under the time limit
          // the script is by definition incomplete, so we skip the
          // current_state bump (which would let the user advance past
          // an unfinished script) and we keep script_active_run_id
          // cleared so a Continue click can pick up cleanly. The
          // client gets `done: true, partial: true` so the UI can show
          // a "stopped at time limit — Continue to resume" affordance
          // instead of the normal completion state.
          const update: Record<string, unknown> = {
            script: finalScript,
            word_count: wordCount,
            selected_topic: topic,
            script_active_run_id: null,
          };
          if (!deadlineHit) {
            update.current_state = 7;
          }
          const writeQuery = supabase
            .from("projects")
            .update(update)
            .eq("id", projectId)
            .eq("user_id", user.id);
          if (runId) writeQuery.eq("script_active_run_id", runId);
          await writeQuery;

          send({ done: true, wordCount, ...(deadlineHit ? { partial: true } : {}) });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Generation failed mid-stream";

          // Three reasons we can land here:
          //   1) Real mid-stream failure (network blip, model error) —
          //      save partial so the user has something to Resume from.
          //   2) User clicked Stop — PATCHed script_active_run_id to
          //      null, save partial as a draft they can Resume / Cancel.
          //   3) New Generate click took over — script_active_run_id is
          //      now a different UUID, save would clobber the new run's
          //      output. Skip.
          let shouldSavePartial = accumulated.trim().length > 0;
          if (shouldSavePartial && runId) {
            const { data: owner } = await supabase
              .from("projects")
              .select("script_active_run_id")
              .eq("id", projectId)
              .single();
            const currentOwner = owner?.script_active_run_id as string | null | undefined;
            // If a different UUID owns it now, a new run took over — skip.
            if (currentOwner && currentOwner !== runId) shouldSavePartial = false;
          }

          if (shouldSavePartial) {
            const partialQuery = supabase
              .from("projects")
              .update({
                script: accumulated.trim(),
                word_count: countWords(accumulated),
                selected_topic: topic,
                script_active_run_id: null,
              })
              .eq("id", projectId)
              .eq("user_id", user.id);
            partialQuery.then(() => {}, () => {});
          }
          send({ error: message });
        }

        controller.close();
      },
    });

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Script generation failed";
    return new Response(message, { status: 500 });
  }
}
