export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// A shape over one beat, or over all of them.
//
//   { beatNumber, element, x, y, size }   one beat
//   { applyAll: "star" | null }           every beat, or none
//
// Position and size are fractions of the frame, like the channel logo, so the
// same numbers mean the same thing at any resolution.

/** Must stay in step with the column's check constraint and the files the
 *  worker ships in assets/elements. */
const ELEMENTS = ["subscribe", "subscribed", "like", "share", "follow", "comment", "new", "live"];

const DEFAULTS = { x: 0.7, y: 0.1, size: 0.18 };

export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  let body: { beatNumber?: unknown; element?: unknown; x?: unknown; y?: unknown; size?: unknown; applyAll?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  // Ownership first: beat rows are keyed by project alone, so this is what
  // stops one account editing another's video.
  const { data: project, error: projErr } = await supabase
    .from("projects").select("id").eq("id", projectId).eq("user_id", user.id).maybeSingle();
  if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const fraction = (v: unknown, max: number, fallback: number): number =>
    typeof v === "number" && v >= 0 && v <= max ? v : fallback;

  if ("applyAll" in body) {
    const all = body.applyAll;
    const value = all === null ? null : typeof all === "string" && ELEMENTS.includes(all) ? all : undefined;
    if (value === undefined) {
      return NextResponse.json({ error: `applyAll must be null or one of: ${ELEMENTS.join(", ")}` }, { status: 400 });
    }
    const { error } = await supabase
      .from("project_beats")
      .update(value === null
        ? { element: null, element_x: null, element_y: null, element_size: null }
        : {
            element: value,
            element_x: fraction(body.x, 1, DEFAULTS.x),
            element_y: fraction(body.y, 1, DEFAULTS.y),
            element_size: fraction(body.size, 0.8, DEFAULTS.size),
          })
      .eq("project_id", projectId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, applied: value });
  }

  const beatNumber = body.beatNumber;
  if (typeof beatNumber !== "number" || !Number.isInteger(beatNumber)) {
    return NextResponse.json({ error: "beatNumber (integer) is required" }, { status: 400 });
  }

  const raw = body.element;
  const element = raw === null || raw === ""
    ? null
    : typeof raw === "string" && ELEMENTS.includes(raw) ? raw : undefined;
  if (element === undefined) {
    return NextResponse.json({ error: `element must be null or one of: ${ELEMENTS.join(", ")}` }, { status: 400 });
  }

  // Clearing the element clears its placement: those numbers describe it, and
  // leaving them behind would put the next one wherever the last one sat.
  const patch = element === null
    ? { element: null, element_x: null, element_y: null, element_size: null }
    : {
        element,
        ...(body.x !== undefined ? { element_x: fraction(body.x, 1, DEFAULTS.x) } : {}),
        ...(body.y !== undefined ? { element_y: fraction(body.y, 1, DEFAULTS.y) } : {}),
        ...(body.size !== undefined ? { element_size: fraction(body.size, 0.8, DEFAULTS.size) } : {}),
      };

  const { error } = await supabase
    .from("project_beats").update(patch)
    .eq("project_id", projectId).eq("beat_number", beatNumber);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, beatNumber, element });
}
