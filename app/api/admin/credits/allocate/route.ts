import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

// Admin allocation of Heclus Credits to one account.
//
// Two paths, because credits_add only goes one way. A negative p_credits is
// accepted by the RPC and silently ignored: the call returns no error and the
// balance does not move, which is a trap for anything trying to reverse a
// grant. Adding goes through the RPC so the balance change stays atomic and
// the ledger row is written by the same function every top-up uses; removing
// writes the balance and its ledger row here, floored at zero so an admin
// cannot push an account negative by mistyping.

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as {
    userId?: unknown;
    credits?: unknown;
    note?: unknown;
  };

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const amount = Number(body.credits);
  const note = (typeof body.note === "string" ? body.note.trim() : "") || "Admin allocation";

  if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 });
  if (!Number.isFinite(amount) || amount === 0) {
    return NextResponse.json({ error: "Enter a non-zero number of credits" }, { status: 400 });
  }
  // Fractional credits are legitimate (KIE bills 1.7 for an image prompt), but
  // four decimals is what the column stores, so anything finer is not money.
  const credits = Math.round(amount * 10_000) / 10_000;

  const { data: before, error: readErr } = await supabase
    .from("credit_accounts").select("credits").eq("user_id", userId).maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  const current = Number(before?.credits ?? 0);

  if (credits > 0) {
    const { error } = await supabase.rpc("credits_add", {
      p_user: userId,
      p_credits: credits,
      p_note: note,
      // Unique per allocation: the idempotency index on this column is what
      // stops a double-submit granting twice, and a fixed value would make
      // every later allocation a silent no-op.
      p_payment: `admin:${userId}:${Date.now()}`,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const next = Math.max(0, current + credits);
    const applied = next - current; // what actually came off, after the floor
    const { error: uErr } = await supabase
      .from("credit_accounts").update({ credits: next }).eq("user_id", userId);
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
    const { error: lErr } = await supabase.from("credit_ledger").insert({
      user_id: userId, kind: "adjustment", credits: applied, note,
    });
    // The balance is already correct; a missing ledger row is a reporting gap,
    // not a reason to tell the admin the allocation failed.
    if (lErr) console.warn(`[credits/allocate] ledger row failed for ${userId}: ${lErr.message}`);
  }

  const { data: after } = await supabase
    .from("credit_accounts").select("credits, reserved").eq("user_id", userId).maybeSingle();

  return NextResponse.json({
    ok: true,
    before: current,
    credits: Number(after?.credits ?? 0),
    reserved: Number(after?.reserved ?? 0),
  });
}
