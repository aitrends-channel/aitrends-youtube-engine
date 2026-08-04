import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { requireActiveSubscription } from "@/lib/subscription";
import { resolveModelForUser } from "@/lib/claude/models";
import type { WorkflowStep } from "@/lib/claude/routing";
import { supabase } from "@/lib/supabase/client";
import { sseStream, generateImages, generateVideos, generateThumbnails } from "@/lib/workflow/prompts-core";
import type { VisualProfileOutput, ThumbnailAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const expired = requireActiveSubscription(user);
  if (expired) return expired;

  const body = await req.json() as {
    step: "images" | "videos" | "thumbnails";
    projectId: string;
    script?: string;
    visualProfile?: VisualProfileOutput;
    thumbnailAnalysis?: ThumbnailAnalysisOutput;
  };

  const { step, projectId } = body;
  if (!projectId || !step) {
    return NextResponse.json({ error: "projectId and step are required" }, { status: 400 });
  }
  // These steps honour a Pro user's own model pick (Setup → Claude model),
  // falling back to the admin default — resolveModelForUser owns that whole
  // decision, including the client_kie-only rule.
  //
  // The default is an Opus tier, which is why the image step's per-chunk
  // max_tokens headroom and the truncation-split recovery in generateImages
  // (lib/workflow/prompts-core.ts) exist: Opus intermittently emits the
  // verbose <tool_calls> text fallback that overruns the ceiling. A user on
  // Haiku sees that fallback largely disappear — the recovery path just goes
  // unused, so the sizing is safe either way.
  const routingStep: WorkflowStep =
    step === "images" ? "image_prompts" : step === "videos" ? "video_prompts" : "thumbnails";
  const model = (await resolveModelForUser(user.id, routingStep, user)).model;

  if (step === "images") {
    if (!body.script || !body.visualProfile) {
      return NextResponse.json({ error: "script and visualProfile are required" }, { status: 400 });
    }
    // Prefer the request body — the client sends the currently-active
    // tab so an in-session switch is honoured even before the PATCH
    // that persists it settles. Fall back to the project row so a
    // reload before generation still uses the persisted style.
    const bodyStyle = (body as { promptStyle?: unknown }).promptStyle;
    let promptStyle: "general" | "cinematic" =
      bodyStyle === "cinematic" ? "cinematic" : bodyStyle === "general" ? "general" : "general";
    if (bodyStyle === undefined) {
      const { data: proj } = await supabase
        .from("projects")
        .select("prompt_style")
        .eq("id", projectId)
        .eq("user_id", user.id)
        .single();
      if ((proj?.prompt_style as string | null) === "cinematic") promptStyle = "cinematic";
    }
    return sseStream((send) =>
      generateImages(projectId, user.id, body.script!, body.visualProfile!, send, model, promptStyle)
    );
  }

  if (step === "videos") {
    return sseStream((send) => generateVideos(projectId, user.id, send, model));
  }

  if (step === "thumbnails") {
    if (!body.script || !body.visualProfile) {
      return NextResponse.json({ error: "script and visualProfile are required" }, { status: 400 });
    }
    return sseStream((send) =>
      generateThumbnails(projectId, user.id, body.script!, body.visualProfile!, body.thumbnailAnalysis, send, model)
    );
  }

  return NextResponse.json({ error: `Unknown step: ${step}` }, { status: 400 });
}

