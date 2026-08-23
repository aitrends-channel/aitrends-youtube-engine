export const dynamic = "force-dynamic";
export const maxDuration = 120;
import { NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, SYSTEM_PROMPT } from "@/lib/claude/client";
import { getVisionConfig } from "@/lib/claude/vision";
import { modelParamsFor } from "@/lib/claude/models";
import { buildPromptsFromImagePrompt } from "@/lib/claude/prompts";
import { retryClaudeCall } from "@/lib/claude/retry";
import { extractToolInputFromText } from "@/lib/claude/textFallback";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { logAnthropicCost } from "@/lib/costs";
import { estimateStepFloor, shortfallResponse } from "@/lib/credits/estimate";
import { holdForStep, settleTokenHold, releaseHold } from "@/lib/credits/hold";
import { OUT_OF_CREDITS_MESSAGE } from "@/lib/heclus-charge";
import type { VisualProfileOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";
import { requireActiveSubscription } from "@/lib/subscription";
import { requireWalletFunds } from "@/lib/heclus-charge";

// Generate a beat's image + video prompts FROM a user-uploaded image
// (Claude vision). Called after a manual image upload so the beat's
// prompts describe the actual picture instead of the stale
// script-derived text. Mirrors the visual-analysis route's vision-call
// pattern (URL image source, forced tool call, text-mode fallback).
const saveSchema = {
  type: "object" as const,
  properties: {
    imagePrompt: { type: "string" as const, description: "A complete, self-contained text-to-image prompt that recreates the attached image." },
    videoPrompt: { type: "string" as const, description: "1–2 sentences of camera movement + action to animate the attached image (image-to-video)." },
  },
  required: ["imagePrompt", "videoPrompt"],
};

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const expired = requireActiveSubscription(user);
  if (expired) return expired;
  // Wallet-funded users pay for this step in credits, so an empty balance is
  // refused before any provider is called.
  const broke = await requireWalletFunds(user);
  if (broke) return broke;
  const short = shortfallResponse(await estimateStepFloor({ userId: user.id, step: "prompts_image" }));
  if (short) return short;
  // Held atomically, so two of these firing at once cannot both spend the same
  // credits. Settled below on the tokens the call actually reports.
  const { hold, refused } = await holdForStep({ userId: user.id, step: "prompts_image", provider: "anthropic" });
  // Released in the finally below if the route never gets as far as settling.
  let settled_hold = false;
  if (refused) {
    return NextResponse.json(
      { error: OUT_OF_CREDITS_MESSAGE, outOfCredits: true },
      { status: 402 },
    );
  }

  try {
    const { projectId, beatNumber, imageUrl } = await req.json().catch(() => ({})) as {
      projectId?: string; beatNumber?: number; imageUrl?: string;
    };
    if (!projectId || typeof beatNumber !== "number" || !imageUrl) {
      return NextResponse.json({ error: "projectId, beatNumber and imageUrl are required" }, { status: 400 });
    }

    const { data: project } = await supabase
      .from("projects")
      .select("id, visual_profile")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .single();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const visualProfile = (project.visual_profile ?? null) as VisualProfileOutput | null;

    // Pinned to Claude even when the image_prompts step is switched to GPT:
    // this call sends an image block and hardcodes a Claude vision model, so
    // the GPT facade would have nothing valid to translate.
    const { client: anthropic, routing, takeLastCreditsConsumed } = await getAnthropicClient(user.id, "image_prompts", { forceProvider: "claude" });
    const model = (await getVisionConfig()).model;

    const callModel = () =>
      anthropic.messages.create({
        ...modelParamsFor(model),
        max_tokens: 1500,
        system: [{ type: "text", text: SYSTEM_PROMPT }],
        tools: [{ name: "save_prompts", description: "Save the image and video prompts derived from the attached image", input_schema: saveSchema }],
        tool_choice: { type: "tool", name: "save_prompts" },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: imageUrl } },
            { type: "text", text: buildPromptsFromImagePrompt(visualProfile) },
          ],
        }],
      });

    // Two attempts (KIE+Opus occasionally emits the JSON as text instead
    // of a tool_use), then a text-mode parse before giving up.
    const spent = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let response!: Anthropic.Messages.Message;
    let toolUse: Anthropic.Messages.ContentBlock | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await retryClaudeCall(`prompts-from-image (try ${attempt + 1})`, callModel);
      void logAnthropicCost({
        projectId, userId: user.id, step: "prompts_image", model, routing,
        usage: response.usage, kieCreditsConsumed: takeLastCreditsConsumed(),
        alreadyHeld: !!hold,
      });
      // Accumulated rather than settled here: this loop can run twice, and a
      // hold settled on the first attempt would leave the second one billed to
      // nothing. One hold, one settle, both attempts' tokens.
      spent.input_tokens += response.usage?.input_tokens ?? 0;
      spent.output_tokens += response.usage?.output_tokens ?? 0;
      spent.cache_read_input_tokens += response.usage?.cache_read_input_tokens ?? 0;
      spent.cache_creation_input_tokens += response.usage?.cache_creation_input_tokens ?? 0;
      toolUse = response.content.find((b) => b.type === "tool_use");
      if (toolUse && toolUse.type === "tool_use") break;
    }
    await settleTokenHold({ hold, model, provider: "anthropic", step: "prompts_image", usage: spent });
    settled_hold = true;

    let result: { imagePrompt?: unknown; videoPrompt?: unknown };
    if (toolUse && toolUse.type === "tool_use") {
      result = toolUse.input as { imagePrompt?: unknown; videoPrompt?: unknown };
    } else {
      const textBlock = response.content.find((b) => b.type === "text");
      const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
      const parsed = extractToolInputFromText(raw);
      if (!parsed) return NextResponse.json({ error: "Could not read prompts from the image — try again." }, { status: 502 });
      result = parsed as { imagePrompt?: unknown; videoPrompt?: unknown };
    }

    const imagePrompt = typeof result.imagePrompt === "string" ? result.imagePrompt.trim() : "";
    const videoPrompt = typeof result.videoPrompt === "string" ? result.videoPrompt.trim() : "";
    if (!imagePrompt && !videoPrompt) {
      return NextResponse.json({ error: "The model returned no prompts. Try again." }, { status: 502 });
    }

    const patch: Record<string, string> = {};
    if (imagePrompt) patch.image_prompt = imagePrompt;
    if (videoPrompt) patch.video_prompt = videoPrompt;
    const { error } = await supabase
      .from("project_beats")
      .update(patch)
      .eq("project_id", projectId)
      .eq("beat_number", beatNumber);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, imagePrompt, videoPrompt });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate prompts from image";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (!settled_hold) await releaseHold(hold, "prompts_image did not complete");
  }
}
