import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { estimateRun } from "@/lib/credits/estimate";

export const dynamic = "force-dynamic";

// What one generation costs on a model, at the options chosen.
//
// The picker's own badge is a catalog list price and does not move when the
// resolution or the duration does, which is precisely when it stops describing
// what the user is about to pay: an 8 cr/s clip is 48 credits at six seconds,
// and a model priced at 2 credits at 720p is not 2 credits at 4K.
//
// A GET rather than a POST because it is a read the picker repeats on every
// change, and one the browser and SWR may cache freely. Priced by the same
// estimator the run itself is gated on, so the badge and the bill cannot
// disagree.

export async function GET(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const url = new URL(req.url);
  const modelId = (url.searchParams.get("modelId") ?? "").trim();
  if (!modelId) return NextResponse.json({ error: "modelId is required" }, { status: 400 });

  const kind = url.searchParams.get("kind") === "video" ? "video" : "image";
  const operator = (url.searchParams.get("operator") ?? "").trim() || null;
  const resolution = (url.searchParams.get("resolution") ?? "").trim() || null;
  const durationRaw = Number(url.searchParams.get("durationSec"));
  const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;

  try {
    const estimate = await estimateRun({
      userId: user.id, kind, modelId, operator, count: 1, durationSec, resolution,
    });
    // perUnit alone. The balance and the alternative belong to a run, and a
    // price badge that quietly reported the wallet would be a second place for
    // that number to go stale.
    return NextResponse.json({ perUnit: estimate.perUnit, source: estimate.source });
  } catch {
    // An unpriceable model shows its catalog badge rather than an error. The
    // picker must stay usable when the estimator has nothing to say.
    return NextResponse.json({ perUnit: null, source: "unknown" });
  }
}
