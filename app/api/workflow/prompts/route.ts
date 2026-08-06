import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { requireActiveSubscription } from "@/lib/subscription";
import { resolveModelForUser } from "@/lib/claude/models";
import type { WorkflowStep } from "@/lib/claude/routing";
import { supabase } from "@/lib/supabase/client";
import { sseStream, generateBeats, fillPrompts, generateImages, generateVideos, generateThumbnails } from "@/lib/workflow/prompts-core";
import { PROMPTS_THREE_STEP } from "@/lib/feature-flags";
import type { VisualProfileOutput, ThumbnailAnalysisOutput } from "@/lib/claude/schemas";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const expired = requireActiveSubscription(user);
  if (expired) return expired;

  const body = await req.json() as {
    step: "beats" | "fill" | "images" | "videos" | "thumbnails";
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
    step === "images" || step === "beats" || step === "fill" ? "image_prompts" : step === "videos" ? "video_prompts" : "thumbnails";
  const model = (await resolveModelForUser(user.id, routingStep, user)).model;

  // Style resolution shared by every step whose output depends on it. Prefer
  // the request body — the client sends the currently-active tab so an
  // in-session switch is honoured even before the PATCH that persists it
  // settles — and fall back to the project row so a reload before generation
  // still uses the persisted style.
  async function resolvePromptStyle(): Promise<"general" | "cinematic"> {
    const bodyStyle = (body as { promptStyle?: unknown }).promptStyle;
    if (bodyStyle === "cinematic") return "cinematic";
    if (bodyStyle === "general") return "general";
    const { data: proj } = await supabase
      .from("projects")
      .select("prompt_style")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .single();
    return (proj?.prompt_style as string | null) === "cinematic" ? "cinematic" : "general";
  }

  if (step === "beats") {
    // Gated: with the flag off the client's Image Prompts button still runs
    // the combined pass, and that pass DELETES beats whose image_prompt is
    // null — exactly the rows this step creates. So a beats run behind the
    // flag would be wiped by the very next step the user can reach.
    if (!PROMPTS_THREE_STEP) {
      return NextResponse.json({ error: "Three-step prompts flow is not enabled" }, { status: 400 });
    }
    if (!body.script) {
      return NextResponse.json({ error: "script is required" }, { status: 400 });
    }
    // promptStyle decides beat DENSITY here, not just prompt wording, so
    // segmentation has to agree with whatever the fill pass will later use.
    return sseStream(async (send) =>
      generateBeats(projectId, user.id, body.script!, send, model, await resolvePromptStyle())
    );
  }

  if (step === "fill") {
    // Step 2 of the three-step flow: prompts onto beats that already exist.
    // Flag-gated alongside "beats" — with the flag off there are no
    // prompt-less beats to fill, because segmentation and prompts arrive
    // together.
    if (!PROMPTS_THREE_STEP) {
      return NextResponse.json({ error: "Three-step prompts flow is not enabled" }, { status: 400 });
    }
    // No script needed: the beats' own segments are the input, which is what
    // makes a merge survive this step.
    if (!body.visualProfile) {
      return NextResponse.json({ error: "visualProfile is required" }, { status: 400 });
    }
    return sseStream(async (send) =>
      fillPrompts(projectId, user.id, body.visualProfile!, send, model, await resolvePromptStyle())
    );
  }

  if (step === "images") {
    if (!body.script || !body.visualProfile) {
      return NextResponse.json({ error: "script and visualProfile are required" }, { status: 400 });
    }
    return sseStream(async (send) =>
      generateImages(projectId, user.id, body.script!, body.visualProfile!, send, model, await resolvePromptStyle())
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

