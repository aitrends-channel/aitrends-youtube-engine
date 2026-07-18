import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getOneClickConfig } from "@/lib/one-click/config";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// Engage 1Click (autopilot) on a project. Snapshots the user's saved
// preset onto the project so preset edits never change a run already
// in flight. The orchestrator's tick loop picks the project up from
// whatever current_state it's in (the channel/analysis step runs
// client-side at kickoff while the user is still present).

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  let body: { projectId?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id, user_id")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });
  if (!project || project.user_id !== user.id) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const config = await getOneClickConfig(user.id);
  if (!config) {
    return NextResponse.json(
      { error: "1Click isn't configured yet — save your preferences first.", code: "not_configured" },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from("projects")
    .update({
      auto_pilot: true,
      auto_pilot_status: "running",
      auto_pilot_error: null,
      auto_pilot_config: config,
      auto_pilot_attempts: {},
      auto_pilot_last_tick: null,
    })
    .eq("id", projectId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

// Pause / resume a live run without disengaging autopilot. Paused
// projects are skipped by the tick loop; resume puts them back in the
// running pool from wherever they left off.
export async function PATCH(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  let body: { projectId?: unknown; action?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const action = body.action === "pause" || body.action === "resume" ? body.action : null;
  if (!projectId || !action) {
    return NextResponse.json({ error: "projectId and action (pause|resume) are required" }, { status: 400 });
  }

  const { data: project } = await supabase
    .from("projects").select("id, user_id").eq("id", projectId).maybeSingle();
  if (!project || project.user_id !== user.id) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("projects")
    .update({
      auto_pilot: true,
      auto_pilot_status: action === "pause" ? "paused" : "running",
      // Clearing the error on resume gives the run a clean retry.
      ...(action === "resume" ? { auto_pilot_error: null } : {}),
    })
    .eq("id", projectId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, status: action === "pause" ? "paused" : "running" });
}

// Disengage: the project stays exactly where it is and the normal
// wizard takes over from that step.
export async function DELETE(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId") ?? "";
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const { data: project } = await supabase
    .from("projects").select("id, user_id").eq("id", projectId).maybeSingle();
  if (!project || project.user_id !== user.id) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("projects")
    .update({ auto_pilot: false, auto_pilot_status: "stopped" })
    .eq("id", projectId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
