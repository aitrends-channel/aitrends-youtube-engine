import { NextResponse } from "next/server";
import { getAnthropicClient, MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import { logSystemEvent } from "@/lib/system-logger";

export const maxDuration = 800;
import { channelAnalysisInputSchema, videoIdeasInputSchema } from "@/lib/claude/anthropicSchemas";
import { buildAnalysisPrompt, buildVideoIdeasPrompt } from "@/lib/claude/prompts";
import { ChannelAnalysisSchema, VideoIdeasSchema } from "@/lib/claude/schemas";
import { extractToolInputFromText } from "@/lib/claude/textFallback";
import { retryClaudeCall } from "@/lib/claude/retry";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { ChannelAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const anthropic = await getAnthropicClient(user.id, "analyze");
    const { projectId, transcripts, topicMode, topicHint } = await req.json();
    const model = MODEL;

    if (!transcripts?.length) {
      return NextResponse.json({ error: "Video transcripts are required" }, { status: 400 });
    }

    // KIE+Opus occasionally returns an empty or differently-shaped tool
    // input that fails our schema (every field "Invalid input"). The
    // inner retryClaudeCall only handles transient transport errors —
    // it doesn't re-roll on a successful-but-malformed response. Loop
    // up to MAX_ATTEMPTS times around the whole call + parse so a
    // single bad sample doesn't sink the analysis. Each iteration
    // still benefits from retryClaudeCall's own retries underneath.
    const MAX_ATTEMPTS = 3;
    let analysis: ChannelAnalysisOutput | null = null;
    let lastShapeError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const analysisResponse = await retryClaudeCall(`channel analysis attempt ${attempt}/${MAX_ATTEMPTS}`, () =>
        anthropic.messages.create({
          model: model,
          // 4096 was tight for the full styleDNA nested object plus all
          // top-level required fields — Claude was selectively dropping
          // targetAudience / wordsPerSecond / targetWordCount / styleDNA
          // even on non-truncated responses. 8192 gives plenty of room.
          max_tokens: 8192,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [{
            name: "save_channel_analysis",
            description: "Save the structured channel analysis results",
            input_schema: channelAnalysisInputSchema,
          }],
          tool_choice: { type: "tool", name: "save_channel_analysis" },
          messages: [{ role: "user", content: buildAnalysisPrompt(transcripts) }],
        })
      );

      const analysisToolUse = analysisResponse.content?.find((b) => b.type === "tool_use");
      let analysisInput: unknown = null;
      if (analysisToolUse && analysisToolUse.type === "tool_use") {
        analysisInput = analysisToolUse.input;
      } else {
        // KIE+Opus sometimes ignores tool_choice and emits the structured
        // payload as text. Recover it before giving up on this attempt.
        const textBlock = analysisResponse.content?.find((b) => b.type === "text");
        const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
        console.log(`[analyze] attempt ${attempt} fallback parsing text len=${raw.length} head=${raw.slice(0, 200)}`);
        analysisInput = extractToolInputFromText(raw);
      }

      if (!analysisInput) {
        lastShapeError = new Error("No structured analysis returned");
        console.warn(`[analyze] attempt ${attempt}/${MAX_ATTEMPTS} returned no input; will retry`);
        continue;
      }

      const parsedAnalysis = ChannelAnalysisSchema.safeParse(analysisInput);
      if (parsedAnalysis.success) {
        analysis = parsedAnalysis.data as ChannelAnalysisOutput;
        break;
      }

      const root = analysisInput as Record<string, unknown>;
      const styleDNA = root?.styleDNA;
      console.warn(`[analyze] attempt ${attempt}/${MAX_ATTEMPTS} schema validation failed`, {
        topLevelKeys: Object.keys(root ?? {}),
        styleDNAType: styleDNA === null ? "null" : Array.isArray(styleDNA) ? "array" : typeof styleDNA,
        styleDNAPreview:
          typeof styleDNA === "string"
            ? styleDNA.slice(0, 500)
            : styleDNA && typeof styleDNA === "object"
              ? JSON.stringify(styleDNA).slice(0, 500)
              : String(styleDNA),
        zodIssueCount: parsedAnalysis.error.issues.length,
      });
      lastShapeError = parsedAnalysis.error;
    }

    if (!analysis) {
      // All attempts exhausted — surface a friendly message; humanize on
      // the client falls through to "Try again — this is often
      // transient" which now actually means "we already retried 3
      // times, so retrying might not help; consider regenerating".
      throw lastShapeError ?? new Error("Channel analysis returned unexpected shape after retries");
    }

    let videoIdeas: string[] | undefined;

    if (topicMode === "generate") {
      const ideasResponse = await retryClaudeCall("video ideas", () =>
        anthropic.messages.create({
        model: model,
        max_tokens: 2048,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [{
          name: "save_video_ideas",
          description: "Save the generated video ideas",
          input_schema: videoIdeasInputSchema,
        }],
        tool_choice: { type: "tool", name: "save_video_ideas" },
        messages: [{ role: "user", content: buildVideoIdeasPrompt(analysis, topicHint) }],
      })
      );

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
