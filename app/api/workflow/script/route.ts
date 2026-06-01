import { getAnthropicClient, MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import { buildScriptPrompt } from "@/lib/claude/prompts";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { ChannelAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 300;

// Generate the script in N sequential Claude calls. The client makes
// ONE fetch and consumes ONE continuous stream — segmentation is
// entirely server-side. Each section after the first uses Claude's
// assistant-prefill pattern: prior text is passed as a leading
// assistant message and Claude continues from where it left off,
// coherent and seamless.
//
// Section count scales with target length so each section's max_tokens
// stays comfortably under Opus's 8192-per-call ceiling.
//
// 300s Vercel cap + ~30-60 tok/sec Opus streaming = ~9000-18000 tokens
// reliably in budget. Scripts past that ceiling will hit timeout, so we
// hard-cap target word count to what we can deliver and tell the user.
const SAFE_TOKENS_PER_SECTION = 6000;       // under Opus 8192 ceiling
const SAFE_TOTAL_TOKEN_BUDGET = 9000;       // conservative 300s ceiling
const MAX_TARGET_WORDS = Math.floor(SAFE_TOTAL_TOKEN_BUDGET / 1.6); // ≈ 5625

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const anthropic = await getAnthropicClient(user.id);
    const { projectId, analysis, topic } = await req.json() as {
      projectId: string;
      analysis: ChannelAnalysisOutput;
      topic: string;
    };

    if (!analysis || !topic) {
      return new Response("Missing analysis or topic", { status: 400 });
    }

    const rawTarget = analysis.targetWordCount ?? 900;
    const target = Math.min(rawTarget, MAX_TARGET_WORDS);
    const targetWasCapped = rawTarget > MAX_TARGET_WORDS;

    // Pick the smallest section count that keeps each section's token
    // budget under SAFE_TOKENS_PER_SECTION. ~1.6 tokens per word.
    const totalTokens = Math.ceil(target * 1.6) + 120;
    const TOTAL_SECTIONS = Math.max(2, Math.ceil(totalTokens / SAFE_TOKENS_PER_SECTION));
    const tokensPerSection = Math.ceil(totalTokens / TOTAL_SECTIONS);
    const initialPrompt = buildScriptPrompt(analysis, topic);

    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let accumulated = "";

        try {
          if (targetWasCapped) {
            // Tell the client up front that the script will be shorter
            // than the channel's natural length. UI can surface this.
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ notice: `Channel analysis suggested ${rawTarget.toLocaleString()} words — capped to ${MAX_TARGET_WORDS.toLocaleString()} to fit within generation limits.` })}\n\n`
            ));
          }

          for (let i = 0; i < TOTAL_SECTIONS; i++) {
            // Optional: client can use this to show "Section 3 of 5" if
            // it wants — current useStreamingScript ignores unknown keys.
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ section: i + 1, total: TOTAL_SECTIONS })}\n\n`
            ));

            const messages: { role: "user" | "assistant"; content: string }[] = [
              { role: "user", content: initialPrompt },
            ];
            if (accumulated.length > 0) {
              messages.push({ role: "assistant", content: accumulated });
            }

            // Final section gets headroom to close out the CTA cleanly.
            const maxTokens = i === TOTAL_SECTIONS - 1
              ? tokensPerSection + 150
              : tokensPerSection;

            const stream = anthropic.messages.stream({
              model: MODEL,
              max_tokens: maxTokens,
              system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
              messages,
            });

            for await (const event of stream) {
              if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                const text = event.delta.text;
                accumulated += text;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
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
