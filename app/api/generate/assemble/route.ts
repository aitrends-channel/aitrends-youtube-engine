import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { redis } from "@/lib/queue/client";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  void user;

  const client = await createSupabaseServerClient();

  const body = await req.json().catch(() => ({})) as {
    projectId?: string;
    aspectRatio?: string;
    voiceoverType?: string;
    captionsEnabled?: boolean;
    captionsLanguage?: string;
    captionsStyle?: string;
    captionsSize?: string;
    captionsPosition?: string;
    // Opt-in flag set by the "Trim silences" button on the assemble
    // page. The worker only runs the per-beat silence trim when this
    // is true; a normal Assemble / Reassemble leaves audio untouched.
    trimSilenceEnabled?: boolean;
  };

  const { projectId, ...options } = body;
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  await redis.set(`assembly:${projectId}`, JSON.stringify(options), { ex: 7200 });

  // Also clear assembly_stop_requested — this endpoint is reached by
  // both fresh assemblies AND Resume. Without this, a leftover true
  // flag from a prior Stop would trip the worker's assertStopRequested
  // check the moment the new run begins.
  const { error } = await client
    .from("projects")
    .update({ assembly_status: "queued", assembly_progress: "Queued…", assembly_error: null, assembly_stop_requested: false })
    .eq("id", projectId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ queued: true });
}
