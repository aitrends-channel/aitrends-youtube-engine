import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-server";
import { loadReconciliation, reconcileRates, saveReconciliation } from "@/lib/rates/reconcile";

export const dynamic = "force-dynamic";
// A POST runs the comparison live against both providers.
export const maxDuration = 120;

// The admin view of lib/rates/reconcile.ts.
//
// GET reads the stored report, which the monthly cron writes. POST re-runs it
// now, for when someone has just edited a rate and wants to see whether it
// lands, rather than waiting for the first of the month.

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  return NextResponse.json({ report: await loadReconciliation() });
}

export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const report = await reconcileRates(30);
  await saveReconciliation(report);
  return NextResponse.json({ report });
}
