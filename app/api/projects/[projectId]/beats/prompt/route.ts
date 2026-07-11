export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Save a single beat's image or video prompt text — WITHOUT triggering
// a media regeneration. The prompts step lets the user tweak the copy
// in place; the actual re-render happens later on the generate step
// (which reads the persisted prompt from the DB). This is the only
// route that writes image_prompt / video_prompt on its own; every other
// write is entangled with a regenerate (see app/api/generate/*).
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
  if (field !== "image" && field !== "video") {
    return NextResponse.json({ error: 'field must be "image" or "video"' }, { status: 400 });
  }
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return NextResponse.json({ error: "Prompt cannot be empty" }, { status: 400 });
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

  const column = field === "image" ? "image_prompt" : "video_prompt";
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
