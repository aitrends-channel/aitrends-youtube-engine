import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

const FOUNDER_LIMIT = 100;

export async function GET() {
  // O(1) read from the product_config singleton row — no user list scan.
  const { data, error } = await supabase
    .rpc("get_founder_promo_state")
    .single();

  if (error || !data) {
    return NextResponse.json({ taken: 0, remaining: FOUNDER_LIMIT, limit: FOUNDER_LIMIT, active: true });
  }

  const row = data as { taken: number; remaining: number; active: boolean };
  return NextResponse.json(
    { taken: row.taken, remaining: row.remaining, limit: FOUNDER_LIMIT, active: row.active },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
