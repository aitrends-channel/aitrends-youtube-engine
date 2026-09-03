import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { ONE_CLICK_HIDDEN } from "@/lib/feature-flags";
import { isAdminUser } from "@/lib/admin";
import { fetchTranscriptsViaSupadata } from "@/lib/youtube/supadata";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

// Server-side channel analysis for 1Click. The channel page engages
// autopilot and redirects to the live view right after the quick channel
// fetch; the slow work — transcripts + Claude analysis — runs HERE in the
// background instead of blocking the browser. Fetches transcripts for the
// project's top videos, then reuses the exact /api/workflow/analyze
// pipeline (Claude analysis + topic ideas + the state-6 write) via a
// server-to-server call, forwarding the user's cookie.
//
// Idempotent: if analysis already landed (channel_analysis set), it no-ops
// so a duplicate nudge can't double-bill.
/** 1Click is hidden from customers by ONE_CLICK_HIDDEN, and the flag only ever
 *  hid the buttons: these routes were reachable by anyone signed in. Nothing
 *  linked to them, which is not the same as nothing being able to reach them —
 *  and a run started here spends real provider money on Heclus's account.
 *  Admins are exempt so the feature stays testable while it is hidden. */
function oneClickBlocked(user: User): Response | null {
  if (!ONE_CLICK_HIDDEN || isAdminUser(user)) return null;
  return new Response(JSON.stringify({ error: "1Click is not available yet." }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const blocked = oneClickBlocked(user);
  if (blocked) return blocked;

  const body = (await req.json().catch(() => ({}))) as { projectId?: string; topicHint?: string };
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const { data: project } = await supabase
    .from("projects")
    .select("id, user_id, channel_info, channel_analysis")
    .eq("id", projectId)
    .maybeSingle();
  if (!project || project.user_id !== user.id) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (project.channel_analysis) {
    return NextResponse.json({ ok: true, note: "already analyzed" });
  }

  const topVideos = ((project.channel_info as { topVideos?: { videoId?: string; title?: string }[] } | null)?.topVideos ?? [])
    .map((v) => ({ videoId: (v.videoId ?? "").trim(), title: (v.title ?? "").trim() }))
    .filter((v) => v.videoId)
    .slice(0, 15);
  if (topVideos.length === 0) {
    return NextResponse.json({ error: "No channel videos to analyze" }, { status: 400 });
  }

  const transcripts = await fetchTranscriptsViaSupadata(topVideos);
  const usable = transcripts.filter((t) => t.success !== false);
  if (usable.length === 0) {
    return NextResponse.json({ error: "No transcripts available for this channel" }, { status: 502 });
  }

  // Reuse the full analyze pipeline (same route the studio flow uses).
  // topicMode "generate" so video_ideas exist for auto topic selection.
  const origin = new URL(req.url).origin;
  const res = await fetch(`${origin}/api/workflow/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: req.headers.get("cookie") ?? "" },
    body: JSON.stringify({ projectId, transcripts, topicMode: "generate", topicHint: body.topicHint }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    return NextResponse.json({ error: data.error ?? "Channel analysis failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
