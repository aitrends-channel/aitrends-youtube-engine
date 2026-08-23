import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { estimateRun } from "@/lib/credits/estimate";

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
  };

  const kind = body.kind === "video" ? "video" : "image";
  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
  const count = Number(body.count);
  if (!modelId) return NextResponse.json({ error: "modelId is required" }, { status: 400 });
  if (!Number.isFinite(count) || count < 1) {
    return NextResponse.json({ error: "count must be 1 or more" }, { status: 400 });
  }

  const estimate = await estimateRun({
    userId: user.id,
    kind,
    modelId,
    operator: typeof body.operator === "string" ? body.operator : null,
    count,
    durationSec: Number.isFinite(Number(body.durationSec)) ? Number(body.durationSec) : null,
    resolution: typeof body.resolution === "string" ? body.resolution : null,
  });

  return NextResponse.json(estimate);
}
