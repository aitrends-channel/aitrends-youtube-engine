export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

const PLAN_LIMITS: Record<string, number | null> = { founder: 20, starter: 5, pro: null };
const ADMIN_EMAIL = "prioritylearn@gmail.com";

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const isAdmin = user.email === ADMIN_EMAIL;
  const plan = (user.app_metadata?.plan as string) ?? "starter";
  const niche_limit = isAdmin ? null : (PLAN_LIMITS[plan] ?? 5);

  const { data: settings } = await supabase
    .from("app_settings")
    .select("niches_used")
    .eq("user_id", user.id)
    .maybeSingle();

  const niches_used = settings?.niches_used ?? 0;
  const at_limit = niche_limit !== null && niches_used >= niche_limit;

  return NextResponse.json({
    niches_used,
    niche_limit,
    at_limit,
    plan,
    is_admin: isAdmin,
    email: user.email ?? null,
  });
}
