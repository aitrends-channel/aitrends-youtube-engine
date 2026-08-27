import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { isAdminUser } from "@/lib/admin";
import { ACTING_AS_COOKIE } from "@/lib/admin/impersonation";
import { logSystemEvent } from "@/lib/system-logger";

export const dynamic = "force-dynamic";

// Start and stop working inside a customer's account.
//
// requireAdmin reads the REAL session, not the acted-as one, because
// getRequiredUser already swaps the identity everywhere else. Without that an
// admin who started impersonating could not stop: the request to stop would
// arrive as the customer, who is not an admin.

export interface ActingAsStatus {
  actingAs: { id: string; email: string } | null;
}

export async function GET() {
  const guard = await requireAdmin({ ignoreImpersonation: true });
  if (!guard.ok) return NextResponse.json({ actingAs: null } satisfies ActingAsStatus);
  const id = (await cookies()).get(ACTING_AS_COOKIE)?.value;
  if (!id) return NextResponse.json({ actingAs: null } satisfies ActingAsStatus);
  const { data } = await supabase.auth.admin.getUserById(id);
  if (!data?.user) return NextResponse.json({ actingAs: null } satisfies ActingAsStatus);
  return NextResponse.json({
    actingAs: { id: data.user.id, email: data.user.email ?? "" },
  } satisfies ActingAsStatus);
}

export async function POST(req: Request) {
  const guard = await requireAdmin({ ignoreImpersonation: true });
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as { email?: unknown; userId?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
  const userId = typeof body.userId === "string" ? body.userId.trim() : null;
  if (!email && !userId) {
    return NextResponse.json({ error: "email or userId is required" }, { status: 400 });
  }

  let target = null as null | { id: string; email: string };
  if (userId) {
    const { data } = await supabase.auth.admin.getUserById(userId);
    if (data?.user) target = { id: data.user.id, email: data.user.email ?? "" };
    if (data?.user && isAdminUser(data.user)) {
      return NextResponse.json({ error: "That account is an admin. Acting as another admin gains nothing and muddies the audit trail." }, { status: 400 });
    }
  } else {
    const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const found = users.find((u) => u.email?.toLowerCase() === email);
    if (found && isAdminUser(found)) {
      return NextResponse.json({ error: "That account is an admin. Acting as another admin gains nothing and muddies the audit trail." }, { status: 400 });
    }
    if (found) target = { id: found.id, email: found.email ?? "" };
  }
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Recorded because from here every action reads as the customer's, including
  // anything that spends their credits, and "who actually did this" has to be
  // answerable afterwards.
  await logSystemEvent({
    source: "admin",
    level: "warn",
    message: `admin ${guard.user.email} started acting as ${target.email}`,
    userId: target.id,
    metadata: { admin: guard.user.email, target: target.email },
  }).catch(() => undefined);

  (await cookies()).set(ACTING_AS_COOKIE, target.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Short by design. The risk is forgetting: an admin who wanders off and
    // comes back tomorrow should be themselves again, not still spending
    // someone else's credits.
    maxAge: 60 * 60,
  });
  return NextResponse.json({ ok: true, actingAs: target });
}

export async function DELETE() {
  const guard = await requireAdmin({ ignoreImpersonation: true });
  if (!guard.ok) return guard.response;
  (await cookies()).delete(ACTING_AS_COOKIE);
  return NextResponse.json({ ok: true, actingAs: null });
}
