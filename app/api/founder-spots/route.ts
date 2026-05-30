import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

// Opt out of static prerendering — without this, Next.js renders this
// route at build time and Vercel's edge serves the build-time response
// forever (until the next deploy), so the counter appears frozen.
export const dynamic = "force-dynamic";

// Defensive fallback used only when the RPC read itself fails. The
// real cap lives in product_config.founders_promo_limit and is
// returned by get_founder_promo_state — admin-configurable from the
// admin stats card.
const FALLBACK_LIMIT = 100;

export async function GET() {
  // O(1) read from the product_config singleton row — no user list scan.
  const { data, error } = await supabase
    .rpc("get_founder_promo_state")
    .single();

  if (error || !data) {
    // Defensive default: if the DB read fails, claim active=true so a
    // transient error doesn't strip Founder from the UI optimistically.
    return NextResponse.json({ active: true, spots_left: FALLBACK_LIMIT, limit: FALLBACK_LIMIT });
  }

  const row = data as { taken: number; remaining: number; active: boolean; limit?: number };
  // Prefer the explicit `limit` from the RPC (post-migration 025). For
  // older RPCs that only return taken/remaining/active, derive the cap
  // from taken + remaining — they always sum to the configured limit.
  const limit = typeof row.limit === "number"
    ? row.limit
    : (typeof row.taken === "number" && typeof row.remaining === "number"
      ? row.taken + row.remaining
      : FALLBACK_LIMIT);

  // 'active' is the single source of truth. When inactive, spots_left is
  // 0 regardless of the underlying counter — that's the value the UI
  // displays and the value the modals use to decide visibility.
  const spots_left = row.active ? row.remaining : 0;

  // Intentionally no cache headers — admin-edited values (the cap, the
  // counter) need to reflect on the UI immediately after a mutate; a
  // public 60s cache here made the SubscriptionModal / dashboard
  // counter look stale after every change.
  return NextResponse.json({ active: row.active, spots_left, limit });
}
