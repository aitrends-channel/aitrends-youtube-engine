export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { confirmDodoPayment, purchasedQuantity } from "@/lib/dodo/payment";
import { addHeclusCredits } from "@/lib/heclus-credits";
import { getHeclusPack } from "@/lib/heclus-pack";
import type { User } from "@supabase/supabase-js";

// Credit a Heclus Credits top-up after the customer comes back from Dodo.
//
// Its own route, not a branch of /api/credits/topup: that one grants video
// clips from genai_credits, and one route serving both wallets is how a
// customer ends up paying for credits and receiving clips.
//
// Crediting happens on the verified return rather than on a webhook, for the
// same reason the video wallet and plan access do: production's Dodo webhook
// has never worked, because both signing-secret fields hold the webhook URL. A
// top-up that credited on webhook alone would take the money and hand over
// nothing. The webhook is a backstop, not the path.
//
// Safety rests on two things rather than on trusting the browser:
//
//   1. The payment id from the return URL means nothing until Dodo confirms it
//      succeeded, which confirmDodoPayment does server-side.
//   2. Crediting is idempotent on that payment id, enforced by the unique index
//      on credit_ledger.dodo_payment_id rather than by this route being
//      careful. A refreshed return page, a double-mounted effect and a shared
//      link all collapse to one credit.

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

  // Read the pack BEFORE confirming: with no configured pack size there is no
  // number of credits to grant, and saying so is better than confirming a
  // payment we then cannot honour. getHeclusPack already refuses to hand out a
  // checkout URL in that state, so reaching here means the pack was unset
  // between the click and the return.
  const pack = await getHeclusPack();
  if (pack.credits === null) {
    console.error(`[heclus-credits/topup] payment ${paymentId} arrived with no pack size configured — cannot credit`);
    return NextResponse.json(
      { error: "We could not credit that payment automatically. Contact support with your payment ID, nothing is lost." },
      { status: 500 },
    );
  }

  const confirmed = await confirmDodoPayment(paymentId);
  if ("error" in confirmed) {
    return NextResponse.json({ error: confirmed.error }, { status: confirmed.status });
  }

  // Scales with what was bought: the checkout's quantity is editable, so one
  // payment can cover several packs. Read from the cart, never derived from the
  // amount, because settlement arrives in the buyer's own currency.
  const units = purchasedQuantity(confirmed.raw);
  const credits = pack.credits * units;

  const credited = await addHeclusCredits({
    userId: user.id,
    credits,
    kind: "topup",
    dodoPaymentId: confirmed.paymentId,
    note: units > 1 ? `${credits} credits (${units} packs)` : `${credits} credits`,
  });

  // Not an error: the same payment arriving twice is the expected shape of a
  // refreshed page, and the customer already has the credits.
  if (!credited) {
    return NextResponse.json({ ok: true, alreadyCredited: true, credits });
  }

  // Mirror the video wallet's ledger write so a top-up shows up in revenue
  // alongside subscriptions. Fail-soft and deduped on dodo_payment_id: the
  // customer has their credits regardless, and 23505 means the webhook got
  // there first.
  if (confirmed.amountCents > 0) {
    const { error } = await supabase.from("revenue_events").insert({
      user_id: user.id,
      user_email: (user.email ?? "").toLowerCase() || null,
      event_type: "payment_succeeded",
      amount_cents: confirmed.amountCents,
      currency: confirmed.currency,
      plan: "heclus_credits",
      dodo_payment_id: confirmed.paymentId,
      dodo_raw: confirmed.raw,
      occurred_at: confirmed.createdAt ?? new Date().toISOString(),
    });
    if (error && error.code !== "23505") {
      console.warn("[heclus-credits/topup] revenue_events insert failed:", error.message);
    }
  } else {
    console.warn(`[heclus-credits/topup] credited ${confirmed.paymentId} with no usable amount — no revenue row`);
  }

  return NextResponse.json({ ok: true, credits });
}
