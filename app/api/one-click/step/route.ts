import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { ONE_CLICK_HIDDEN } from "@/lib/feature-flags";
import { isAdminUser } from "@/lib/admin";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// Manually (re)run a single 1Click step. The live view lets the user
// click any step to generate it or retry a failed one. Rather than
// re-implement each step, this resets just that step's incomplete
// artifacts and re-enters the orchestrator at that step's state, then the
// caller nudges the tick — so the exact same code paths run, only pointed
// at the chosen step. Downstream steps re-run naturally (a linear
// pipeline), which is the correct behavior when an upstream step changes.
const STEPS = new Set([
  "script", "visuals", "imagePrompts", "videoPrompts",
  "voiceovers", "images", "videos", "assemble", "thumbnails",
]);

/** 1Click is hidden from customers by ONE_CLICK_HIDDEN, and the flag only ever
 *  hid the buttons: these routes were reachable by anyone signed in. Nothing
 *  linked to them, which is not the same as nothing being able to reach them —
 *  and a run started here spends real provider money on Heclus's account.
 *  Admins are exempt so the feature stays testable while it is hidden. */
function oneClickBlocked(user: User): Response | null {
  if (!ONE_CLICK_HIDDEN || isAdminUser(user)) return null;
  return new Response(JSON.stringify({ error: "1Click is not available yet." }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const blocked = oneClickBlocked(user);
  if (blocked) return blocked;

  const body = (await req.json().catch(() => ({}))) as { projectId?: unknown; step?: unknown };
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const step = typeof body.step === "string" ? body.step : "";
  if (!projectId || !STEPS.has(step)) {
    return NextResponse.json({ error: "projectId and a valid step are required" }, { status: 400 });
  }

  const { data: project } = await supabase
    .from("projects").select("id, user_id, selected_topic").eq("id", projectId).maybeSingle();
  if (!project || project.user_id !== user.id) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Reset only the incomplete artifacts for the chosen step (so this is a
  // retry/complete, not a destructive full regen), then set current_state
  // to that step's entry point.
  const projPatch: Record<string, unknown> = {};
  switch (step) {
    case "script":
      // Re-runs runScriptStep (needs a topic); overwrites the script.
      projPatch.current_state = 6;
      break;
    case "visuals":
      projPatch.current_state = 7;
      break;
    case "imagePrompts":
    case "videoPrompts":
      // Both are produced by the prompts step; re-running it resumes and
      // fills any beat missing a prompt.
      projPatch.current_state = 9;
      break;
    case "voiceovers":
      await supabase.from("project_beats")
        .update({ voiceover_status: null, voiceover_error: null })
        .eq("project_id", projectId).is("voiceover_url", null);
      projPatch.current_state = 14;
      break;
    case "images":
      await supabase.from("project_beats")
        .update({ image_status: null, image_task_id: null })
        .eq("project_id", projectId).is("image_url", null);
      projPatch.current_state = 14;
      break;
    case "videos":
      await supabase.from("project_beats")
        .update({ video_status: null, video_job_id: null, video_error: null })
        .eq("project_id", projectId).is("video_url", null);
      projPatch.current_state = 14;
      break;
    case "assemble":
      // Clear the assembled output so runGenerateStep re-triggers assembly.
      projPatch.assembled_url = null;
      projPatch.assembly_status = null;
      projPatch.assembly_error = null;
      projPatch.current_state = 14;
      break;
    case "thumbnails":
      await supabase.from("project_thumbnails")
        .update({ image_status: null })
        .eq("project_id", projectId).is("image_url", null);
      projPatch.current_state = 15;
      break;
  }

  // Engage autopilot for this step and release any tick lock so the next
  // tick runs immediately.
  projPatch.auto_pilot = true;
  projPatch.auto_pilot_status = "running";
  projPatch.auto_pilot_error = null;
  projPatch.auto_pilot_last_tick = null;

  const { error } = await supabase.from("projects").update(projPatch).eq("id", projectId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, step });
}
