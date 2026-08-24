import { NextResponse } from "next/server";
import { withCronRun } from "@/lib/cron/runs";
import { snapshotProviderBalances } from "@/lib/providers/drawdown";

// Record what KIE and PoYo say is left in their accounts.
//
// Two reads and an insert, hourly. Cheap on purpose: the value is in the series,
// not in any one row, and a series only exists if this has been running for a
// while before anyone asks it a question. See lib/providers/drawdown.ts for what
// the series answers.
//
// Protected by Authorization: Bearer ${CRON_SECRET}, matching the other crons.

export const dynamic = "force-dynamic";
// Both providers time out at 10s on their own, so this is slack rather than a
// budget.
export const maxDuration = 60;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return withCronRun("snapshot-provider-balances", async ({ detail }) => {
    const { stored, problems } = await snapshotProviderBalances();

    // A provider that cannot be read is a gap in the series, which weakens
    // every later comparison, so it is worth a warning rather than silence.
    for (const p of problems) console.warn(`[provider-balances] ${p}`);

    detail(problems.length ? `${stored} stored, ${problems.length} unreadable` : `${stored} stored`);
    return NextResponse.json({ ok: true, stored, problems });
  });
}
