export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Save a single beat's image prompt, video prompt, or script segment —
// WITHOUT triggering a media regeneration. The prompts step lets the user
// tweak the copy in place; the actual re-render happens later on the generate
// step (which reads the persisted prompt from the DB). This is the only
// route that writes image_prompt / video_prompt on its own; every other
// write is entangled with a regenerate (see app/api/generate/*).
//
// The segment is only editable while the beat has NO image prompt. Everything
// downstream is derived from it — the prompt, the render, the voiceover, the
// timings — so changing it afterwards leaves a prompt describing text that is
// no longer there. That is the same window merging is confined to, and it is
// enforced here rather than only in the UI.
export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  let body: { beatNumber?: number; field?: string; value?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { beatNumber, field, value } = body;

  if (typeof beatNumber !== "number" || !Number.isInteger(beatNumber)) {
    return NextResponse.json({ error: "beatNumber (integer) is required" }, { status: 400 });
  }
  if (field !== "image" && field !== "video" && field !== "segment") {
    return NextResponse.json({ error: 'field must be "image", "video" or "segment"' }, { status: 400 });
  }
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return NextResponse.json(
      { error: field === "segment" ? "Segment cannot be empty" : "Prompt cannot be empty" },
      { status: 400 },
    );
  }

  // Ownership check — the service-role client bypasses RLS, so we
  // verify the project belongs to the caller before touching its beats.
  const { data: project, error: projectErr } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (projectErr) {
    return NextResponse.json({ error: projectErr.message }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // A segment edit is only allowed before anything has been derived from it.
  if (field === "segment") {
    const { data: beat, error: beatErr } = await supabase
      .from("project_beats")
      .select("image_prompt")
      .eq("project_id", projectId)
      .eq("beat_number", beatNumber)
      .maybeSingle();
    if (beatErr) return NextResponse.json({ error: beatErr.message }, { status: 500 });
    if (!beat) return NextResponse.json({ error: `Beat ${beatNumber} not found` }, { status: 404 });
    if ((beat.image_prompt as string | null)?.trim()) {
      return NextResponse.json(
        { error: "This beat already has an image prompt written for its current text. Clear the image prompts to edit the split." },
        { status: 409 },
      );
    }
  }

  const column = field === "image" ? "image_prompt" : field === "video" ? "video_prompt" : "script_segment";
  const { data: updated, error } = await supabase
    .from("project_beats")
    .update({ [column]: trimmed })
    .eq("project_id", projectId)
    .eq("beat_number", beatNumber)
    .select("beat_number");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: `Beat ${beatNumber} not found` }, { status: 404 });
  }

  return NextResponse.json({ ok: true, beatNumber, field });
}
