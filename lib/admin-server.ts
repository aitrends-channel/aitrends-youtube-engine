import "server-only";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { getRequiredUser, getRealUser } from "@/lib/supabase/auth";
import { isAdminUser } from "@/lib/admin";

/**
 * Centralized admin route guard. Use at the top of every /api/admin
 * route:
 *
 *   const guard = await requireAdmin();
 *   if (!guard.ok) return guard.response;
 *   const user = guard.user;
 *
 * Returns either the authenticated admin user, or a Response (401/403)
 * the caller should return directly. Single helper means promoting a
 * user (or fixing an auth bug) lands everywhere at once.
 *
 * Lives in admin-server.ts (not admin.ts) so client bundles importing
 * isAdminUser don't drag in @/lib/supabase/auth's server-only deps.
 */
export async function requireAdmin(opts?: {
  /** Read the real session rather than any acted-as identity. Only the act-as
   *  route itself needs this. */
  ignoreImpersonation?: boolean;
}): Promise<
  { ok: true; user: User } | { ok: false; response: Response }
> {
  let user: User;
  try {
    user = opts?.ignoreImpersonation ? await getRealUser() : await getRequiredUser();
  }
  catch (e) { return { ok: false, response: e as Response }; }
  if (!isAdminUser(user)) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, user };
}
