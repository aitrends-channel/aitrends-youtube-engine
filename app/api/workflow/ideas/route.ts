import { NextResponse } from "next/server";
import { getAnthropicClient, MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import { videoIdeasInputSchema } from "@/lib/claude/anthropicSchemas";
import { buildVideoIdeasPrompt } from "@/lib/claude/prompts";
import { VideoIdeasSchema } from "@/lib/claude/schemas";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const anthropic = await getAnthropicClient(user.id);
    const { projectId } = await req.json() as { projectId: string };

    const { data: project, error } = await supabase
      .from("projects")
      .select("channel_analysis")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .single();

    if (error || !project?.channel_analysis) {
      return NextResponse.json({ error: "No channel analysis found for this project" }, { status: 400 });
    }

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [{
        name: "save_video_ideas",
        description: "Save the generated video ideas",
        input_schema: videoIdeasInputSchema,
      }],
      tool_choice: { type: "tool", name: "save_video_ideas" },
      messages: [{ role: "user", content: buildVideoIdeasPrompt(project.channel_analysis, "") }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error("No ideas returned from Claude");

    const parsed = VideoIdeasSchema.parse(toolUse.input);
    return NextResponse.json({ ideas: parsed.ideas });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate ideas";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
