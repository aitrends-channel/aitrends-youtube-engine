import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { WORKER_URL } from "@/lib/workerUrl";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  void user;

  const client = await createSupabaseServerClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) {
    return NextResponse.json({ error: "No active session" }, { status: 401 });
  }

  const { projectId } = await req.json().catch(() => ({})) as { projectId?: string };
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const res = await fetch(`${WORKER_URL}/api/upload/${projectId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: session.access_token }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    return NextResponse.json({ error: err.error ?? "Upload failed" }, { status: res.status });
  }

  return NextResponse.json({ started: true });
}
