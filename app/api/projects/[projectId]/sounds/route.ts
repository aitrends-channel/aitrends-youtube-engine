export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Sounds placed at a moment on the finished video.
//
//   GET                     every placed sound for this project
//   POST   { sound, ... }   drop one at a time
//   PATCH  { id, ... }      move it, or change its level or pitch
//   DELETE ?id=…            remove it
//
// Shaped like the elements and texts routes beside it. The per-beat sounds on
// project_beats are unaffected; the worker mixes both into one bed.

/** Must stay in step with the table's check constraint and the worker's
 *  SOUND_EFFECTS, which are the filenames under assets/sfx. */
const SOUNDS = ["whoosh", "reverse-whoosh", "swish", "sweep", "page",
  "click", "tick", "pop", "beep", "glitch", "shutter",
  "zoom-in", "zoom-out", "riser",
  "impact", "boom", "thud", "heartbeat",
  "chime", "ding", "sparkle",
  "bell", "notification", "alert"];

const COLS = "id, sound, at_sec, volume, pitch, duration_sec, lane";

async function ownProject(projectId: string, userId: string) {
  const { data, error } = await supabase
    .from("projects").select("id").eq("id", projectId).eq("user_id", userId).maybeSingle();
  return { ok: !!data, error };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

async function guard(projectId: string) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return { res: e as Response }; }
  const { ok, error } = await ownProject(projectId, user.id);
  if (error) return { res: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!ok) return { res: NextResponse.json({ error: "Project not found" }, { status: 404 }) };
  return { user };
}

export async function GET(_req: Request, { params }: { params: { projectId: string } }) {
  const g = await guard(params.projectId);
  if (g.res) return g.res;
  const { data, error } = await supabase
    .from("project_sounds").select(COLS)
    .eq("project_id", params.projectId).order("at_sec");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sounds: data ?? [] });
}

export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  const g = await guard(params.projectId);
  if (g.res) return g.res;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const sound = body.sound;
  if (typeof sound !== "string" || !SOUNDS.includes(sound)) {
    return NextResponse.json({ error: `sound must be one of: ${SOUNDS.join(", ")}` }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("project_sounds")
    .insert({
      project_id: params.projectId,
      sound,
      at_sec: Math.max(0, num(body.at_sec) ?? 0),
      volume: clamp(num(body.volume) ?? 1, 0, 2),
      pitch: clamp(num(body.pitch) ?? 1, 0.5, 2),
      // Absent means the whole file, which is not the same as zero.
      duration_sec: num(body.duration_sec) !== undefined ? clamp(num(body.duration_sec)!, 0.05, 30) : null,
      lane: Math.round(clamp(num(body.lane) ?? 0, 0, 9)),
    })
    .select(COLS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sound: data });
}

export async function PATCH(req: Request, { params }: { params: { projectId: string } }) {
  const g = await guard(params.projectId);
  if (g.res) return g.res;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const id = body.id;
  if (typeof id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });

  const patch: Record<string, number | string | null> = {};
  if (typeof body.sound === "string" && SOUNDS.includes(body.sound)) patch.sound = body.sound;
  if (num(body.at_sec) !== undefined) patch.at_sec = Math.max(0, num(body.at_sec)!);
  if (num(body.volume) !== undefined) patch.volume = clamp(num(body.volume)!, 0, 2);
  if (num(body.pitch) !== undefined) patch.pitch = clamp(num(body.pitch)!, 0.5, 2);
  // null restores the whole file; a number trims to it.
  if (body.duration_sec === null) patch.duration_sec = null;
  else if (num(body.duration_sec) !== undefined) patch.duration_sec = clamp(num(body.duration_sec)!, 0.05, 30);
  if (num(body.lane) !== undefined) patch.lane = Math.round(clamp(num(body.lane)!, 0, 9));
  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const { data, error } = await supabase
    .from("project_sounds").update(patch)
    .eq("id", id).eq("project_id", params.projectId)
    .select(COLS).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sound: data });
}

export async function DELETE(req: Request, { params }: { params: { projectId: string } }) {
  const g = await guard(params.projectId);
  if (g.res) return g.res;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const { error } = await supabase
    .from("project_sounds").delete().eq("id", id).eq("project_id", params.projectId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
