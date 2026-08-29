export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Set, or clear, one beat's image effect.
//
// The project's setting is the default and this is the exception: nobody picks
// an effect for two hundred beats, but they will for the three that matter — a
// title card that should hold still, a hero shot that should push in.
//
// Null clears the override and the beat follows the project again. That is a
// real choice rather than an absence, which is why it is a value this route
// accepts rather than something the client has to express by omission.
//
// Only touches still beats' behaviour: a beat with a generated clip ignores
// this entirely, since there is nothing to move.

/** Must stay in step with the column's check constraint and with ImageMotion
 *  in the worker. A value that passes here and fails there would surface as a
 *  clip that quietly rendered without the effect. */
const MOTIONS = ["none", "zoom-in", "zoom-out", "pan-right", "pan-left", "drift", "auto", "random"];

export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  let body: { beatNumber?: unknown; motion?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const beatNumber = body.beatNumber;
  if (typeof beatNumber !== "number" || !Number.isInteger(beatNumber)) {
    return NextResponse.json({ error: "beatNumber (integer) is required" }, { status: 400 });
  }

  // null and "inherit" both mean "follow the project". Two spellings because
  // a select's empty option gives one and a clear button gives the other.
  const raw = body.motion;
  const motion = raw === null || raw === "inherit" || raw === ""
    ? null
    : typeof raw === "string" && MOTIONS.includes(raw)
      ? raw
      : undefined;
  if (motion === undefined) {
    return NextResponse.json(
      { error: `motion must be null or one of: ${MOTIONS.join(", ")}` },
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
    .update({ image_motion: motion })
    .eq("project_id", projectId)
    .eq("beat_number", beatNumber);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, beatNumber, motion });
}
