import { NextResponse } from "next/server";
import { getPlans, getPaymentMode } from "@/lib/plans";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { canSeeNewPlans, isGatedPlan } from "@/lib/rollout";

// Public plan list consumed by SubscriptionModal. Returns disabled
// plans too — the modal needs them to render the greyed-out card —
// and the founder plan regardless of slots-left; the modal layers
// the spots-left check separately via /api/founder-spots.
//
// paymentMode is included so the modal can surface a "Test mode"
// indicator (and so QA can sanity-check which checkout flavor the
// system is pointed at without opening the admin tab).
//
// NOT edge-cached, because the response now depends on who is asking:
// while NEW_PLANS_ADMIN_ONLY is on, admins get the Heclus cards and
// customers do not. The old headers were
// `public, s-maxage=30, stale-while-revalidate=300`, and a shared
// cache keyed on the URL alone would hand one admin's payload to every
// customer behind it — which is the exact thing the flag exists to
// prevent. Restore the caching when the flag goes, not before.

export const dynamic = "force-dynamic";

export async function GET() {
  const [plans, paymentMode] = await Promise.all([getPlans(), getPaymentMode()]);

  // Anonymous is the norm here: the modal opens on the pricing page for
  // signed-out visitors too. No user means no admin, means the filtered list.
  let user = null;
  try {
    const client = await createSupabaseServerClient();
    user = (await client.auth.getUser()).data.user;
  } catch {
    // An auth lookup that fails must not empty the pricing page. Falling
    // through with a null user shows the customer list, which is the safe
    // direction: the worst case is an admin not seeing their own cards.
  }

  const visible = canSeeNewPlans(user) ? plans : plans.filter((p) => !isGatedPlan(p.slug));

  return NextResponse.json(
    { plans: visible, paymentMode },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
