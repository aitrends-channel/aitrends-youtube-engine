import { NextResponse } from "next/server";
import { getAnthropicClient, MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";

export const maxDuration = 120;
import { channelAnalysisInputSchema, videoIdeasInputSchema } from "@/lib/claude/anthropicSchemas";
import { buildAnalysisPrompt, buildVideoIdeasPrompt } from "@/lib/claude/prompts";
import { ChannelAnalysisSchema, VideoIdeasSchema } from "@/lib/claude/schemas";
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
      return NextResponse.json({ error: "Transcripts are required" }, { status: 400 });
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

    const analysisToolUse = analysisResponse.content.find((b) => b.type === "tool_use");
    if (!analysisToolUse || analysisToolUse.type !== "tool_use") {
      throw new Error("No structured analysis returned");
    }

    const analysis = ChannelAnalysisSchema.parse(analysisToolUse.input) as ChannelAnalysisOutput;

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
      if (ideasToolUse && ideasToolUse.type === "tool_use") {
        const parsed = VideoIdeasSchema.parse(ideasToolUse.input);
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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
