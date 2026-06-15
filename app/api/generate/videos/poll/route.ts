export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";

export async function GET(req: Request) {
  try { await getRequiredUser(); } catch (e) { return e as Response; }

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");

  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const [pendingRes, failedRes] = await Promise.all([
    supabase.from("project_beats")
      .select("beat_number")
      .eq("project_id", projectId)
      .in("video_status", ["queued", "submitting", "rendering"]),
    supabase.from("project_beats")
      .select("video_error")
      .eq("project_id", projectId)
      .eq("video_status", "failed")
      .not("video_error", "is", null)
      .limit(1),
  ]);

  const firstError = failedRes.data?.[0]?.video_error ?? null;
  return NextResponse.json({ pending: pendingRes.data?.length ?? 0, firstError });
}
