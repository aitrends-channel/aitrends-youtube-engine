import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { requireActiveSubscription } from "@/lib/subscription";
import { submitQueued, WARM_START_MAX } from "@/lib/genaipro/pump";

// Submits the first few of a project's parked GenAIPro clips immediately,
// instead of leaving them in gp_queued until the every-two-minutes cron fires.
//
// The generate step calls this right after queueing. Without it the honest
// reading of the UI is "queued" for up to two minutes with nothing happening,
// which is what it looked like to the user who reported it.
//
// Deliberately small and deliberately scoped. GenAIPro allows 30 submits a
// minute and the cron already takes 20 every two minutes; WARM_START_MAX keeps
// this a rounding error against that budget. It also bounds how long the caller
// waits, since each submit downloads the beat's still and uploads it as
// multipart.
//
// Safe to call spuriously: submitQueued claims each beat with a conditional
// update on the parking status, so the cron and any number of warm starts can
// race for the same beat and exactly one wins.
export const maxDuration = 60;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const expired = requireActiveSubscription(user);
  if (expired) return expired;

  const { projectId } = await req.json().catch(() => ({})) as { projectId?: string };
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  // Ownership check before touching the queue: this endpoint spends the
  // caller's credits, so it must never act on someone else's project.
  const { data: project, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "Could not read that project" }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const result = await submitQueued({ projectId, limit: WARM_START_MAX });
  return NextResponse.json({ ok: true, ...result });
}
