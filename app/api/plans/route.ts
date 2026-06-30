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
//
// Plans rarely change (admin-edited weekly at most), so we let Vercel
// cache the response edge-side for 30s and serve stale-while-
// revalidate for up to 5 min. The browser also gets the same window.
// Net effect: first modal open of a session is fast (edge hit), and
// subsequent opens are instant (memory cache via SWR in the modal).
// Admin edits propagate within 30s automatically.

export async function GET() {
  const [plans, paymentMode] = await Promise.all([getPlans(), getPaymentMode()]);
  return NextResponse.json(
    { plans, paymentMode },
    {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300",
      },
    },
  );
}
