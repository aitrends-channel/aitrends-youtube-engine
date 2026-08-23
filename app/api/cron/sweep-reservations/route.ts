import { NextResponse } from "next/server";
import { withCronRun } from "@/lib/cron/runs";
import { supabase } from "@/lib/supabase/client";
import { releaseHeclusCredits } from "@/lib/heclus-credits";

// Give back credits held for work that never finished.
//
// Reserving before the work is what stops two submits spending the same
// credits. Its failure mode is the opposite one: a hold whose task died, whose
// webhook never arrived, or whose process was killed between reserving and
// submitting, sits open forever. The balance reads as spent, the credits are in
// `reserved` rather than `credits`, and nothing ever answers for them.
//
// So the hold needs an expiry, and this is it. Anything open longer than any
// plausible generation is released and logged. Logged at error level rather
// than info: a swept reservation is not routine housekeeping, it means a task
// went missing, and the count is the signal for whether the finishers are
// working.
//
// Deliberately generous. The longest thing the wallet pays for is a video
// clip, which can queue at the provider for many minutes, and releasing a hold
// on work that then completes would charge nothing for it. Late is cheap here;
// early is a write-off.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STALE_HOURS = 6;
const MAX_PER_RUN = 200;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return withCronRun("sweep-reservations", async ({ detail }) => {
    const cutoff = new Date(Date.now() - STALE_HOURS * 3_600_000).toISOString();
    const { data, error } = await supabase
      .from("credit_reservations")
      .select("id, user_id, credits, provider, project_id, beat_number, created_at")
      .eq("state", "open")
      .lt("created_at", cutoff)
      .limit(MAX_PER_RUN);

    if (error) {
      console.error("[cron/sweep-reservations] query failed:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const stale = data ?? [];
    let released = 0;
    let credits = 0;

    for (const row of stale as Array<{
      id: string; user_id: string; credits: number | string;
      provider: string | null; project_id: string | null; beat_number: number | null; created_at: string;
    }>) {
      const ok = await releaseHeclusCredits(row.id, `swept after ${STALE_HOURS}h with no result`);
      if (!ok) continue;
      released++;
      credits += Number(row.credits);
      console.error(
        `[cron/sweep-reservations] released ${row.credits} credits held since ${row.created_at} ` +
        `for user=${row.user_id} provider=${row.provider ?? "?"} project=${row.project_id ?? "?"} beat=${row.beat_number ?? "?"}. ` +
        "A hold this old means its task never reported back.",
      );
    }

    if (released > 0) {
      console.error(`[cron/sweep-reservations] ${released} stale holds, ${credits} credits returned`);
    }

    detail(`${released} of ${stale.length} stale holds released, ${credits} credits returned`);
    return NextResponse.json({ ok: true, found: stale.length, released, credits });
  });
}
