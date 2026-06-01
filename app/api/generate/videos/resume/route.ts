import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId, modelId, duration, aspectRatio } = await req.json() as {
    projectId?: string; modelId?: string; duration?: string | number | null; aspectRatio?: string;
  };
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  // If a model was supplied, swap it on the project so the worker picks up
  // the new one when claiming the resumed beats.
  if (modelId) {
    await supabase.from("projects").update({
      video_model_id: modelId,
      video_duration: duration ?? null,
      video_aspect_ratio: aspectRatio ?? "16:9",
    }).eq("id", projectId).eq("user_id", user.id);
  }

  const { error, count } = await supabase
    .from("project_beats")
    .update({ video_status: "queued", video_error: null }, { count: "exact" })
    .eq("project_id", projectId)
    .eq("video_status", "paused");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ resumed: count ?? 0 });
}
