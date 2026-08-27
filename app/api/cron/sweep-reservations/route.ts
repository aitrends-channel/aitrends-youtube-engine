import { NextResponse } from "next/server";
import { withCronRun } from "@/lib/cron/runs";
import { sweepStaleHolds } from "@/lib/credits/sweep";

// The hourly, everyone sweep.
//
// The logic and the per-provider windows live in lib/credits/sweep.ts, shared
// with the per-user sweep the workflow pages fire while somebody is actually
// working. That one is what returns credits fast enough for a customer to
// notice; this one is the backstop for accounts nobody is looking at.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return withCronRun("sweep-reservations", async ({ detail }) => {
    let result;
    try {
      result = await sweepStaleHolds();
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "sweep failed" }, { status: 500 });
    }

    if (result.released > 0) {
      console.error(`[cron/sweep-reservations] ${result.released} stale holds, ${result.credits} credits returned`);
    }
    detail(`${result.released} of ${result.found} stale holds released, ${result.credits} credits returned`);
    return NextResponse.json({ ok: true, ...result });
  });
}
