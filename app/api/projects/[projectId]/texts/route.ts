export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Text overlaid on the assembled video: the words, when they are on screen,
// where, and how they are drawn.
//
//   GET                      every text for this project
//   POST   { content, ... }  add one
//   PATCH  { id, ... }       edit, move, resize or retime it
//   DELETE ?id=…             remove it
//
// Shaped like the elements route beside it, because the two are the same kind
// of thing on the timeline and a person reading one should recognise the other.

const STYLES = ["plain", "outline", "box"];
const MIN_SPAN = 0.3;
const MAX_CONTENT = 200;
/** Matches the table's constraint, so a bad colour is a 400 rather than a 500
 *  from Postgres. */
const COLOUR = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

const COLS = "id, content, start_sec, end_sec, x, y, size, colour, style, bg_colour, bg_opacity, lane";

async function ownProject(projectId: string, userId: string) {
  const { data, error } = await supabase
    .from("projects").select("id").eq("id", projectId).eq("user_id", userId).maybeSingle();
  return { ok: !!data, error };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Trimmed, capped, and stripped of the line breaks drawtext cannot take in a
 *  single call. A pasted paragraph becomes one line rather than an error. */
function cleanContent(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const text = v.replace(/[\r\n\t]+/g, " ").trim().slice(0, MAX_CONTENT);
  return text.length ? text : null;
}

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
    .from("project_texts")
    .select(COLS)
    .eq("project_id", params.projectId)
    .order("lane").order("start_sec");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ texts: data ?? [] });
}

export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  const g = await guard(params.projectId);
  if (g.res) return g.res;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const content = cleanContent(body.content);
  if (!content) return NextResponse.json({ error: "content is required" }, { status: 400 });

  const start = Math.max(0, num(body.start_sec) ?? 0);
  const end = Math.max(start + MIN_SPAN, num(body.end_sec) ?? start + 3);
  const colour = typeof body.colour === "string" && COLOUR.test(body.colour) ? body.colour : "#FFFFFF";
  const style = typeof body.style === "string" && STYLES.includes(body.style) ? body.style : "outline";
  // Explicitly null means no panel, which is different from not saying.
  const bgColour = typeof body.bg_colour === "string" && COLOUR.test(body.bg_colour) ? body.bg_colour : null;

  const { data, error } = await supabase
    .from("project_texts")
    .insert({
      project_id: params.projectId,
      content,
      start_sec: start,
      end_sec: end,
      x: clamp(num(body.x) ?? 0.1, 0, 1),
      y: clamp(num(body.y) ?? 0.1, 0, 1),
      size: clamp(num(body.size) ?? 0.06, 0.02, 0.4),
      colour,
      style,
      bg_colour: bgColour,
      bg_opacity: clamp(num(body.bg_opacity) ?? 0.55, 0, 1),
      lane: Math.round(clamp(num(body.lane) ?? 0, 0, 9)),
    })
    .select(COLS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ text: data });
}

export async function PATCH(req: Request, { params }: { params: { projectId: string } }) {
  const g = await guard(params.projectId);
  if (g.res) return g.res;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const id = body.id;
  if (typeof id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });

  const patch: Record<string, number | string | null> = {};
  if (body.content !== undefined) {
    const content = cleanContent(body.content);
    if (!content) return NextResponse.json({ error: "content cannot be empty" }, { status: 400 });
    patch.content = content;
  }
  if (typeof body.colour === "string" && COLOUR.test(body.colour)) patch.colour = body.colour;
  if (typeof body.style === "string" && STYLES.includes(body.style)) patch.style = body.style;
  // null clears the panel; a hex sets it. Anything else is not a change.
  if (body.bg_colour === null) patch.bg_colour = null;
  else if (typeof body.bg_colour === "string" && COLOUR.test(body.bg_colour)) patch.bg_colour = body.bg_colour;
  if (num(body.bg_opacity) !== undefined) patch.bg_opacity = clamp(num(body.bg_opacity)!, 0, 1);

  const start = num(body.start_sec);
  const end = num(body.end_sec);
  if (start !== undefined) patch.start_sec = Math.max(0, start);
  if (end !== undefined) patch.end_sec = end;
  // Both together: a span whose end lands before its start is rejected by the
  // table, and it is easy to send while dragging one edge past the other.
  if (start !== undefined && end !== undefined && end < start + MIN_SPAN) {
    patch.end_sec = start + MIN_SPAN;
  }
  if (num(body.x) !== undefined) patch.x = clamp(num(body.x)!, 0, 1);
  if (num(body.y) !== undefined) patch.y = clamp(num(body.y)!, 0, 1);
  if (num(body.size) !== undefined) patch.size = clamp(num(body.size)!, 0.02, 0.4);
  if (num(body.lane) !== undefined) patch.lane = Math.round(clamp(num(body.lane)!, 0, 9));
  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const { data, error } = await supabase
    .from("project_texts")
    .update(patch)
    .eq("id", id)
    .eq("project_id", params.projectId)
    .select(COLS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ text: data });
}

export async function DELETE(req: Request, { params }: { params: { projectId: string } }) {
  const g = await guard(params.projectId);
  if (g.res) return g.res;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { error } = await supabase
    .from("project_texts").delete().eq("id", id).eq("project_id", params.projectId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
