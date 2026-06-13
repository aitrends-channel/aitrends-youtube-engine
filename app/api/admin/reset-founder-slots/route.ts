import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";


export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const user = guard.user;

  // Reset the global counter and re-arm the promo flag.
  const { error: cfgError } = await supabase
    .from("product_config")
    .update({ founders_subscriptions_count: 0, founders_promo_active: true })
    .eq("service", "_global");

  if (cfgError) {
    return NextResponse.json({ error: cfgError.message }, { status: 500 });
  }

  // Clear the claims log so old payment_ids don't block re-tests.
  // Supabase's REST API has no TRUNCATE — delete-all via a tautological match.
  const { error: logError } = await supabase
    .from("founder_claims_log")
    .delete()
    .neq("payment_id", "__never_match__");

  if (logError) {
    return NextResponse.json({ error: `Counter reset but log clear failed: ${logError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, taken: 0, active: true });
}
