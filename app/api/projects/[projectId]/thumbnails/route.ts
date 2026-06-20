export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function GET(
  _req: Request,
  { params }: { params: { projectId: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  // Verify project ownership
  const { error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .single();

  if (projectError) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("project_thumbnails")
    .select("*")
    .eq("project_id", projectId)
    .order("position");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    (data ?? []).map((t) => ({
      position: t.position,
      title: t.title,
      visualConcept: t.visual_concept,
      textOverlay: t.text_overlay,
      emotionTrigger: t.emotion_trigger,
      stylePrompt: t.style_prompt,
      imageUrl: t.image_url,
      imageStatus: t.image_status,
    }))
  );
}

// Update a single thumbnail's editable fields. Used by the Edit modal
// on the thumbnails page so the user can tweak the title, visual
// concept, overlay text, emotion trigger, or — most importantly — the
// stylePrompt that feeds image generation, then optionally regenerate
// from the new prompt.
//
// Body shape: { position: number, fields: { title?, visualConcept?,
//   textOverlay?, emotionTrigger?, stylePrompt? } }
//
// Only whitelisted keys are passed through to Supabase — anything else
// in the body is silently dropped to keep server-controlled fields
// (image_url, image_status, position) safe from client overwrite.
export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  let body: {
    position?: number;
    fields?: {
      title?: string;
      visualConcept?: string;
      textOverlay?: string;
      emotionTrigger?: string;
      stylePrompt?: string;
    };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.position !== "number" || !Number.isInteger(body.position)) {
    return NextResponse.json({ error: "position (integer) is required" }, { status: 400 });
  }
  if (!body.fields || typeof body.fields !== "object") {
    return NextResponse.json({ error: "fields object is required" }, { status: 400 });
  }

  // Project ownership check — joining on user_id below would also work
  // but a separate read gives a clean 404 vs the silent no-op an
  // ownership-mismatched UPDATE would otherwise produce.
  const { error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .single();
  if (projectError) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Map camelCase API → snake_case columns. Only set keys the client
  // actually sent; sending an empty patch returns the current row
  // unchanged rather than nulling everything.
  const update: Record<string, string> = {};
  if (typeof body.fields.title === "string") update.title = body.fields.title;
  if (typeof body.fields.visualConcept === "string") update.visual_concept = body.fields.visualConcept;
  if (typeof body.fields.textOverlay === "string") update.text_overlay = body.fields.textOverlay;
  if (typeof body.fields.emotionTrigger === "string") update.emotion_trigger = body.fields.emotionTrigger;
  if (typeof body.fields.stylePrompt === "string") update.style_prompt = body.fields.stylePrompt;

  if (!Object.keys(update).length) {
    return NextResponse.json({ error: "No editable fields supplied" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("project_thumbnails")
    .update(update)
    .eq("project_id", projectId)
    .eq("position", body.position)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Thumbnail not found at that position" }, { status: 404 });

  return NextResponse.json({
    position: data.position,
    title: data.title,
    visualConcept: data.visual_concept,
    textOverlay: data.text_overlay,
    emotionTrigger: data.emotion_trigger,
    stylePrompt: data.style_prompt,
    imageUrl: data.image_url,
    imageStatus: data.image_status,
  });
}
