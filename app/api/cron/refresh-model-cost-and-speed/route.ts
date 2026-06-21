import { NextResponse } from "next/server";
import { refreshModelCostAndSpeed } from "@/lib/costs";

// Daily rollup of project_costs into model_cost_and_speed. The model
// picker reads the materialized table instead of re-aggregating the
// ledger on every page load. Scheduled in vercel.json — protected by
// the standard CRON_SECRET bearer check.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const startedAt = Date.now();
  try {
    const result = await refreshModelCostAndSpeed();
    const elapsed = Date.now() - startedAt;
    console.log(`[refresh-model-cost] upserted=${result.upserted} in ${elapsed}ms`);
    return NextResponse.json({ ok: true, ...result, elapsedMs: elapsed });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : "refresh failed";
    console.error(`[refresh-model-cost] failed after ${elapsed}ms — ${message}`);
    return NextResponse.json({ ok: false, error: message, elapsedMs: elapsed }, { status: 500 });
  }
}
