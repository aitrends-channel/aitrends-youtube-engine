import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

export interface ActivityEvent {
  id: string;
  timestamp: string;
  type: "signup" | "niche_created" | "video_completed" | "video_failed" | "founder_claim" | "subscription";
  actor_email: string | null;
  actor_user_id: string | null;
  details?: Record<string, unknown>;
}

export interface ErrorEvent {
  id: string;
  timestamp: string;
  source: string;
  level: string;
  message: string;
  user_id: string | null;
  user_email: string | null;
  project_id: string | null;
}

export async function GET(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "activity";

  if (type === "errors") return errorsResponse();
  if (type === "worker") return workerResponse();
  return activityResponse();
}

async function listEmailLookup(): Promise<Map<string, string | undefined>> {
  const { data } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  return new Map((data?.users ?? []).map((u) => [u.id, u.email]));
}

async function activityResponse() {
  const { data: usersList } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const users = usersList?.users ?? [];
  const emailById = new Map(users.map((u) => [u.id, u.email]));

  // Sign-ups — most recent 50 by created_at.
  const signupEvents: ActivityEvent[] = [...users]
    .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
    .slice(0, 50)
    .map((u) => ({
      id: `signup_${u.id}`,
      timestamp: u.created_at!,
      type: "signup",
      actor_email: u.email ?? null,
      actor_user_id: u.id,
    }));

  // Subscriptions — users with app_metadata.paid_at.
  const subEvents: ActivityEvent[] = users
    .filter((u) => u.app_metadata?.paid_at)
    .map((u) => ({
      id: `sub_${u.id}_${u.app_metadata!.paid_at}`,
      timestamp: u.app_metadata!.paid_at as string,
      type: "subscription",
      actor_email: u.email ?? null,
      actor_user_id: u.id,
      details: { plan: u.app_metadata?.plan ?? "unknown" },
    }));

  // Niche creation — most recent 50 projects.
  const { data: niches } = await supabase
    .from("projects")
    .select("id, user_id, channel_name, channel_url, selected_topic, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  const nicheEvents: ActivityEvent[] = (niches ?? []).map((p) => ({
    id: `niche_${p.id}`,
    timestamp: p.created_at,
    type: "niche_created",
    actor_email: emailById.get(p.user_id) ?? null,
    actor_user_id: p.user_id,
    details: {
      channel_name: p.channel_name,
      channel_url: p.channel_url,
      topic: p.selected_topic,
      project_id: p.id,
    },
  }));

  // Assembly events — completed or failed.
  const { data: assemblies } = await supabase
    .from("projects")
    .select("id, user_id, channel_name, selected_topic, assembly_status, assembly_error, updated_at")
    .in("assembly_status", ["done", "failed"])
    .order("updated_at", { ascending: false })
    .limit(50);
  const assemblyEvents: ActivityEvent[] = (assemblies ?? []).map((p) => ({
    id: `assembly_${p.id}_${p.updated_at}`,
    timestamp: p.updated_at,
    type: p.assembly_status === "done" ? "video_completed" : "video_failed",
    actor_email: emailById.get(p.user_id) ?? null,
    actor_user_id: p.user_id,
    details: {
      channel_name: p.channel_name,
      topic: p.selected_topic,
      project_id: p.id,
      ...(p.assembly_status === "failed" && p.assembly_error ? { error: p.assembly_error } : {}),
    },
  }));

  // Founder claims.
  const { data: founders } = await supabase
    .from("founder_claims_log")
    .select("payment_id, user_id, claimed_at")
    .order("claimed_at", { ascending: false })
    .limit(50);
  const founderEvents: ActivityEvent[] = (founders ?? []).map((f) => ({
    id: `founder_${f.payment_id}`,
    timestamp: f.claimed_at,
    type: "founder_claim",
    actor_email: emailById.get(f.user_id) ?? null,
    actor_user_id: f.user_id,
    details: { payment_id: f.payment_id },
  }));

  const all = [...signupEvents, ...subEvents, ...nicheEvents, ...assemblyEvents, ...founderEvents]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 100);

  return NextResponse.json({ events: all });
}

async function errorsResponse() {
  const [{ data: logs }, { data: fails }, emailById] = await Promise.all([
    supabase
      .from("system_logs")
      .select("id, created_at, level, source, message, user_id, project_id")
      .eq("level", "error")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("projects")
      .select("id, user_id, assembly_error, updated_at")
      .eq("assembly_status", "failed")
      .order("updated_at", { ascending: false })
      .limit(50),
    listEmailLookup(),
  ]);

  const logEvents: ErrorEvent[] = (logs ?? []).map((l) => ({
    id: l.id,
    timestamp: l.created_at,
    source: l.source,
    level: l.level,
    message: l.message,
    user_id: l.user_id,
    user_email: l.user_id ? emailById.get(l.user_id) ?? null : null,
    project_id: l.project_id,
  }));

  const failEvents: ErrorEvent[] = (fails ?? []).map((p) => ({
    id: `assembly_fail_${p.id}_${p.updated_at}`,
    timestamp: p.updated_at,
    source: "assemble",
    level: "error",
    message: p.assembly_error ?? "Assembly failed",
    user_id: p.user_id,
    user_email: emailById.get(p.user_id) ?? null,
    project_id: p.id,
  }));

  const all = [...logEvents, ...failEvents]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 100);

  return NextResponse.json({ events: all });
}

function workerResponse() {
  return NextResponse.json({
    events: [],
    notice: "Worker log integration not yet configured. Connect the Render API or have the worker write to a worker_logs table to surface stdout here.",
  });
}
