export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { confirmDodoPayment, purchasedQuantity } from "@/lib/dodo/payment";
import { addCredits, CREDIT_PACK } from "@/lib/credits";
import type { User } from "@supabase/supabase-js";

// Credit a top-up after the customer comes back from Dodo.
//
// This crediting deliberately happens on the verified return rather than on a
// webhook. Production's Dodo webhook has never worked — both signing-secret
// fields hold the webhook URL — and plan access is granted by the same
// verified-return path for the same reason. A top-up that credited on webhook
// would take the customer's money and never hand over the credits.
//
// Safety rests on two things, not on trusting the browser:
//
//   1. The payment id from the return URL means nothing until Dodo confirms it
//      succeeded, which confirmDodoPayment does server-side.
//   2. Crediting is idempotent on that payment id, enforced by a unique index
//      rather than by this route being careful. A refreshed return page, a
//      double-mounted effect and a shared link all collapse to one credit.

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await req.json().catch(() => ({}));
  const paymentId = typeof (body as { payment_id?: unknown }).payment_id === "string"
    ? (body as { payment_id: string }).payment_id.trim()
    : "";
  if (!paymentId) {
    return NextResponse.json({ error: "Missing payment_id" }, { status: 400 });
  }

  const confirmed = await confirmDodoPayment(paymentId);
  if ("error" in confirmed) {
    return NextResponse.json({ error: confirmed.error }, { status: confirmed.status });
  }

  // Scales with what was bought: the checkout's quantity is editable, so one
  // payment can cover several packs.
  const units = purchasedQuantity(confirmed.raw);
  const credits = CREDIT_PACK.credits * units;

  const credited = await addCredits({
    userId: user.id,
    credits,
    kind: "topup",
    externalRef: confirmed.paymentId,
    note: units > 1 ? `${credits} video credits (${units} packs)` : `${credits} video credits`,
  });

  // Not an error: the same payment arriving twice is the expected shape of a
  // refreshed page, and the customer already has the credits.
  if (!credited) {
    return NextResponse.json({ ok: true, alreadyCredited: true, credits });
  }

  // Mirror the plan route's ledger write so a top-up shows up in revenue
  // alongside subscriptions. Fail-soft and deduped on dodo_payment_id: the
  // customer has their credits regardless, and 23505 means the webhook (if it
  // ever starts working) got there first.
  if (confirmed.amountCents > 0) {
    const { error } = await supabase.from("revenue_events").insert({
      user_id: user.id,
      user_email: (user.email ?? "").toLowerCase() || null,
      event_type: "payment_succeeded",
      amount_cents: confirmed.amountCents,
      currency: confirmed.currency,
      plan: "credit_pack",
      dodo_payment_id: confirmed.paymentId,
      dodo_raw: confirmed.raw,
      occurred_at: confirmed.createdAt ?? new Date().toISOString(),
    });
    if (error && error.code !== "23505") {
      console.warn("[credits/topup] revenue_events insert failed:", error.message);
    }
  } else {
    console.warn(`[credits/topup] credited ${confirmed.paymentId} with no usable amount — no revenue row`);
  }

  return NextResponse.json({ ok: true, credits });
}
