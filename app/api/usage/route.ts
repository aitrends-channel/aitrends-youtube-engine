export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { isAdminUser } from "@/lib/admin";
import type { User } from "@supabase/supabase-js";

const PLAN_LIMITS: Record<string, number | null> = { founder: 20, starter: 5, pro: null };

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  // isAdminUser covers both the legacy hardcoded founder and any
  // user promoted via the dashboard. Without this, promoted admins
  // would still be subject to their original plan's niche cap.
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

  const { data: settings } = await supabase
    .from("account_settings")
    .select("niches_used, niche_limit_override")
    .eq("user_id", user.id)
    .maybeSingle();

  // Admin-set per-user override takes precedence over the plan default.
  // NULL override means "no override, use the plan limit". Admins are
  // an exception — they always read as unlimited regardless of any
  // lingering override (e.g. a founder-tier grant from before the
  // admin promotion). Letting the override leak through to an admin
  // would make the dashboard show "13/20" instead of unlimited and
  // could falsely trip at_limit gating mid-flow.
  const override = settings?.niche_limit_override ?? null;
  const niche_limit: number | null = isAdmin
    ? null
    : (override !== null ? override : planLimit);
  const niches_used = settings?.niches_used ?? 0;
  const at_limit = niche_limit !== null && niches_used >= niche_limit;

  // Effective plan for display surfaces — same idea as /api/plan.
  // Admins (legacy or promoted) read as "admin" regardless of any
  // stored plan string, so the dashboard subscription pill stays
  // honest even for users promoted before make-admin started
  // writing plan="admin" into app_metadata.
  const effectivePlan = isAdmin ? "admin" : plan;

  return NextResponse.json({
    niches_used,
    niche_limit,
    plan_default_limit: planLimit,
    niche_limit_override: override,
    at_limit,
    plan: effectivePlan,
    is_admin: isAdmin,
    email: user.email ?? null,
  });
}
