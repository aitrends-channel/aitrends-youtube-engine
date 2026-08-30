export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// The transition at one cut, or at all of them.
//
// Three shapes, because they are three different intentions:
//   { beatNumber, transition }  one cut
//   { applyAll: "dissolve" }    every cut the same, overrides cleared
//   { randomize: true }         a different one per cut, written down
//
// Randomize resolves here rather than at render time on purpose. A video that
// shuffled itself on every assembly would come back different each time it was
// re-rendered, and nobody could keep a cut they liked.

const TRANSITIONS = ["none", "dissolve", "fade-black", "fade-white", "fade-grays",
  "slide-left", "slide-up", "wipe-right", "wipe-up", "wipe-diagonal", "smooth-right",
  "circle-open", "circle-close", "zoom", "pixelize", "blur", "grain"];

/** What randomize draws from: the ones that read as an edit rather than as a
 *  glitch when they land on a cut nobody chose them for. */
const SHUFFLE_POOL = ["dissolve", "fade-black", "slide-left", "slide-up",
  "wipe-right", "wipe-up", "smooth-right", "circle-open", "zoom"];

export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  let body: { beatNumber?: unknown; transition?: unknown; applyAll?: unknown; randomize?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  // Ownership gate: beat rows are keyed by project alone, so this is what stops
  // one account editing another's video.
  const { data: project, error: projErr } = await supabase
    .from("projects").select("id").eq("id", projectId).eq("user_id", user.id).maybeSingle();
  if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  if (body.randomize) {
    const { data: beats, error: readErr } = await supabase
      .from("project_beats").select("beat_number").eq("project_id", projectId).order("beat_number");
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    const rows = beats ?? [];
    // The last beat has no cut after it, so it keeps whatever it had.
    for (let i = 0; i < rows.length - 1; i++) {
      const pick = SHUFFLE_POOL[Math.floor(Math.random() * SHUFFLE_POOL.length)];
      const { error } = await supabase
        .from("project_beats").update({ transition: pick })
        .eq("project_id", projectId).eq("beat_number", rows[i].beat_number);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, randomized: Math.max(0, rows.length - 1) });
  }

  if (typeof body.applyAll === "string") {
    if (!TRANSITIONS.includes(body.applyAll)) {
      return NextResponse.json({ error: `transition must be one of: ${TRANSITIONS.join(", ")}` }, { status: 400 });
    }
    // The project setting carries it, and every per-cut override is cleared so
    // "all" means all rather than "all except the ones you forgot about".
    const { error: beatErr } = await supabase
      .from("project_beats").update({ transition: null }).eq("project_id", projectId);
    if (beatErr) return NextResponse.json({ error: beatErr.message }, { status: 500 });
    const { error: projUpdErr } = await supabase
      .from("projects").update({ transition: body.applyAll }).eq("id", projectId).eq("user_id", user.id);
    if (projUpdErr) return NextResponse.json({ error: projUpdErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, applied: body.applyAll });
  }

  const beatNumber = body.beatNumber;
  if (typeof beatNumber !== "number" || !Number.isInteger(beatNumber)) {
    return NextResponse.json({ error: "beatNumber (integer) is required" }, { status: 400 });
  }
  const raw = body.transition;
  const value = raw === null || raw === ""
    ? null
    : typeof raw === "string" && TRANSITIONS.includes(raw) ? raw : undefined;
  if (value === undefined) {
    return NextResponse.json({ error: `transition must be null or one of: ${TRANSITIONS.join(", ")}` }, { status: 400 });
  }

  const { error } = await supabase
    .from("project_beats").update({ transition: value })
    .eq("project_id", projectId).eq("beat_number", beatNumber);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, beatNumber, transition: value });
}
