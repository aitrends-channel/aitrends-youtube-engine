export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { isAdminUser } from "@/lib/admin";
import type { User } from "@supabase/supabase-js";

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { data, error } = await supabase
    .from("projects")
    .select("id, created_at, channel_name, channel_url, current_state, selected_topic, assembly_status, assembled_url")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

const PLAN_LIMITS: Record<string, number | null> = { founder: 20, starter: 5, pro: null };

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

  // Enforce niche limit for non-fork project creation.
  // Uses a lifetime counter on account_settings so deletions don't free
  // up slots — preventing users from exploiting deletion to exceed
  // their plan.
  // isAdminUser covers both the legacy hardcoded founder and any
  // user promoted via the dashboard's Make admin action. Promoted
  // admins now skip the per-plan niche limit alongside the founder.
  const isAdmin = isAdminUser(user);
  const plan = (user.app_metadata?.plan as string) ?? "demo";
  const isPaid = user.app_metadata?.paid === true;
  // Lowercase + trim so " Starter " / "STARTER" still resolves against
  // PLAN_LIMITS. Paid users with no recognised plan name (the Dodo
  // webhook writes paid:true but not plan; the verify callback that
  // sets plan may not have fired) get the Starter cap as the safest
  // fallback. Unpaid users with no plan get the demo cap of 1.
  // Use 'in' (not '?? 1') so Pro's legitimate null isn't clamped.
  const planNorm = plan.toLowerCase().trim();
  const planLimit: number | null = isAdmin
    ? null
    : planNorm in PLAN_LIMITS
      ? PLAN_LIMITS[planNorm]
      : isPaid
        ? PLAN_LIMITS.starter
        : 1;

  // Admin-set per-user override takes precedence over the plan default
  // for normal users. Admins (legacy founder + promoted) ignore the
  // override entirely and stay unlimited — a stale founder-tier
  // override left over from before promotion shouldn't be able to cap
  // an admin's project creation.
  const { data: settings } = await supabase
    .from("account_settings")
    .select("niche_limit_override")
    .eq("user_id", user.id)
    .maybeSingle();
  const override = settings?.niche_limit_override ?? null;
  const limit: number | null = isAdmin
    ? null
    : (override !== null ? override : planLimit);

  const { data: rpcData, error: rpcError } = await supabase
    .rpc("try_use_niche", { uid: user.id, plan_limit: limit })
    .single();

  if (rpcError) {
    return NextResponse.json({ error: rpcError.message }, { status: 500 });
  }

  const result = rpcData as { success: boolean; niches_used: number } | null;
  if (!result?.success) {
    return NextResponse.json({
      error: `You've reached your ${limit}-niche lifetime limit. Deleted niches still count toward your plan total — upgrade to add more.`,
      limitReached: true,
      nichesUsed: result?.niches_used ?? 0,
      limit,
      plan,
    }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("projects")
    .insert({ user_id: user.id, current_state: 1 })
    .select()
    .single();

  if (error) {
    // Roll back the counter so we don't lose the slot to a transient DB error.
    await supabase.rpc("decrement_niches_used", { uid: user.id });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
