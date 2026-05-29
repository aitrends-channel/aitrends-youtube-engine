import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

// Opt out of static prerendering — without this, Next.js renders this
// route at build time and Vercel's edge serves the build-time response
// forever (until the next deploy), so the counter appears frozen.
export const dynamic = "force-dynamic";

// TEST CONFIGURATION — revert to 100 to restore the original cap.
// Migration 019 also caps the DB functions at this number.
const FOUNDER_LIMIT = 1;

export async function GET() {
  // O(1) read from the product_config singleton row — no user list scan.
  const { data, error } = await supabase
    .rpc("get_founder_promo_state")
    .single();

  if (error || !data) {
    // Defensive default: if the DB read fails, claim active=true so a
    // transient error doesn't strip Founder from the UI optimistically.
    return NextResponse.json({ active: true, spots_left: FOUNDER_LIMIT, limit: FOUNDER_LIMIT });
  }

  const row = data as { taken: number; remaining: number; active: boolean };

  // 'active' is the single source of truth. When inactive, spots_left is
  // 0 regardless of the underlying counter — that's the value the UI
  // displays and the value the modals use to decide visibility.
  const spots_left = row.active ? row.remaining : 0;

  return NextResponse.json(
    { active: row.active, spots_left, limit: FOUNDER_LIMIT },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
