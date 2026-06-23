import { NextResponse } from "next/server";
import { getPlans, getPaymentSettings } from "@/lib/plans";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/admin";

// Public plan list consumed by SubscriptionModal. Returns disabled
// plans too — the modal needs them to render the greyed-out card —
// and the founder plan regardless of slots-left; the modal layers
// the spots-left check separately via /api/founder-spots.
//
// paymentMode is included so the modal can surface a "Test mode"
// indicator (and so QA can sanity-check which checkout flavor the
// system is pointed at without opening the admin tab).
//
// productionTestLink is included only when the requester is admin —
// the modal turns it into a synthetic 4th "Production test" plan
// invisible to regular customers. Soft auth: anonymous demo / marketing
// callers still get the public plan list, just without the admin link.

export const dynamic = "force-dynamic";

export async function GET() {
  const [plans, settings] = await Promise.all([getPlans(), getPaymentSettings()]);
  let productionTestLink: string | null = null;
  try {
    const client = await createSupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    if (user && isAdminUser(user)) productionTestLink = settings.productionTestLink;
  } catch {
    // Unauthenticated — no admin gate to fail, just no admin link.
  }
  return NextResponse.json({ plans, paymentMode: settings.mode, productionTestLink });
}
