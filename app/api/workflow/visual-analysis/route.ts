import { NextResponse } from "next/server";
import { getAnthropicClient, VISION_MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import { resolveAnthropicModel } from "@/lib/claude/modelOverride";

export const maxDuration = 800;
import { visualProfileInputSchema } from "@/lib/claude/anthropicSchemas";
import { buildVisualAnalysisPrompt } from "@/lib/claude/prompts";
import { VisualProfileSchema, ThumbnailAnalysisSchema } from "@/lib/claude/schemas";
import { retryClaudeCall } from "@/lib/claude/retry";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const anthropic = await getAnthropicClient(user.id);
    const { projectId, videoImageUrls, thumbnailImageUrls, model: requestedModel } = await req.json() as {
      projectId: string;
      videoImageUrls?: string[];
      thumbnailImageUrls?: string[];
      model?: string;
    };
    const model = resolveAnthropicModel(user, requestedModel, VISION_MODEL);

    const hasVideo = !!videoImageUrls?.length;
    const hasThumbnails = !!thumbnailImageUrls?.length;
    if (!hasVideo && !hasThumbnails) {
      return NextResponse.json({ error: "At least one image URL is required" }, { status: 400 });
    }

    const MAX_VIDEO_IMAGES = 10;
    const cappedVideoImages = hasVideo ? (videoImageUrls as string[]).slice(0, MAX_VIDEO_IMAGES) : [];

    const imageBlocks = [
      ...cappedVideoImages.map((url) => ({
        type: "image" as const,
        source: { type: "url" as const, url },
      })),
      ...(hasThumbnails
        ? (thumbnailImageUrls as string[]).map((url) => ({
            type: "image" as const,
            source: { type: "url" as const, url },
          }))
        : []),
    ];

    // Build the combined schema dynamically — only ask Claude for the
    // pieces of analysis we have inputs for. The thumbnails step calls
    // with thumbnail images only, in which case we just produce
    // thumbnail_analysis and leave visual_profile alone.
    const visualProperty = visualProfileInputSchema.properties.visualProfile;
    const thumbnailProperty = "thumbnailAnalysis" in visualProfileInputSchema.properties
      ? (visualProfileInputSchema.properties as Record<string, unknown>).thumbnailAnalysis
      : null;

    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    if (hasVideo) {
      properties.visualProfile = visualProperty;
      required.push("visualProfile");
    }
    if (hasThumbnails && thumbnailProperty) {
      properties.thumbnailAnalysis = thumbnailProperty;
      required.push("thumbnailAnalysis");
    }

    const combinedSchema = {
      type: "object" as const,
      properties,
      required,
    };

    const response = await retryClaudeCall("visual analysis", () =>
      anthropic.messages.create({
        model: model,
        max_tokens: 2048,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [{
          name: "save_visual_analysis",
          description: "Save the extracted visual style profile",
          input_schema: combinedSchema,
        }],
        tool_choice: { type: "tool", name: "save_visual_analysis" },
        messages: [{
          role: "user",
          content: [
            ...imageBlocks,
            { type: "text", text: buildVisualAnalysisPrompt({ video: hasVideo, thumbnails: hasThumbnails }) },
          ],
        }],
      })
    );

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error("No visual analysis returned");

    const result = toolUse.input as { visualProfile?: unknown; thumbnailAnalysis?: unknown; [k: string]: unknown };

    // Pick the visualProfile from whichever shape the model returned.
    // Haiku (the vision model) sometimes:
    //   1. Wraps as { visualProfile: {...} } — happy path
    //   2. Returns the fields flat at the root — fallback to result
    //   3. Returns something else entirely (rare; logs help diagnose)
    function pickVisualProfile(): Record<string, unknown> | null {
      if (result.visualProfile && typeof result.visualProfile === "object") {
        return result.visualProfile as Record<string, unknown>;
      }
      // Flat shape — only treat the root as a visualProfile if it
      // actually has the signature fields.
      if (typeof result.artStyle === "string" && Array.isArray(result.colorPalette)) {
        return result as Record<string, unknown>;
      }
      return null;
    }

    function pickThumbnailAnalysis(): Record<string, unknown> | null {
      if (result.thumbnailAnalysis && typeof result.thumbnailAnalysis === "object") {
        return result.thumbnailAnalysis as Record<string, unknown>;
      }
      // Flat shape — only if signature fields are present and we
      // weren't also expecting a visualProfile (which would have its
      // own shape and could collide).
      if (!hasVideo && typeof result.textStyle === "string" && typeof result.composition === "string") {
        return result as Record<string, unknown>;
      }
      return null;
    }

    let visualProfileRaw: Record<string, unknown> | null = null;
    let thumbnailRaw: Record<string, unknown> | null = null;

    if (hasVideo) {
      visualProfileRaw = pickVisualProfile();
      if (!visualProfileRaw) {
        const keys = Object.keys(result).join(", ") || "(empty)";
        console.warn(`[visual-analysis] unexpected tool input keys=${keys}`);
        throw new Error(`Visual analysis returned an unrecognized shape (keys: ${keys}). Retry.`);
      }
    }
    if (hasThumbnails) {
      thumbnailRaw = pickThumbnailAnalysis();
      if (!thumbnailRaw && !hasVideo) {
        const keys = Object.keys(result).join(", ") || "(empty)";
        console.warn(`[visual-analysis] unexpected tool input keys=${keys}`);
        throw new Error(`Thumbnail analysis returned an unrecognized shape (keys: ${keys}). Retry.`);
      }
    }

    const visualProfile = visualProfileRaw ? VisualProfileSchema.parse(visualProfileRaw) : null;
    const thumbnailAnalysis = thumbnailRaw ? ThumbnailAnalysisSchema.parse(thumbnailRaw) : null;

    // Only update DB fields we actually analyzed — don't clobber
    // previously-stored values for the other axis.
    const updates: Record<string, unknown> = {};
    if (visualProfile) updates.visual_profile = visualProfile;
    if (thumbnailAnalysis) updates.thumbnail_analysis = thumbnailAnalysis;
    // current_state bump only on the visual-style branch (the original
    // step-9 gate). Thumbnail-only calls don't advance the workflow.
    if (hasVideo) updates.current_state = 9;

    if (Object.keys(updates).length > 0) {
      await supabase.from("projects").update(updates).eq("id", projectId).eq("user_id", user.id);
    }

    return NextResponse.json({ visualProfile, thumbnailAnalysis });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Visual analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
