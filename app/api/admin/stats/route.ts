import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { isAdminUser, isProductionTestUser } from "@/lib/admin";
import { requireAdmin } from "@/lib/admin-server";
import { getPlans } from "@/lib/plans";
import { isProductionEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

const PHASE_LABELS: Record<number, string> = {
  1: "Setup", 2: "Setup", 3: "Setup", 4: "Analyzing", 5: "Analyzing",
  6: "Topic", 7: "Visuals", 8: "Visuals", 9: "Prompts", 10: "Prompts",
  11: "Visuals", 12: "Visuals", 13: "Prompts", 14: "Generate", 15: "Complete",
};

const PHASE_PATHS: Record<number, string> = {
  1: "channel", 2: "channel", 3: "channel", 4: "channel", 5: "channel",
  6: "topic", 7: "visuals", 8: "visuals", 9: "prompts", 10: "prompts",
  11: "visuals", 12: "visuals", 13: "prompts", 14: "generate", 15: "assemble",
};

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const [emailsRes, authUsersRes, projectsRes, settingsRes, plansList, cutoffRes] = await Promise.all([
    supabase.from("allowed_emails").select("email"),
    supabase.auth.admin.listUsers({ perPage: 1000 }),
    // Order DESC so the admin videos table shows most-recent first
    // without any client-side resorting. The daily/monthly
    // aggregation below adds into per-date Map buckets, which is
    // commutative — order doesn't change the chart numbers.
    supabase.from("projects").select("id, user_id, channel_name, current_state, selected_topic, created_at, assembled_url, assembly_started_at, assembly_finished_at").order("created_at", { ascending: false }),
    supabase.from("account_settings").select("user_id, niches_used, niche_limit_override"),
    getPlans(),
    supabase.from("product_config").select("activity_cutoff_at").eq("service", "_global").maybeSingle(),
  ]);

  // Activity-chart cutoff. When set (admin clicks Launch with the
  // Activity "Clear all?" toggle on), the daily/monthly aggregates
  // ignore rows older than this timestamp so the chart starts from
  // launch day. The big-number total cards above the chart still
  // count everything — only the trend chart is sliced.
  const activityCutoffRaw = (cutoffRes.data as { activity_cutoff_at: string | null } | null)?.activity_cutoff_at ?? null;
  const activityCutoffMs = activityCutoffRaw ? new Date(activityCutoffRaw).getTime() : null;
  const afterCutoff = (createdAt: string | null | undefined): boolean => {
    if (activityCutoffMs === null) return true;
    if (!createdAt) return false;
    return new Date(createdAt).getTime() >= activityCutoffMs;
  };

  // Build a slug→limit map once so the per-user loop below is O(1)
  // instead of hitting the plans table for every authenticated user.
  const planLimitBySlug = new Map<string, number | null>();
  for (const p of plansList) planLimitBySlug.set(p.slug, p.nichesPerMonth);
  const starterFallback = planLimitBySlug.has("starter") ? planLimitBySlug.get("starter")! : null;

  const allowedEmails: string[] = (emailsRes.data ?? []).map((r) => r.email as string);
  const authUsers = authUsersRes.data?.users ?? [];
  const projects = projectsRes.data ?? [];

  // If migration 032 hasn't run yet the combined select fails entirely
  // (column doesn't exist) and every user would silently show 0 niches
  // used. Detect that case and retry without the override column so the
  // numerator still renders correctly; overrides just default to null.
  let settingsRows: Array<{ user_id: string; niches_used: number; niche_limit_override: number | null }> = [];
  if (settingsRes.error) {
    console.warn("[admin/stats] account_settings full select failed; falling back to niches_used only", settingsRes.error);
    const fallback = await supabase.from("account_settings").select("user_id, niches_used");
    if (fallback.error) {
      console.error("[admin/stats] account_settings fallback select also failed", fallback.error);
    } else {
      settingsRows = (fallback.data ?? []).map((s) => ({
        user_id: s.user_id as string,
        niches_used: (s.niches_used as number) ?? 0,
        niche_limit_override: null,
      }));
    }
  } else {
    settingsRows = (settingsRes.data ?? []).map((s) => ({
      user_id: s.user_id as string,
      niches_used: (s.niches_used as number) ?? 0,
      niche_limit_override: (s.niche_limit_override as number | null) ?? null,
    }));
  }
  const settingsByUserId = new Map(settingsRows.map((s) => [s.user_id, s]));

  // Build lookup maps
  const emailToAuthUser = new Map(authUsers.map((u) => [u.email?.toLowerCase() ?? "", u]));
  const userIdToEmail = new Map(authUsers.map((u) => [u.id, u.email ?? "Unknown"]));
  const allowedEmailSet = new Set(allowedEmails.map((e) => e.toLowerCase()));

  // Admin self-activity is stripped from aggregates only on the
  // live production deployment (HECLUS_ENV=production). Dev + staging
  // keep admins in the counts so we can verify our own test traffic
  // shows up correctly. Detection happens via lib/env.ts so the
  // env-var name lives in one place.
  const filterAdmins = isProductionEnv();
  const adminUserIds = new Set<string>();
  const adminEmails = new Set<string>();
  if (filterAdmins) {
    for (const u of authUsers) {
      if (isAdminUser(u)) {
        adminUserIds.add(u.id);
        if (u.email) adminEmails.add(u.email.toLowerCase());
      }
    }
  }
  const nonAdminUsers = filterAdmins
    ? authUsers.filter((u) => !adminUserIds.has(u.id))
    : authUsers;
  const nonAdminProjects = filterAdmins
    ? projects.filter((p) => !p.user_id || !adminUserIds.has(p.user_id))
    : projects;

  // Per-user project counts
  const projectCountByUserId = new Map<string, number>();
  for (const p of projects) {
    if (p.user_id) {
      projectCountByUserId.set(p.user_id, (projectCountByUserId.get(p.user_id) ?? 0) + 1);
    }
  }

  const userList = [
    ...authUsers.map((authUser) => {
      const email = authUser.email ?? "Unknown";
      const isPaid = authUser.app_metadata?.paid === true;
      const isAdmin = isAdminUser(authUser);
      const plan = (authUser.app_metadata?.plan as string | undefined) ?? null;
      // Resolved against the plans table. Paid users with an
      // unrecognised plan (Dodo webhook writes paid=true; the verify
      // callback that sets plan may not have fired) get Starter as
      // the safest fallback. Unpaid users with no plan get the demo
      // cap of 1. planLimitBySlug.get returns undefined on miss vs
      // null on a known-unlimited plan, which is what distinguishes
      // the two cases here.
      const planNorm = (plan ?? "").toLowerCase().trim();
      let planDefaultLimit: number | null;
      if (isAdmin) planDefaultLimit = null;
      else if (planLimitBySlug.has(planNorm)) planDefaultLimit = planLimitBySlug.get(planNorm) ?? null;
      else if (isPaid) planDefaultLimit = starterFallback;
      else planDefaultLimit = 1;
      const settings = settingsByUserId.get(authUser.id);
      const override = settings?.niche_limit_override ?? null;
      return {
        email,
        status: isPaid ? "Paid" : "Registered",
        projectCount: projectCountByUserId.get(authUser.id) ?? 0,
        lastSignIn: authUser.last_sign_in_at ?? null,
        plan,
        paidAt: (authUser.app_metadata?.paid_at as string | undefined) ?? null,
        planExpiresAt: (authUser.app_metadata?.plan_expires_at as string | undefined) ?? null,
        nichesUsed: settings?.niches_used ?? 0,
        planDefaultLimit,
        nicheLimitOverride: override,
        effectiveNicheLimit: override !== null ? override : planDefaultLimit,
        // Surface the data-driven admin flag so the dashboard can
        // render the admin role pill and gate the kebab menu's
        // "Make admin" / "Remove" actions without re-deriving it
        // client-side from a hardcoded email list.
        isAdmin,
        // Surface the production-test flag so the users table can
        // mark flagged accounts with a "- PT" suffix on the plan
        // badge.
        isProductionTest: isProductionTestUser(authUser),
      };
    }),
    // Emails in allowed_emails that haven't signed up yet
    ...allowedEmails
      .filter((email) => !emailToAuthUser.has(email.toLowerCase()))
      .map((email) => ({
        email,
        status: "Pending" as const,
        projectCount: 0,
        lastSignIn: null,
        plan: null,
        paidAt: null,
        planExpiresAt: null,
        nichesUsed: 0,
        planDefaultLimit: null,
        nicheLimitOverride: null,
        effectiveNicheLimit: null,
        isAdmin: false,
        isProductionTest: false,
      })),
  ];

  const projectList = projects.map((p) => {
    // assembled_url is the authoritative "complete" signal — once
    // the worker uploads the final MP4 the project is done, even if
    // current_state drifted (re-assemble flows, manual DB edits, or
    // any bug that writes current_state without keeping it in sync
    // with the actual workflow position). Coercing state to 15 here
    // means progress + phaseLabel + the "Complete" badge always
    // agree with each other and with the assembled_url field —
    // fixes the "100% progress · Setup phase" mismatch admins were
    // seeing in the videos table.
    const rawState = p.current_state ?? 1;
    const state = p.assembled_url ? 15 : rawState;
    const userEmail = p.user_id ? (userIdToEmail.get(p.user_id) ?? "Unknown") : "Unknown";
    // Wall-clock assembly duration in seconds, or null when the
    // project hasn't completed an assembly yet (or pre-dates the
    // migration that added the timing columns). Computed here so the
    // admin client doesn't need to do date math on every render.
    const started = p.assembly_started_at as string | null | undefined;
    const finished = p.assembly_finished_at as string | null | undefined;
    let assembleSeconds: number | null = null;
    if (started && finished) {
      const diffMs = new Date(finished).getTime() - new Date(started).getTime();
      if (diffMs > 0 && Number.isFinite(diffMs)) {
        assembleSeconds = Math.round(diffMs / 1000);
      }
    }
    return {
      id: p.id,
      userEmail,
      channelName: p.channel_name ?? null,
      selectedTopic: p.selected_topic ?? null,
      currentState: state,
      phaseLabel: PHASE_LABELS[state] ?? "Setup",
      phasePath: PHASE_PATHS[state] ?? "channel",
      progress: Math.min(100, Math.round((state / 15) * 100)),
      createdAt: p.created_at,
      assembleSeconds,
    };
  });

  const completed = nonAdminProjects.filter((p) => p.assembled_url || (p.current_state ?? 0) >= 15).length;
  const videosInProgress = nonAdminProjects.filter((p) => (p.current_state ?? 1) > 1 && !p.assembled_url && (p.current_state ?? 0) < 15).length;

  // Last 30 days activity
  const activityDates = Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (29 - i));
    return d.toISOString().slice(0, 10);
  });
  const projectsByDay = new Map<string, number>();
  const videosByDay = new Map<string, number>();
  for (const p of nonAdminProjects) {
    if (!p.created_at) continue;
    if (!afterCutoff(p.created_at)) continue;
    const day = new Date(p.created_at).toISOString().slice(0, 10);
    projectsByDay.set(day, (projectsByDay.get(day) ?? 0) + 1);
    if (p.assembled_url || (p.current_state ?? 0) >= 15) videosByDay.set(day, (videosByDay.get(day) ?? 0) + 1);
  }
  const usersByDay = new Map<string, number>();
  for (const u of nonAdminUsers) {
    if (!u.created_at) continue;
    if (!afterCutoff(u.created_at)) continue;
    const day = new Date(u.created_at).toISOString().slice(0, 10);
    usersByDay.set(day, (usersByDay.get(day) ?? 0) + 1);
  }
  const activity = activityDates.map(date => ({
    date,
    projects: projectsByDay.get(date) ?? 0,
    videos: videosByDay.get(date) ?? 0,
    users: usersByDay.get(date) ?? 0,
  }));

  // Monthly activity — last 12 months
  const monthlyDates = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - (11 - i));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const projectsByMonth = new Map<string, number>();
  const videosByMonth = new Map<string, number>();
  for (const p of nonAdminProjects) {
    if (!p.created_at) continue;
    if (!afterCutoff(p.created_at)) continue;
    const month = new Date(p.created_at).toISOString().slice(0, 7);
    projectsByMonth.set(month, (projectsByMonth.get(month) ?? 0) + 1);
    if (p.assembled_url || (p.current_state ?? 0) >= 15) videosByMonth.set(month, (videosByMonth.get(month) ?? 0) + 1);
  }
  const usersByMonth = new Map<string, number>();
  for (const u of nonAdminUsers) {
    if (!u.created_at) continue;
    if (!afterCutoff(u.created_at)) continue;
    const month = new Date(u.created_at).toISOString().slice(0, 7);
    usersByMonth.set(month, (usersByMonth.get(month) ?? 0) + 1);
  }
  const activityMonthly = monthlyDates.map(date => ({
    date,
    projects: projectsByMonth.get(date) ?? 0,
    videos: videosByMonth.get(date) ?? 0,
    users: usersByMonth.get(date) ?? 0,
  }));

  const paidEmails = new Set(
    nonAdminUsers.filter((u) => u.app_metadata?.paid).map((u) => u.email?.toLowerCase() ?? "")
  );
  // accessGranted = unique non-admin emails that either passed the
  // allowlist gate or paid for a plan. allowedEmails entries belonging
  // to admins are filtered out so the count tracks customers only.
  const accessGranted = new Set(
    [
      ...allowedEmails.map((e) => e.toLowerCase()).filter((e) => !adminEmails.has(e)),
      ...paidEmails,
    ]
  ).size;

  return NextResponse.json({
    stats: {
      accessGranted,
      activeAccounts: nonAdminUsers.length,
      totalProjects: nonAdminProjects.length,
      completed,
      videosInProgress,
    },
    activity,
    activityMonthly,
    users: userList,
    projects: projectList,
  });
}
