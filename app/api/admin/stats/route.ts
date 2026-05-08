import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

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

  const [emailsRes, authUsersRes, projectsRes] = await Promise.all([
    supabase.from("allowed_emails").select("email"),
    supabase.auth.admin.listUsers({ perPage: 1000 }),
    supabase.from("projects").select("id, user_id, channel_name, current_state, selected_topic, created_at"),
  ]);

  const allowedEmails: string[] = (emailsRes.data ?? []).map((r) => r.email as string);
  const authUsers = authUsersRes.data?.users ?? [];
  const projects = projectsRes.data ?? [];

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
    // All registered auth users (paid Gumroad customers or manually granted)
    ...authUsers.map((authUser) => {
      const email = authUser.email ?? "Unknown";
      const isPaid = authUser.app_metadata?.paid === true;
      return {
        email,
        status: isPaid ? "Paid" : "Registered",
        projectCount: projectCountByUserId.get(authUser.id) ?? 0,
        lastSignIn: authUser.last_sign_in_at ?? null,
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

  const completed = projects.filter((p) => (p.current_state ?? 0) >= 15).length;

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
    },
    users: userList,
    projects: projectList,
  });
}
