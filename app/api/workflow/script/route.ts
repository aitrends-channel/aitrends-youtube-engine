import { getAnthropicClient, MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import { streamGeminiText, GEMINI_MAX_OUTPUT_TOKENS, GEMINI_MODEL } from "@/lib/gemini/client";
import { buildScriptPrompt } from "@/lib/claude/prompts";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { ChannelAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 800;

// Model picker — Opus for short targets (it honors length), Gemini Flash
// for long-form (>8000 words) where Opus's 8192-token per-call ceiling
// would otherwise force chunking.
const LONG_FORM_THRESHOLD = 8000;
const OPUS_MAX_OUTPUT_TOKENS = 8192;
const GEMINI_MAX_WORDS = Math.floor((GEMINI_MAX_OUTPUT_TOKENS - 120) / 1.6); // ≈ 40,885

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

  try {
    const { projectId, analysis, topic } = await req.json() as {
      projectId: string;
      analysis: ChannelAnalysisOutput;
      topic: string;
    };

    if (!analysis || !topic) {
      return new Response("Missing analysis or topic", { status: 400 });
    }

    const target = analysis.targetWordCount ?? 900;
    const useGemini = target > LONG_FORM_THRESHOLD;
    const initialPrompt = buildScriptPrompt(analysis, topic);
    const activeModel = useGemini ? GEMINI_MODEL : MODEL;

    // Per-model token budget. Gemini gets enough headroom to land near
    // the channel target. Opus is capped at its 8192-per-call ceiling
    // (covers up to ~5,000 words — anything beyond will fall short
    // naturally, no enforced trim).
    const modelMax = useGemini ? GEMINI_MAX_OUTPUT_TOKENS : OPUS_MAX_OUTPUT_TOKENS;
    const targetForBudget = useGemini ? Math.min(target, GEMINI_MAX_WORDS) : target;
    const maxTokens = Math.min(modelMax, Math.ceil(targetForBudget * 1.6) + 200);

    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let accumulated = "";

        function send(data: object) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        }

        // Check for spirals only every N characters of new content — the
        // detection is O(window) and we don't want to run it on every
        // single token delta.
        let charsUntilNextCheck = 0;
        let spiralAborted = false;
        const SPIRAL_CHECK_INTERVAL = 400;

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
        };

        try {
          send({ model: activeModel, target, useGemini });

          // Gemini ignores soft length guidance — push back with a
          // structural directive so it at least aims for the target.
          // No hard enforcement after generation (no trim, no extend).
          const userPrompt = useGemini
            ? `LENGTH GOAL\nThis script should be approximately ${target.toLocaleString()} words to match the channel's natural video length. Aim for that target — don't summarize or wrap up early.\n\nSTRUCTURE: roughly ${Math.max(6, Math.ceil(target / 800))} narrative sections of about ${Math.round(target / Math.max(6, Math.ceil(target / 800)))} words each, different angles, seamless transitions, do NOT label them in output.\n\n${initialPrompt}`
            : initialPrompt;

          if (useGemini) {
            await streamGeminiText({
              userId: user.id,
              maxTokens,
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
              ],
              onDelta: sendText,
            });
          } else {
            const anthropic = await getAnthropicClient(user.id);
            const stream = anthropic.messages.stream({
              model: MODEL,
              max_tokens: maxTokens,
              system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: userPrompt }],
            });
            for await (const event of stream) {
              if (spiralAborted) {
                try { stream.abort(); } catch { /* ignore */ }
                break;
              }
              if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                sendText(event.delta.text);
              }
            }
          }

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
          const wordCount = countWords(finalScript);
          await supabase
            .from("projects")
            .update({ script: finalScript, word_count: wordCount, selected_topic: topic, current_state: 7 })
            .eq("id", projectId)
            .eq("user_id", user.id);

          send({ done: true, wordCount });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Generation failed mid-stream";
          if (accumulated.trim().length > 0) {
            await supabase
              .from("projects")
              .update({
                script: accumulated.trim(),
                word_count: countWords(accumulated),
                selected_topic: topic,
              })
              .eq("id", projectId)
              .eq("user_id", user.id)
              .then(() => {}, () => {});
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
