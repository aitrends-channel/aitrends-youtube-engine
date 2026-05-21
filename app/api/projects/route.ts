export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { data, error } = await supabase
    .from("projects")
    .select("id, created_at, channel_name, channel_url, current_state, selected_topic, assembly_status")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

const PLAN_LIMITS: Record<string, number | null> = { founder: 20, starter: 5, pro: null };
const ADMIN_EMAIL = "prioritylearn@gmail.com";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  if (body.fork) {
    const f = body.fork as {
      channelUrl?: string; channelName?: string;
      channelAnalysis?: unknown; channelInfo?: unknown; transcripts?: unknown;
      visualProfile?: unknown; thumbnailAnalysis?: unknown;
      videoIdeas?: string[]; selectedTopic?: string;
    };

    const { data, error } = await supabase
      .from("projects")
      .insert({
        user_id:            user.id,
        channel_url:        f.channelUrl        ?? null,
        channel_name:       f.channelName       ?? null,
        channel_analysis:   f.channelAnalysis   ?? null,
        channel_info:       f.channelInfo       ?? null,
        transcripts:        f.transcripts       ?? null,
        visual_profile:     f.visualProfile     ?? null,
        thumbnail_analysis: f.thumbnailAnalysis ?? null,
        video_ideas:        f.videoIdeas        ?? null,
        selected_topic:     f.selectedTopic     ?? null,
        current_state:      6,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  // Enforce niche limit for non-fork project creation
  const isAdmin = user.email === ADMIN_EMAIL;
  if (!isAdmin) {
    const plan = (user.app_metadata?.plan as string) ?? "starter";
    const limit = PLAN_LIMITS[plan] ?? 5;
    if (limit !== null) {
      const { data: existing } = await supabase
        .from("projects")
        .select("channel_name")
        .eq("user_id", user.id)
        .not("channel_name", "is", null);
      const nicheCount = new Set((existing ?? []).map((p) => p.channel_name)).size;
      if (nicheCount >= limit) {
        return NextResponse.json({ error: "Niche limit reached", limitReached: true }, { status: 403 });
      }
    }
  }

  const { data, error } = await supabase
    .from("projects")
    .insert({ user_id: user.id, current_state: 1 })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
