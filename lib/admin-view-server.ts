import "server-only";
import type { User } from "@supabase/supabase-js";
import { isAdminUser } from "@/lib/admin";
import { ADMIN_PLAN_VIEW_COOKIE, type AdminPlanView } from "@/lib/admin-view";

// The admin's New/Old switch, server side.
//
// It began as a rendering choice and is now a billing one: on "new" an admin is
// treated as an account on Heclus Credits and their generations are metered
// against the wallet; on "old" they are treated as a BYO account and spend
// their own keys. That answer has to be the same in the browser and in the
// route that charges, so the switch writes a cookie as well as localStorage.
//
// Honoured for admins only. A non-admin who forges the cookie gets nothing:
// every caller passes the user, and a non-admin's funding is decided by their
// plan either way. The one thing an admin can do with it is choose which of
// their own two arrangements to be billed under, which is the point of it.

/** The cookie's value, or null outside a request (a worker, a webhook, a cron
 *  tick) where there is no browser to have set one. */
export async function readAdminPlanViewCookie(): Promise<AdminPlanView | null> {
  try {
    const { cookies } = await import("next/headers");
    const v = (await cookies()).get(ADMIN_PLAN_VIEW_COOKIE)?.value;
    return v === "new" || v === "old" ? v : null;
  } catch {
    // No request scope. Not an error: it means nobody is switching anything.
    return null;
  }
}

/** What this user should be treated as, when they are an admin and have chosen.
 *  Null for everyone else, which leaves their real plan to decide. */
export async function adminPlanViewFor(user: User | null | undefined): Promise<AdminPlanView | null> {
  if (!isAdminUser(user)) return null;
  return readAdminPlanViewCookie();
}
