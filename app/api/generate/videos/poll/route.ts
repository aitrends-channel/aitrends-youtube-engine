import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";

export async function GET(req: Request) {
  try { await getRequiredUser(); } catch (e) { return e as Response; }

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");

  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const { data: beats } = await supabase
    .from("project_beats")
    .select("beat_number, video_status")
    .eq("project_id", projectId)
    .in("video_status", ["queued", "rendering"]);

  return NextResponse.json({ pending: beats?.length ?? 0 });
}
