import { NextResponse } from "next/server";
import { getPlans, getPaymentMode } from "@/lib/plans";

// Public plan list consumed by SubscriptionModal. Returns disabled
// plans too — the modal needs them to render the greyed-out card —
// and the founder plan regardless of slots-left; the modal layers
// the spots-left check separately via /api/founder-spots.
//
// paymentMode is included so the modal can surface a "Test mode"
// indicator (and so QA can sanity-check which checkout flavor the
// system is pointed at without opening the admin tab).

export const dynamic = "force-dynamic";

export async function GET() {
  const [plans, paymentMode] = await Promise.all([getPlans(), getPaymentMode()]);
  return NextResponse.json({ plans, paymentMode });
}
