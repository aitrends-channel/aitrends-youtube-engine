export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { isAdminUser } from "@/lib/admin";
import { invalidateFundingCache } from "@/lib/funding";
import type { User } from "@supabase/supabase-js";

// The funding half of the admin's New/Old switch.
//
// Deliberately not /api/me/funding, which is the customer's path: that one
// books a Dodo plan change before it writes the mode, so a switch to wallet on
// an account with a heclus plan would schedule a real repricing. Right for a
// customer choosing how to pay, wrong for a dev affordance that exists to look
// at the other half of the product.
//
// Admin-only, and the check is here rather than taken from the caller. The
// browser-held view in lib/admin-view.ts is still never trusted by the server:
// this is an authenticated request to change the caller's own funding mode,
// authorised server-side, which is the same thing the funding card does.

export async function PUT(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { mode?: unknown };
  const mode = body.mode === "wallet" || body.mode === "byo" ? body.mode : null;
  if (!mode) {
    return NextResponse.json({ error: "mode must be wallet or byo" }, { status: 400 });
  }

  // Upsert for the same reason the funding route does it: an account that has
  // never saved a setting has no row, and naming user_id as the conflict target
  // keeps this from creating a second one.
  const { error } = await supabase
    .from("account_settings")
    .upsert({ user_id: user.id, funding_mode: mode }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // The mode is cached for a minute at every choke point that spends money, so
  // without this the switch appears to do nothing for up to a minute.
  invalidateFundingCache(user.id);
  return NextResponse.json({ ok: true, mode });
}
