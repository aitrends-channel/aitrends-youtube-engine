import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Persist a user-uploaded asset onto a beat. The browser has already
// PUT the file to R2 via /api/upload/presign; this just points the beat
// row at the resulting public URL and marks it done — the manual
// alternative to KIE generation for a single beat.
//
// The URL is validated to be one of our own R2 objects living under this
// project's path, so a caller can't point a beat at an arbitrary host or
// another project's files.
export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const projectId = params.projectId;
  const body = await req.json().catch(() => ({})) as {
    beatNumber?: number;
    type?: "image" | "video";
    url?: string;
  };
  const { beatNumber, type, url } = body;
  if (typeof beatNumber !== "number" || (type !== "image" && type !== "video") || !url) {
    return NextResponse.json({ error: "beatNumber, type ('image'|'video') and url are required" }, { status: 400 });
  }

  const { data: project } = await supabase
    .from("projects").select("id").eq("id", projectId).eq("user_id", user.id).single();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const publicBase = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
  if (!publicBase || !url.startsWith(`${publicBase}/`) || !url.includes(`/${projectId}/`)) {
    return NextResponse.json({ error: "Invalid asset URL" }, { status: 400 });
  }

  // On upload we treat the asset as final: mark done and clear any
  // in-flight KIE task/error so pollers and status badges settle.
  const patch = type === "image"
    ? { image_url: url, image_status: "done", image_task_id: null }
    : { video_url: url, video_status: "done", video_error: null };

  const { error } = await supabase
    .from("project_beats")
    .update(patch)
    .eq("project_id", projectId)
    .eq("beat_number", beatNumber);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
