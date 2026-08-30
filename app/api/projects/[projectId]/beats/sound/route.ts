export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Set, or clear, the sound played at one beat's start.
//
// Null is silence, and it is a value this route accepts rather than something
// the client expresses by omission: turning a sound off is a choice somebody
// makes, not an absence of one.

/** Must stay in step with the column's check constraint and with the files in
 *  the worker's assets/sfx, which scripts/make-sfx.sh generates. */
const SOUNDS = ["whoosh", "swish", "sweep", "click", "pop", "zoom-in", "zoom-out", "riser", "impact", "thud", "chime"];

export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  let body: { beatNumber?: unknown; sound?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const beatNumber = body.beatNumber;
  if (typeof beatNumber !== "number" || !Number.isInteger(beatNumber)) {
    return NextResponse.json({ error: "beatNumber (integer) is required" }, { status: 400 });
  }

  const raw = body.sound;
  const sound = raw === null || raw === ""
    ? null
    : typeof raw === "string" && SOUNDS.includes(raw)
      ? raw
      : undefined;
  if (sound === undefined) {
    return NextResponse.json(
      { error: `sound must be null or one of: ${SOUNDS.join(", ")}` },
      { status: 400 },
    );
  }

  // Ownership gate: beat rows are keyed by project alone, so this is what stops
  // one account editing another's video.
  const { data: project, error: projErr } = await supabase
    .from("projects").select("id").eq("id", projectId).eq("user_id", user.id).maybeSingle();
  if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const { error } = await supabase
    .from("project_beats")
    .update({ sound_effect: sound })
    .eq("project_id", projectId)
    .eq("beat_number", beatNumber);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, beatNumber, sound });
}
