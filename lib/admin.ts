import type { User } from "@supabase/supabase-js";

/**
 * Legacy hardcoded admin emails. Kept as a backstop so the original
 * founder admin keeps working even if Supabase auth metadata gets
 * wiped or the migration to data-driven admin status is rolled back.
 * New admins should be added via the dashboard, which sets
 * app_metadata.is_admin instead of touching this list.
 */
export const ADMIN_EMAILS = new Set(["prioritylearn@gmail.com"]);

export function isAdminEmail(email: string | undefined | null): boolean {
  return !!email && ADMIN_EMAILS.has(email.toLowerCase());
}

/**
 * Single source of truth for "is this user an admin?". Combines:
 *  • Supabase auth app_metadata.is_admin flag (data-driven, set via
 *    the admin dashboard's "Make admin" action so admins can be
 *    promoted without a code change), and
 *  • the legacy ADMIN_EMAILS set (so the original founder admin
 *    never loses access if their app_metadata gets cleared).
 *
 * Pure synchronous function — safe to call from both server and
 * client code. The server-only requireAdmin guard lives in
 * lib/admin-server.ts so client bundles don't drag in the
 * getRequiredUser dependency.
 */
export function isAdminUser(user: User | null | undefined): boolean {
  if (!user) return false;
  if (isAdminEmail(user.email)) return true;
  const flag = (user.app_metadata as { is_admin?: unknown } | undefined)?.is_admin;
  return flag === true;
}
