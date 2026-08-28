import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { estimateRun } from "@/lib/credits/estimate";
import { getConcurrencyConfig } from "@/lib/concurrency-config";

export const dynamic = "force-dynamic";

// What will this run cost, and can the wallet cover it?
//
// Called before a bulk run starts so the user is refused up front rather than
// discovering it when the fourth of five images fails. Priced server-side
// because the rates and the balance both live here, and a client that computed
// its own estimate would be a second pricing implementation to keep in step.

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = (await req.json().catch(() => ({}))) as {
    kind?: unknown;
    modelId?: unknown;
    operator?: unknown;
    count?: unknown;
    durationSec?: unknown;
    resolution?: unknown;
    batched?: unknown;
  };

  const kind = body.kind === "video" ? "video" : "image";
  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
  const count = Number(body.count);
  if (!modelId) return NextResponse.json({ error: "modelId is required" }, { status: 400 });
  if (!Number.isFinite(count) || count < 1) {
    return NextResponse.json({ error: "count must be 1 or more" }, { status: 400 });
  }

  // Always priced for the whole run, so the sentence the user reads and the
  // alternative model offered to them are both about the thing they asked for.
  const estimate = await estimateRun({
    userId: user.id,
    kind,
    modelId,
    operator: typeof body.operator === "string" ? body.operator : null,
    count,
    durationSec: Number.isFinite(Number(body.durationSec)) ? Number(body.durationSec) : null,
    resolution: typeof body.resolution === "string" ? body.resolution : null,
  });

  // What the run is gated on, which is a different question from what it costs.
  //
  // An image run does not submit 216 images. It submits a batch at a time and
  // re-checks the wallet before each one, stopping cleanly when the credits run
  // out and reporting the rest. Refusing it on the full total turned away runs
  // that would have worked: 432 credits demanded before the first batch of
  // three, worth about six, could start. So `batched` separates the two —
  // `sufficient` says whether it may begin, `runSufficient` whether it can
  // finish, and a caller that cares about the difference can tell the user how
  // far they will get instead of blocking or staying silent.
  const batchSize = body.batched === true
    ? Math.max(1, (await getConcurrencyConfig()).image_generation_batch)
    : null;
  const gateCount = batchSize ? Math.min(count, batchSize) : count;
  const gateTotal = estimate.perUnit === null ? null : estimate.perUnit * gateCount;
  const gateSufficient = gateTotal === null ? true : gateTotal <= estimate.balance;

  return NextResponse.json({
    ...estimate,
    sufficient: gateSufficient,
    runSufficient: estimate.sufficient,
    gateCount,
    gateTotal,
    runCount: count,
    runTotal: estimate.total,
  });
}
