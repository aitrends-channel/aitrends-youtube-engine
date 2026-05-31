import { NextResponse } from "next/server";
import { getAnthropicClient, VISION_MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";

export const maxDuration = 300;
import { visualProfileInputSchema } from "@/lib/claude/anthropicSchemas";
import { buildVisualAnalysisPrompt } from "@/lib/claude/prompts";
import { VisualProfileSchema, ThumbnailAnalysisSchema } from "@/lib/claude/schemas";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const anthropic = await getAnthropicClient(user.id);
    const { projectId, videoImageUrls, thumbnailImageUrls } = await req.json();

    if (!videoImageUrls?.length) {
      return NextResponse.json({ error: "At least one video image URL is required" }, { status: 400 });
    }

    const hasThumbnails = thumbnailImageUrls?.length > 0;

    const imageBlocks = [
      ...videoImageUrls.map((url: string) => ({
        type: "image" as const,
        source: { type: "url" as const, url },
      })),
      ...(hasThumbnails
        ? thumbnailImageUrls.map((url: string) => ({
            type: "image" as const,
            source: { type: "url" as const, url },
          }))
        : []),
    ];

    const combinedSchema = hasThumbnails
      ? visualProfileInputSchema
      : {
          type: "object" as const,
          properties: { visualProfile: visualProfileInputSchema.properties.visualProfile },
          required: ["visualProfile"],
        };

    const response = await anthropic.messages.create({
      model: VISION_MODEL,
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
          { type: "text", text: buildVisualAnalysisPrompt(hasThumbnails) },
        ],
      }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") throw new Error("No visual analysis returned");

    const result = toolUse.input as { visualProfile: unknown; thumbnailAnalysis?: unknown };
    const visualProfile = VisualProfileSchema.parse(result.visualProfile);
    const thumbnailAnalysis = hasThumbnails && result.thumbnailAnalysis
      ? ThumbnailAnalysisSchema.parse(result.thumbnailAnalysis)
      : null;

    await supabase
      .from("projects")
      .update({ visual_profile: visualProfile, thumbnail_analysis: thumbnailAnalysis, current_state: 9 })
      .eq("id", projectId)
      .eq("user_id", user.id);

    return NextResponse.json({ visualProfile, thumbnailAnalysis });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Visual analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
