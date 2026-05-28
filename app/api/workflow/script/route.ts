import { getAnthropicClient, MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import { buildScriptPrompt } from "@/lib/claude/prompts";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { ChannelAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 120;

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

    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildScriptPrompt(analysis, topic) }],
    });

    let fullScript = "";

    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const text = event.delta.text;
            fullScript += text;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
          }
        }

        const wordCount = fullScript.trim().split(/\s+/).length;
        await supabase
          .from("projects")
          .update({ script: fullScript.trim(), word_count: wordCount, selected_topic: topic, current_state: 7 })
          .eq("id", projectId)
          .eq("user_id", user.id);

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, wordCount })}\n\n`));
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
