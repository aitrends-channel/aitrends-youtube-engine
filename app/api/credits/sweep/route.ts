import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { sweepStaleHolds } from "@/lib/credits/sweep";

export const dynamic = "force-dynamic";

// Reclaim the caller's own abandoned holds.
//
// The hourly cron is the backstop, and on its own it is not fast enough to be
// believed: a hold taken at 18 past becomes stale at 1:18 and is not looked at
// until 2:17, so the honest promise was "within two hours". A customer working
// through a project watches that balance, and it is the number that decides
// whether they can start the next step.
//
// So the workflow pages call this every five minutes while somebody is there.
// Scoped to the signed-in user: an account may reclaim what is stuck in its own
// wallet and nothing else. The windows are the same ones the cron uses, so this
// releases nothing the cron would not have released later.

export async function POST() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const result = await sweepStaleHolds({ userId: user.id });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // Housekeeping, called on a timer. A failure is worth a log and nothing
    // else: the cron will get to it, and the page must not show an error for
    // something the user did not ask for.
    console.warn("[credits/sweep] failed for user", user.id, e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, found: 0, released: 0, credits: 0 });
  }
}
