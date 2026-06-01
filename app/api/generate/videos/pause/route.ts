import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";

export async function POST(req: Request) {
  try { await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = await req.json() as { projectId?: string };
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  // Only pause beats not yet claimed by the worker. In-flight `rendering`
  // beats stay running — KIE can't be interrupted mid-task and the worker
  // will naturally finish them.
  const { error, count } = await supabase
    .from("project_beats")
    .update({ video_status: "paused" }, { count: "exact" })
    .eq("project_id", projectId)
    .eq("video_status", "queued");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ paused: count ?? 0 });
}
