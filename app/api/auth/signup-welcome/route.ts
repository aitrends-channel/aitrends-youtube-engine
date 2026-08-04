import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { shouldSendSignupEmail, sendSignupEmail } from "@/lib/email/welcome";

export const dynamic = "force-dynamic";

// Fired by the set-password page the moment a new account becomes usable —
// the first point at which a signup has actually succeeded. Signup itself
// happens client-side (supabase.auth.updateUser), so there is no server
// step to hang this off; this route is that step.
//
// Self-addressed by construction: it mails the authenticated caller and
// nobody else, so it cannot be used to send mail to an arbitrary address.
// Eligibility is decided server-side from the account's own age and
// stamps, never from anything the caller passes, so a password reset or a
// replayed call cannot produce a welcome.
export async function POST() {
  let user;
  try {
    user = await getRequiredUser();
  } catch (e) {
    return e as Response;
  }

  if (!user.email) {
    return NextResponse.json({ sent: false, reason: "no email on account" });
  }
  if (!shouldSendSignupEmail({ createdAt: user.created_at, appMetadata: user.app_metadata })) {
    return NextResponse.json({ sent: false, reason: "not a new account" });
  }

  try {
    await sendSignupEmail({ userId: user.id, email: user.email, userMetadata: user.user_metadata });
  } catch (e) {
    // Fail-soft for the caller: the account is created and usable, so a
    // mail problem must not read as a signup failure.
    console.error(`[signup-welcome] send failed for ${user.email}:`, e instanceof Error ? e.message : e);
    return NextResponse.json({ sent: false, reason: "send failed" });
  }

  console.log(`[signup-welcome] sent to ${user.email}`);
  return NextResponse.json({ sent: true });
}
