import { NextResponse } from "next/server";
import { getAnthropicClient, SYSTEM_PROMPT } from "@/lib/claude/client";
import { resolveDefaultModel } from "@/lib/claude/models";
import { logSystemEvent } from "@/lib/system-logger";

export const maxDuration = 800;
import { channelAnalysisInputSchema, videoIdeasInputSchema } from "@/lib/claude/anthropicSchemas";
import { buildAnalysisPrompt, buildVideoIdeasPrompt } from "@/lib/claude/prompts";
import { ChannelAnalysisSchema, VideoIdeasSchema } from "@/lib/claude/schemas";
import { extractToolInputFromText } from "@/lib/claude/textFallback";
import { retryClaudeCall } from "@/lib/claude/retry";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { estimateStepFloor, shortfallResponse } from "@/lib/credits/estimate";
import { logAnthropicCost, logProjectCost } from "@/lib/costs";
import type { ChannelAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  // This step bills the wallet and had no gate at all, not even the one-credit
  // one the other steps carry: channel analysis could run on a balance of zero and be
  // written off. Priced on what the step has historically cost, since a token
  // count does not exist before the call.
  const short = shortfallResponse(await estimateStepFloor({ userId: user.id, step: "channel_analysis" }));
  if (short) return short;

  try {
    const { client: anthropic, routing, takeLastCreditsConsumed } = await getAnthropicClient(user.id, "analyze");
    const { projectId, transcripts, topicMode, topicHint } = await req.json();
    const modelParams = await resolveDefaultModel("analyze", user.id);
    const model = modelParams.model;

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
          ...modelParams,
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

      // Log cost for the ledger. Fail-soft inside logAnthropicCost —
      // never throws. Fires per attempt so retries count too (each
      // retry was billed). Routes to kie_credits when going through
      // KIE; claude_tokens_* otherwise.
      void logAnthropicCost({
        projectId,
        userId: user.id,
        step: "channel_analysis",
        model,
        routing,
        usage: analysisResponse.usage,
        kieCreditsConsumed: takeLastCreditsConsumed(),
      });
      // Supadata transcripts that fed this call — each one was a
      // billable fetch upstream of analysis. transcripts[].success is
      // true for the ones Supadata actually returned text for.
      const successfulTranscripts = (transcripts as Array<{ success?: boolean }>)
        .filter((t) => t?.success !== false).length;
      if (attempt === 1 && successfulTranscripts > 0) {
        void logProjectCost({
          projectId,
          userId: user.id,
          step: "channel_analysis",
          provider: "supadata",
          model: "supadata",
          units: successfulTranscripts,
          unitKind: "supadata_transcripts",
        });
      }

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
        ...modelParams,
        max_tokens: 2048,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [{
          name: "save_video_ideas",
          description: "Save the generated video ideas",
          input_schema: videoIdeasInputSchema,
        }],
        tool_choice: { type: "tool", name: "save_video_ideas" },
        messages: [{ role: "user", content: buildVideoIdeasPrompt(
          analysis,
          topicHint,
          // Top-performing titles from the channel — the same transcripts
          // we just analyzed. They land in the prompt as STYLE reference
          // (capitalization rhythm, punctuation tics, hook syntax) so
          // generated titles feel native to this specific channel. Use
          // transcripts here instead of channel_info.topVideos to avoid
          // an extra DB read; the set is the same minus any transcript
          // fetches that failed (acceptable — a few fewer references
          // is fine, the analysis prose still anchors the style).
          (transcripts as Array<{ title?: string }>)
            .map((t) => (t.title ?? "").trim())
            .filter(Boolean),
        ) }],
      })
      );

      void logAnthropicCost({
        projectId,
        userId: user.id,
        step: "topic",
        model,
        routing,
        usage: ideasResponse.usage,
        kieCreditsConsumed: takeLastCreditsConsumed(),
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
