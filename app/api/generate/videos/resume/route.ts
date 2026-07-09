import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId, modelId, duration, aspectRatio, resolution } = await req.json() as {
    projectId?: string; modelId?: string; duration?: string | number | null; aspectRatio?: string; resolution?: string | null;
  };
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  // If a model was supplied, swap it on the project so the worker picks up
  // the new one when claiming the resumed beats. video_resolution is always
  // written (defaults to NULL when the client omits it or the model has no
  // resolution knob) so a resume onto a no-resolution model clears any
  // stale value the DB was carrying from the previous submit — otherwise
  // the worker would forward the old resolution as an extra input.* field
  // that the new model doesn't accept.
  if (modelId) {
    await supabase.from("projects").update({
      video_model_id: modelId,
      video_duration: duration ?? null,
      video_aspect_ratio: aspectRatio ?? "16:9",
      video_resolution: resolution ?? null,
    }).eq("id", projectId).eq("user_id", user.id);
  }

  // Snapshot the beat-level config so a resumed beat honors the
  // settings the client just supplied instead of whatever the beat
  // was last queued with. Only stamped when modelId is present — a
  // resume without new settings shouldn't overwrite the beat's
  // existing snapshot with nulls.
  const beatSnapshot = modelId
    ? {
        video_model_id: modelId,
        video_aspect_ratio: aspectRatio ?? "16:9",
        video_duration: duration != null ? String(duration) : null,
        video_resolution: resolution ?? null,
      }
    : {};

  const { error, count } = await supabase
    .from("project_beats")
    .update({ video_status: "queued", video_error: null, ...beatSnapshot }, { count: "exact" })
    .eq("project_id", projectId)
    .eq("video_status", "paused");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ resumed: count ?? 0 });
}
