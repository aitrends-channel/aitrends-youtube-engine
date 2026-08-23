import { NextResponse } from "next/server";
import { reconcileRates, saveReconciliation } from "@/lib/rates/reconcile";

// Monthly check that the rates we bill at still match what the providers
// invoice. Warn only: it writes a report, never a rate.
//
// Protected by Authorization: Bearer ${CRON_SECRET}, matching finish-images.

export const dynamic = "force-dynamic";
// Four upstream calls, two of them paginated. Comfortably inside this, but a
// slow org endpoint should not take the run down with it.
export const maxDuration = 120;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const report = await reconcileRates(30);
  await saveReconciliation(report);

  // Logged at error level when something moved, so it surfaces in whatever
  // watches the logs rather than only in a panel someone has to open.
  for (const f of report.drifted) {
    console.error(
      `[rates/reconcile] ${f.provider} ${f.model} ${f.kind}: billing $${f.tableUsd.toFixed(2)} ${f.unit}, `
      + `invoiced $${f.actualUsd.toFixed(2)} (${(f.drift * 100).toFixed(0)}%) over ${f.units.toLocaleString()} units`,
    );
  }
  for (const p of report.problems) console.warn(`[rates/reconcile] ${p}`);

  return NextResponse.json({
    ok: true,
    checked: report.findings.length,
    drifted: report.drifted.length,
    problems: report.problems.length,
    report,
  });
}
