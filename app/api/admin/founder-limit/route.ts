import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as { limit?: number };
  const limit = Number(body.limit);
  if (!Number.isInteger(limit) || limit < 0) {
    return NextResponse.json({ error: "Limit must be a non-negative integer" }, { status: 400 });
  }

  // Pull the current taken count so we can also re-derive the active
  // flag after the cap moves — if the cap drops below taken, the promo
  // should mark itself ended; if it's raised above taken, the promo can
  // re-open without an explicit reset.
  const { data: cur, error: readError } = await supabase
    .from("product_config")
    .select("founders_subscriptions_count")
    .eq("service", "_global")
    .single();

  if (readError || !cur) {
    return NextResponse.json({ error: readError?.message ?? "product_config not found" }, { status: 500 });
  }

  const taken = cur.founders_subscriptions_count ?? 0;
  const active = taken < limit;

  const { error: updateError } = await supabase
    .from("product_config")
    .update({ founders_promo_limit: limit, founders_promo_active: active })
    .eq("service", "_global");

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, limit, taken, active });
}
