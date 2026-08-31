export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Elements overlaid on the assembled video: which button, when it is on
// screen, and where.
//
//   GET                       every element for this project
//   POST   { element, ... }   add one
//   PATCH  { id, ... }        move it, resize it, or change its span
//   DELETE ?id=…              remove it
//
// Times are seconds along the finished video; position and size are fractions
// of the frame, like the channel logo, so they mean the same at any resolution.

/** Must stay in step with the table's check constraint and the files the
 *  worker ships in assets/elements. */
const ELEMENTS = ["subscribe", "subscribed", "like", "share", "follow", "comment", "new", "live",
  "bell", "bell-ring",
  "youtube", "instagram", "tiktok", "facebook", "x", "whatsapp",
  "heart", "thumbs-up"];

const MIN_SPAN = 0.3;

async function ownProject(projectId: string, userId: string) {
  const { data, error } = await supabase
    .from("projects").select("id").eq("id", projectId).eq("user_id", userId).maybeSingle();
  return { ok: !!data, error };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export async function GET(_req: Request, { params }: { params: { projectId: string } }) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const { ok, error: ownErr } = await ownProject(params.projectId, user.id);
  if (ownErr) return NextResponse.json({ error: ownErr.message }, { status: 500 });
  if (!ok) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("project_elements")
    .select("id, element, start_sec, end_sec, x, y, size, lane")
    .eq("project_id", params.projectId)
    .order("lane").order("start_sec");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ elements: data ?? [] });
}

export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const { ok, error: ownErr } = await ownProject(params.projectId, user.id);
  if (ownErr) return NextResponse.json({ error: ownErr.message }, { status: 500 });
  if (!ok) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const element = body.element;
  if (typeof element !== "string" || !ELEMENTS.includes(element)) {
    return NextResponse.json({ error: `element must be one of: ${ELEMENTS.join(", ")}` }, { status: 400 });
  }
  const start = Math.max(0, num(body.start_sec) ?? 0);
  const end = Math.max(start + MIN_SPAN, num(body.end_sec) ?? start + 3);

  const { data, error } = await supabase
    .from("project_elements")
    .insert({
      project_id: params.projectId,
      element,
      start_sec: start,
      end_sec: end,
      x: clamp(num(body.x) ?? 0.7, 0, 1),
      y: clamp(num(body.y) ?? 0.1, 0, 1),
      size: clamp(num(body.size) ?? 0.18, 0.05, 0.8),
      lane: Math.round(clamp(num(body.lane) ?? 0, 0, 9)),
    })
    .select("id, element, start_sec, end_sec, x, y, size, lane")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ element: data });
}

export async function PATCH(req: Request, { params }: { params: { projectId: string } }) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const { ok, error: ownErr } = await ownProject(params.projectId, user.id);
  if (ownErr) return NextResponse.json({ error: ownErr.message }, { status: 500 });
  if (!ok) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const id = body.id;
  if (typeof id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });

  const patch: Record<string, number | string> = {};
  if (typeof body.element === "string" && ELEMENTS.includes(body.element)) patch.element = body.element;
  const start = num(body.start_sec);
  const end = num(body.end_sec);
  if (start !== undefined) patch.start_sec = Math.max(0, start);
  if (end !== undefined) patch.end_sec = end;
  // Both together: a span whose end lands before its start is rejected by the
  // table, and it is easy to send while dragging an edge past the other one.
  if (start !== undefined && end !== undefined && end < start + MIN_SPAN) {
    patch.end_sec = start + MIN_SPAN;
  }
  if (num(body.x) !== undefined) patch.x = clamp(num(body.x)!, 0, 1);
  if (num(body.y) !== undefined) patch.y = clamp(num(body.y)!, 0, 1);
  if (num(body.size) !== undefined) patch.size = clamp(num(body.size)!, 0.05, 0.8);
  if (num(body.lane) !== undefined) patch.lane = Math.round(clamp(num(body.lane)!, 0, 9));
  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const { data, error } = await supabase
    .from("project_elements")
    .update(patch)
    .eq("id", id)
    .eq("project_id", params.projectId)
    .select("id, element, start_sec, end_sec, x, y, size, lane")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ element: data });
}

export async function DELETE(req: Request, { params }: { params: { projectId: string } }) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const { ok, error: ownErr } = await ownProject(params.projectId, user.id);
  if (ownErr) return NextResponse.json({ error: ownErr.message }, { status: 500 });
  if (!ok) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { error } = await supabase
    .from("project_elements").delete().eq("id", id).eq("project_id", params.projectId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
