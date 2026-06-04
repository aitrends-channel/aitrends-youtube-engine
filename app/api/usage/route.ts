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
  const plan = (user.app_metadata?.plan as string) ?? "demo";
  // Demo cap (1 niche) for registered-but-not-paid users. Use 'in' to
  // distinguish 'pro' (whose limit is legitimately null = unlimited)
  // from an unknown plan name. Plain '?? 1' would incorrectly catch
  // Pro's null and clamp it to the demo cap.
  const planLimit: number | null = isAdmin
    ? null
    : plan in PLAN_LIMITS
      ? PLAN_LIMITS[plan]
      : 1;

  const { data: settings } = await supabase
    .from("account_settings")
    .select("niches_used, niche_limit_override")
    .eq("user_id", user.id)
    .maybeSingle();

  // Admin-set per-user override takes precedence over the plan default.
  // NULL override means "no override, use the plan limit".
  const override = settings?.niche_limit_override ?? null;
  const niche_limit: number | null = override !== null ? override : planLimit;
  const niches_used = settings?.niches_used ?? 0;
  const at_limit = niche_limit !== null && niches_used >= niche_limit;

  return NextResponse.json({
    niches_used,
    niche_limit,
    plan_default_limit: planLimit,
    niche_limit_override: override,
    at_limit,
    plan,
    is_admin: isAdmin,
    email: user.email ?? null,
  });
}
