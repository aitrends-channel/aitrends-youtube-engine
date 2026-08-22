import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { requireActiveSubscription } from "@/lib/subscription";
import { requireWalletFunds } from "@/lib/heclus-charge";
import { GENAIPRO_MODEL_PREFIX } from "@/lib/genaipro/status";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const expired = requireActiveSubscription(user);
  if (expired) return expired;
  const { projectId, modelId, duration, aspectRatio, resolution } = await req.json() as {
    projectId?: string; modelId?: string; duration?: string | number | null; aspectRatio?: string; resolution?: string | null;
  };
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  // Paid lane only, same as the queue route: a resumed free clip draws on the
  // video-credit wallet, so an empty Heclus balance is not its problem. The
  // model can arrive in the body or already be on the project, so both are
  // checked before deciding.
  const resumeModel = modelId ?? await projectVideoModel(projectId);
  if (!resumeModel?.toLowerCase().startsWith(GENAIPRO_MODEL_PREFIX)) {
    const broke = await requireWalletFunds(user);
    if (broke) return broke;
  }

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

/** The model already stored on the project, for a resume that does not name one. */
async function projectVideoModel(projectId: string): Promise<string | null> {
  const { data } = await supabase
    .from("projects")
    .select("video_model_id")
    .eq("id", projectId)
    .maybeSingle();
  return (data as { video_model_id?: string | null } | null)?.video_model_id ?? null;
}
