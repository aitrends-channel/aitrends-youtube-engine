import { getAnthropicClient, MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import { streamGeminiText, GEMINI_MAX_OUTPUT_TOKENS, GEMINI_MODEL } from "@/lib/gemini/client";
import { buildScriptPrompt } from "@/lib/claude/prompts";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { ChannelAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 800;

// Single-call script generation with model switching:
//   • target ≤ 8000 words  → Claude Opus 4.7 (sharper prose, capped at
//                            8192 output tokens ≈ ~5,045 words)
//   • target > 8000 words  → Gemini 2.5 Flash (output ceiling 65,536
//                            tokens ≈ ~40k words; covers long-form
//                            channels like sleep history compilations)
//
// 8000 is chosen as the threshold because Opus's 8192-token ceiling
// translates to roughly 5,000 words — anything beyond that needs a
// model with a higher per-call output limit.
const LONG_FORM_THRESHOLD = 8000;
const OPUS_MAX_OUTPUT_TOKENS = 8192;
const OPUS_MAX_WORDS = Math.floor((OPUS_MAX_OUTPUT_TOKENS - 120) / 1.6);   // ≈ 5,045
const GEMINI_MAX_WORDS = Math.floor((GEMINI_MAX_OUTPUT_TOKENS - 120) / 1.6); // ≈ 40,885

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

    const rawTarget = analysis.targetWordCount ?? 900;
    const useGemini = rawTarget > LONG_FORM_THRESHOLD;
    const modelCap = useGemini ? GEMINI_MAX_WORDS : OPUS_MAX_WORDS;
    const modelMaxTokens = useGemini ? GEMINI_MAX_OUTPUT_TOKENS : OPUS_MAX_OUTPUT_TOKENS;
    const target = Math.min(rawTarget, modelCap);
    const targetWasCapped = rawTarget > modelCap;
    const maxTokens = Math.min(modelMaxTokens, Math.ceil(target * 1.6) + 120);
    const initialPrompt = buildScriptPrompt(analysis, topic);
    const activeModel = useGemini ? GEMINI_MODEL : MODEL;

    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let accumulated = "";

        const sendText = (text: string) => {
          accumulated += text;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
        };

        try {
          // Up-front notice frames so the UI knows which model is doing
          // the work and whether the target had to be trimmed.
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ model: activeModel, target, useGemini })}\n\n`
          ));
          if (targetWasCapped) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ notice: `Channel analysis suggested ${rawTarget.toLocaleString()} words — capped to ${modelCap.toLocaleString()} (${useGemini ? "Gemini" : "Opus"} per-call ceiling).` })}\n\n`
            ));
          }

          if (useGemini) {
            // Gemini 2.5 Flash heavily under-delivers on length when
            // given Claude-shaped prompts. We reinforce the target with
            // structural scaffolding so it can't bail out at 10% of the
            // ask: explicit section count, per-section word budget, and
            // an unambiguous "MUST" framing on length.
            const targetSections = Math.max(6, Math.ceil(target / 800));
            const wordsPerSection = Math.round(target / targetSections);
            const longFormDirective =
`CRITICAL — LENGTH IS NON-NEGOTIABLE
This script MUST be approximately ${target.toLocaleString()} words. Channels in this niche publish scripts of this length and viewers expect that pacing. Do NOT summarize, condense, or wrap up early.

STRUCTURE
- Break the script into roughly ${targetSections} narrative sections, each ~${wordsPerSection} words.
- Each section explores the topic from a different angle: history, mechanics, daily life, anecdotes, edge cases, sensory detail, then a closing reflection.
- Keep transitions seamless — do NOT label or number the sections in the output.
- Maintain the channel's pacing throughout. If you finish a thought before hitting the per-section budget, deepen the detail rather than moving on.

Continue writing until you have produced at least ${target.toLocaleString()} words of script. The user will reject anything substantially shorter.

`;
            await streamGeminiText({
              userId: user.id,
              maxTokens,
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: longFormDirective + initialPrompt },
              ],
              onDelta: sendText,
            });
          } else {
            const anthropic = await getAnthropicClient(user.id);
            const stream = anthropic.messages.stream({
              model: MODEL,
              max_tokens: maxTokens,
              system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: initialPrompt }],
            });
            for await (const event of stream) {
              if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                sendText(event.delta.text);
              }
            }
          }

          const finalScript = accumulated.trim();
          const wordCount = finalScript.split(/\s+/).filter(Boolean).length;
          await supabase
            .from("projects")
            .update({ script: finalScript, word_count: wordCount, selected_topic: topic, current_state: 7 })
            .eq("id", projectId)
            .eq("user_id", user.id);

          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, wordCount })}\n\n`));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Generation failed mid-stream";
          // Save whatever we got so the user can recover or restart.
          if (accumulated.trim().length > 0) {
            await supabase
              .from("projects")
              .update({
                script: accumulated.trim(),
                word_count: accumulated.trim().split(/\s+/).filter(Boolean).length,
                selected_topic: topic,
              })
              .eq("id", projectId)
              .eq("user_id", user.id)
              .then(() => {}, () => {});
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`));
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
