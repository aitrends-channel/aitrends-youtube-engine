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

  // What the run is actually gated on.
  //
  // An image run does not submit 216 images, it submits a batch at a time and
  // re-checks the wallet before each one, stopping cleanly when the credits run
  // out and reporting the rest. Pricing the whole run at the door therefore
  // refuses runs that would have worked: 432 credits demanded before the first
  // batch of three, worth about 6, could even start. `batched` asks for the
  // figure that decides whether the run may begin.
  const gateCount = body.batched === true
    ? Math.min(count, Math.max(1, (await getConcurrencyConfig()).image_generation_batch))
    : count;

  const estimate = await estimateRun({
    userId: user.id,
    kind,
    modelId,
    operator: typeof body.operator === "string" ? body.operator : null,
    count: gateCount,
    durationSec: Number.isFinite(Number(body.durationSec)) ? Number(body.durationSec) : null,
    resolution: typeof body.resolution === "string" ? body.resolution : null,
  });

  // runCount/runTotal describe the whole run, so a caller can still say what
  // finishing it would cost without that number being what blocks the start.
  return NextResponse.json({
    ...estimate,
    gateCount,
    runCount: count,
    runTotal: estimate.perUnit === null || estimate.perUnit === undefined ? null : estimate.perUnit * count,
  });
}
