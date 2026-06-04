import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

const PLAN_LIMITS: Record<string, number | null> = { founder: 20, starter: 5, pro: null };

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
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  if (user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [emailsRes, authUsersRes, projectsRes, settingsRes] = await Promise.all([
    supabase.from("allowed_emails").select("email"),
    supabase.auth.admin.listUsers({ perPage: 1000 }),
    supabase.from("projects").select("id, user_id, channel_name, current_state, selected_topic, created_at, assembled_url").order("created_at", { ascending: true }),
    supabase.from("account_settings").select("user_id, niches_used, niche_limit_override"),
  ]);

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
      const isAdmin = authUser.email === ADMIN_EMAIL;
      const plan = (authUser.app_metadata?.plan as string | undefined) ?? null;
      // Lowercase + trim so " Starter " / "STARTER" still resolves
      // against PLAN_LIMITS instead of slipping through to the demo
      // fallback. Paid users with no recognised plan (the Dodo
      // webhook only writes paid=true; plan is set by the verify
      // callback that may not have fired) get the Starter cap as
      // the safest fallback for someone who actually paid.
      const planNorm = (plan ?? "").toLowerCase().trim();
      const planDefaultLimit: number | null = isAdmin
        ? null
        : planNorm in PLAN_LIMITS
          ? PLAN_LIMITS[planNorm]
          : isPaid
            ? PLAN_LIMITS.starter
            : 1;
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
      })),
  ];

  const projectList = projects.map((p) => {
    const state = p.current_state ?? 1;
    const userEmail = p.user_id ? (userIdToEmail.get(p.user_id) ?? "Unknown") : "Unknown";
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
    };
  });

  const completed = projects.filter((p) => p.assembled_url || (p.current_state ?? 0) >= 15).length;
  const videosInProgress = projects.filter((p) => (p.current_state ?? 1) > 1 && !p.assembled_url && (p.current_state ?? 0) < 15).length;

  // Last 30 days activity
  const activityDates = Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (29 - i));
    return d.toISOString().slice(0, 10);
  });
  const projectsByDay = new Map<string, number>();
  const videosByDay = new Map<string, number>();
  for (const p of projects) {
    if (!p.created_at) continue;
    const day = new Date(p.created_at).toISOString().slice(0, 10);
    projectsByDay.set(day, (projectsByDay.get(day) ?? 0) + 1);
    if (p.assembled_url || (p.current_state ?? 0) >= 15) videosByDay.set(day, (videosByDay.get(day) ?? 0) + 1);
  }
  const usersByDay = new Map<string, number>();
  for (const u of authUsers) {
    if (!u.created_at) continue;
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
  for (const p of projects) {
    if (!p.created_at) continue;
    const month = new Date(p.created_at).toISOString().slice(0, 7);
    projectsByMonth.set(month, (projectsByMonth.get(month) ?? 0) + 1);
    if (p.assembled_url || (p.current_state ?? 0) >= 15) videosByMonth.set(month, (videosByMonth.get(month) ?? 0) + 1);
  }
  const usersByMonth = new Map<string, number>();
  for (const u of authUsers) {
    if (!u.created_at) continue;
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
    authUsers.filter((u) => u.app_metadata?.paid).map((u) => u.email?.toLowerCase() ?? "")
  );
  const accessGranted = new Set([...allowedEmails.map((e) => e.toLowerCase()), ...paidEmails]).size;

  return NextResponse.json({
    stats: {
      accessGranted,
      activeAccounts: authUsers.length,
      totalProjects: projects.length,
      completed,
      videosInProgress,
    },
    activity,
    activityMonthly,
    users: userList,
    projects: projectList,
  });
}
