import { NextResponse } from "next/server";
import { getAnthropicClient, MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import { logSystemEvent } from "@/lib/system-logger";

export const maxDuration = 300;
import { channelAnalysisInputSchema, videoIdeasInputSchema } from "@/lib/claude/anthropicSchemas";
import { buildAnalysisPrompt, buildVideoIdeasPrompt } from "@/lib/claude/prompts";
import { ChannelAnalysisSchema, VideoIdeasSchema } from "@/lib/claude/schemas";
import { extractToolInputFromText } from "@/lib/claude/textFallback";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { ChannelAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const anthropic = await getAnthropicClient(user.id);
    const { projectId, transcripts, topicMode, topicHint } = await req.json();

    if (!transcripts?.length) {
      return NextResponse.json({ error: "Video transcripts are required" }, { status: 400 });
    }

    const analysisResponse = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [{
        name: "save_channel_analysis",
        description: "Save the structured channel analysis results",
        input_schema: channelAnalysisInputSchema,
      }],
      tool_choice: { type: "tool", name: "save_channel_analysis" },
      messages: [{ role: "user", content: buildAnalysisPrompt(transcripts) }],
    });

    const analysisToolUse = analysisResponse.content?.find((b) => b.type === "tool_use");
    let analysisInput: unknown = null;
    if (analysisToolUse && analysisToolUse.type === "tool_use") {
      analysisInput = analysisToolUse.input;
    } else {
      // Fallback: KIE+Opus sometimes ignores tool_choice and emits the
      // structured payload as text. Recover it before giving up.
      const textBlock = analysisResponse.content?.find((b) => b.type === "text");
      const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
      console.log(`[analyze] fallback parsing text len=${raw.length} head=${raw.slice(0, 200)}`);
      analysisInput = extractToolInputFromText(raw);
    }
    if (!analysisInput) throw new Error("No structured analysis returned");

    const analysis = ChannelAnalysisSchema.parse(analysisInput) as ChannelAnalysisOutput;

    let videoIdeas: string[] | undefined;

    if (topicMode === "generate") {
      const ideasResponse = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [{
          name: "save_video_ideas",
          description: "Save the generated video ideas",
          input_schema: videoIdeasInputSchema,
        }],
        tool_choice: { type: "tool", name: "save_video_ideas" },
        messages: [{ role: "user", content: buildVideoIdeasPrompt(analysis, topicHint) }],
      });

      const ideasToolUse = ideasResponse.content.find((b) => b.type === "tool_use");
      let ideasInput: unknown = null;
      if (ideasToolUse && ideasToolUse.type === "tool_use") {
        ideasInput = ideasToolUse.input;
      } else {
        const textBlock = ideasResponse.content?.find((b) => b.type === "text");
        const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
        console.log(`[analyze.ideas] fallback parsing text len=${raw.length} head=${raw.slice(0, 200)}`);
        ideasInput = extractToolInputFromText(raw);
      }
      if (ideasInput) {
        const parsed = VideoIdeasSchema.parse(ideasInput);
        videoIdeas = parsed.ideas;
      }
    }

    await supabase
      .from("projects")
      .update({ channel_analysis: analysis, video_ideas: videoIdeas ?? null, current_state: 6 })
      .eq("id", projectId)
      .eq("user_id", user.id);

    return NextResponse.json({ analysis, videoIdeas });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis failed";
    await logSystemEvent({
      level: "error",
      source: "channel_analysis",
      message,
      userId: user.id,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
