import { NextResponse } from "next/server";
import { getAnthropicClient, SYSTEM_PROMPT } from "@/lib/claude/client";
import { resolveDefaultModel } from "@/lib/claude/models";
import { videoIdeasInputSchema } from "@/lib/claude/anthropicSchemas";
import { buildVideoIdeasPrompt } from "@/lib/claude/prompts";
import { VideoIdeasSchema } from "@/lib/claude/schemas";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { estimateStepFloor, shortfallResponse } from "@/lib/credits/estimate";
import { logAnthropicCost } from "@/lib/costs";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 800;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  // This step bills the wallet and had no gate at all, not even the one-credit
  // one the other steps carry: idea generation could run on a balance of zero and be
  // written off. Priced on what the step has historically cost, since a token
  // count does not exist before the call.
  const short = shortfallResponse(await estimateStepFloor({ userId: user.id, step: "topic" }));
  if (short) return short;

  try {
    const { client: anthropic, routing, takeLastCreditsConsumed } = await getAnthropicClient(user.id, "ideas");
    const { projectId } = await req.json() as { projectId: string };
    const modelParams = await resolveDefaultModel("ideas", user.id);
    const model = modelParams.model;

    const { data: project, error } = await supabase
      .from("projects")
      .select("channel_analysis, channel_info, video_ideas")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .single();

    if (error || !project?.channel_analysis) {
      return NextResponse.json({ error: "No channel analysis found for this project" }, { status: 400 });
    }

    // Top-performing titles from the channel feed the prompt as style
    // reference. They live on channel_info.topVideos (persisted at the
    // analyze step). Missing/empty just skips the reference block —
    // not fatal, the prompt still works on analysis alone.
    const topVideos = (project.channel_info as { topVideos?: Array<{ title?: string }> } | null)?.topVideos ?? [];
    const topTitles = topVideos.map((v) => (v.title ?? "").trim()).filter(Boolean);

    // Existing ideas the user has already accumulated. Passed as an
    // exclusion list so a "Generate More Ideas" click produces fresh
    // titles instead of regenerating near-duplicates of what's
    // already on the page.
    const existingIdeas: string[] = Array.isArray(project.video_ideas) ? project.video_ideas as string[] : [];

    const response = await anthropic.messages.create({
      ...modelParams,
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [{
        name: "save_video_ideas",
        description: "Save the generated video ideas",
        input_schema: videoIdeasInputSchema,
      }],
      tool_choice: { type: "tool", name: "save_video_ideas" },
      messages: [{ role: "user", content: buildVideoIdeasPrompt(project.channel_analysis, undefined, topTitles, existingIdeas) }],
    });

    void logAnthropicCost({
      projectId,
      userId: user.id,
      step: "topic",
      model,
      routing,
      usage: response.usage,
      kieCreditsConsumed: takeLastCreditsConsumed(),
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error("No ideas returned from Claude");

    const parsed = VideoIdeasSchema.parse(toolUse.input);

    // Persist the new ideas by appending to video_ideas, deduped
    // case-insensitively so a near-duplicate Claude slipped through
    // doesn't show up twice. Existing ideas keep their order
    // (familiar position), new ones land at the end. This is what
    // makes "Generate More Ideas" survive a refresh — without this
    // write the client's local extraIdeas state was the only copy.
    const seen = new Set(existingIdeas.map((t) => t.toLowerCase().trim()));
    const fresh = parsed.ideas.filter((t) => {
      const k = t.toLowerCase().trim();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const combined = [...existingIdeas, ...fresh];

    const { error: updateError } = await supabase
      .from("projects")
      .update({ video_ideas: combined })
      .eq("id", projectId)
      .eq("user_id", user.id);
    if (updateError) {
      console.warn("[ideas] failed to persist appended ideas:", updateError.message);
      // Non-fatal — return the fresh ideas so the UI can still show
      // them in this session even if persistence failed.
    }

    return NextResponse.json({ ideas: fresh, allIdeas: combined });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate ideas";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
