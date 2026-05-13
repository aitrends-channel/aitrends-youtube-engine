import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function POST() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  void user;

  const client = await createSupabaseServerClient();
  const { data: { session } } = await client.auth.getSession();

  if (!session?.access_token) {
    return NextResponse.json({ error: "No active session" }, { status: 401 });
  }

  const workerUrl = process.env.WORKER_URL ?? "https://video-worker-9mob.onrender.com";

  return NextResponse.json({ workerUrl, token: session.access_token });
}
