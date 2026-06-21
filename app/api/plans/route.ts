import { NextResponse } from "next/server";
import { getPlans } from "@/lib/plans";

// Public plan list consumed by SubscriptionModal. Returns disabled
// plans too — the modal needs them to render the greyed-out card —
// and the founder plan regardless of slots-left; the modal layers
// the spots-left check separately via /api/founder-spots.

export const dynamic = "force-dynamic";

export async function GET() {
  const plans = await getPlans();
  return NextResponse.json({ plans });
}
