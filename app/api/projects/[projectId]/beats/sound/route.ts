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
const SOUNDS = ["whoosh", "reverse-whoosh", "swish", "sweep", "page",
  "click", "tick", "pop", "beep", "glitch", "shutter",
  "zoom-in", "zoom-out", "riser",
  "impact", "boom", "thud", "heartbeat",
  "chime", "ding", "sparkle"];

export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  let body: { beatNumber?: unknown; sound?: unknown; volume?: unknown; pitch?: unknown; applyAll?: unknown; tuneAll?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  // Ownership gate: beat rows are keyed by project alone, so this is what stops
  // one account editing another's video.
  const { data: project, error: projErr } = await supabase
    .from("projects").select("id").eq("id", projectId).eq("user_id", user.id).maybeSingle();
  if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // { applyAll: "whoosh" } puts one sound at every transition; { applyAll:
  // null } takes them all off. Selecting two hundred beats one at a time is
  // not a workflow, it is a punishment.
  if ("applyAll" in body) {
    const all = body.applyAll;
    const value = all === null ? null : typeof all === "string" && SOUNDS.includes(all) ? all : undefined;
    if (value === undefined) {
      return NextResponse.json({ error: `applyAll must be null or one of: ${SOUNDS.join(", ")}` }, { status: 400 });
    }
    // The level and pitch travel with it: the sound was tuned before it was
    // applied, and applying it without the tuning would throw that away.
    const bulkVolume = typeof body.volume === "number" && body.volume >= 0 && body.volume <= 2 ? body.volume : null;
    const bulkPitch = typeof body.pitch === "number" && body.pitch >= 0.5 && body.pitch <= 2 ? body.pitch : null;

    if (value === null) {
      const { error } = await supabase
        .from("project_beats")
        .update({ sound_effect: null, sound_volume: null, sound_pitch: null })
        .eq("project_id", projectId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, applied: null });
    }

    // Where there is a transition, and on the beat that ARRIVES through it: a
    // whoosh belongs to the shot coming in, not the one leaving. A cut after
    // beat 3 means the sound lands on beat 4.
    const { data: proj } = await supabase
      .from("projects").select("transition").eq("id", projectId).maybeSingle();
    const projectTransition = ((proj as Record<string, unknown> | null)?.transition as string | null) ?? "none";
    const { data: rows, error: readErr } = await supabase
      .from("project_beats").select("beat_number, transition").eq("project_id", projectId).order("beat_number");
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    const beatsList = (rows ?? []) as { beat_number: number; transition: string | null }[];
    const targets: number[] = [];
    for (let i = 0; i < beatsList.length - 1; i++) {
      const seam = beatsList[i].transition ?? projectTransition;
      if (seam && seam !== "none") targets.push(beatsList[i + 1].beat_number);
    }
    if (!targets.length) {
      return NextResponse.json({ error: "No cuts have a transition yet — set one on the Transitions tab first." }, { status: 400 });
    }
    const { error } = await supabase
      .from("project_beats")
      .update({ sound_effect: value, sound_volume: bulkVolume, sound_pitch: bulkPitch })
      .eq("project_id", projectId)
      .in("beat_number", targets);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, applied: value, count: targets.length });
  }

  // { tuneAll: "whoosh", volume, pitch } re-levels every beat already carrying
  // that sound, without moving which beats have it. The panel edits whatever
  // the sound is applied to, so what is heard here is what plays.
  if ("tuneAll" in body) {
    const id = body.tuneAll;
    if (typeof id !== "string" || !SOUNDS.includes(id)) {
      return NextResponse.json({ error: `tuneAll must be one of: ${SOUNDS.join(", ")}` }, { status: 400 });
    }
    const patch: Record<string, unknown> = {};
    if (typeof body.volume === "number" && body.volume >= 0 && body.volume <= 2) patch.sound_volume = body.volume;
    if (typeof body.pitch === "number" && body.pitch >= 0.5 && body.pitch <= 2) patch.sound_pitch = body.pitch;
    if (!Object.keys(patch).length) {
      return NextResponse.json({ error: "volume or pitch is required" }, { status: 400 });
    }
    const { error } = await supabase
      .from("project_beats").update(patch)
      .eq("project_id", projectId).eq("sound_effect", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, tuned: id });
  }

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

  // Level and pitch ride along, so choosing a sound and shaping it are one
  // round trip. Clearing the sound clears them too: they belong to it.
  const bounded = (v: unknown, lo: number, hi: number): number | null | undefined =>
    v === null ? null
      : v === undefined ? undefined
        : typeof v === "number" && v >= lo && v <= hi ? v : undefined;
  const volume = bounded(body.volume, 0, 2);
  const pitch = bounded(body.pitch, 0.5, 2);
  if (body.volume !== undefined && volume === undefined) {
    return NextResponse.json({ error: "volume must be null or between 0 and 2" }, { status: 400 });
  }
  if (body.pitch !== undefined && pitch === undefined) {
    return NextResponse.json({ error: "pitch must be null or between 0.5 and 2" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { sound_effect: sound };
  if (sound === null) { patch.sound_volume = null; patch.sound_pitch = null; }
  if (volume !== undefined) patch.sound_volume = volume;
  if (pitch !== undefined) patch.sound_pitch = pitch;

  const { error } = await supabase
    .from("project_beats")
    .update(patch)
    .eq("project_id", projectId)
    .eq("beat_number", beatNumber);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, beatNumber, sound, volume, pitch });
}
