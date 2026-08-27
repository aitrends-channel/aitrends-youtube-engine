import { cookies } from "next/headers";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { isAdminUser } from "@/lib/admin";

// Letting an admin work inside a customer's account.
//
// Every route already answers "is this row yours" with .eq("user_id", user.id),
// in 77 places. Rewriting those to accept an admin override would mean 77
// chances to forget one, and the ones forgotten would be the interesting ones:
// a page that loads but a generate call that 404s.
//
// So the override lives at the identity, not at the checks. While an admin is
// acting as someone, getRequiredUser returns THAT user, and every route behaves
// exactly as it does for the customer, because as far as it can tell it is the
// customer. That is also what makes the feature honest: if their workflow is
// broken for them, it is broken here in the same way.
//
// Consequences to be deliberate about, since "as if it was them" means it:
//   - Their credits are spent, not ours. A generation run here bills their
//     wallet or their KIE key.
//   - Their rows change. Nothing is sandboxed or rolled back.
// The banner exists because both of those are easy to forget mid-session.

export const ACTING_AS_COOKIE = "heclus_acting_as";

/**
 * The user a request should be treated as.
 *
 * The cookie alone grants nothing: the real session is re-checked for admin on
 * every request, so a copied cookie in a customer's browser resolves to
 * themselves. Revoking someone's admin ends any session they left open.
 */
export async function resolveActingUser(realUser: User): Promise<User> {
  let targetId: string | undefined;
  try {
    targetId = (await cookies()).get(ACTING_AS_COOKIE)?.value;
  } catch {
    // No cookie store in this context (a background job, say). Nobody is
    // impersonating there.
    return realUser;
  }
  if (!targetId || targetId === realUser.id) return realUser;
  if (!isAdminUser(realUser)) return realUser;

  try {
    const { data, error } = await supabase.auth.admin.getUserById(targetId);
    if (error || !data?.user) return realUser;
    // Refused rather than allowed: an admin acting as another admin gains
    // nothing and makes an audit trail ambiguous.
    if (isAdminUser(data.user)) return realUser;
    return data.user;
  } catch {
    return realUser;
  }
}

/** Who is really signed in, ignoring any impersonation. For the surfaces that
 *  must not be fooled: the banner, and the audit line on anything destructive. */
export async function actingAsTarget(realUser: User): Promise<{ id: string; email: string } | null> {
  const acting = await resolveActingUser(realUser);
  if (acting.id === realUser.id) return null;
  return { id: acting.id, email: acting.email ?? "" };
}
