export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { confirmDodoPayment, purchasedQuantity } from "@/lib/dodo/payment";
import { getFreeImagePack } from "@/lib/free-image-pack";
import type { User } from "@supabase/supabase-js";

// Credit a free-image top-up after the customer comes back from Dodo.
//
// Its own route, not a branch of the Heclus or video top-ups. Each of those
// grants a different thing, and one route serving several is how a customer
// ends up paying for images and receiving clips.
//
// Crediting happens on the verified return rather than on a webhook, for the
// same reason every other purchase path here does: production's Dodo webhook
// has never worked, because both signing-secret fields hold the webhook URL.
//
// Safety rests on two things rather than on trusting the browser. The payment
// id from the return URL means nothing until Dodo confirms it succeeded, and
// the grant is idempotent on that id through the unique index on
// free_image_purchases.dodo_payment_id rather than through this route being
// careful. A refreshed page, a double-mounted effect and a shared link all
// collapse to one grant.

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await req.json().catch(() => ({}));
  const paymentId = typeof (body as { payment_id?: unknown }).payment_id === "string"
    ? (body as { payment_id: string }).payment_id.trim()
    : "";
  if (!paymentId) return NextResponse.json({ error: "Missing payment_id" }, { status: 400 });

  // Read the pack BEFORE confirming: with no configured pack size there is no
  // number of images to grant, and saying so beats confirming a payment we
  // then cannot honour.
  const pack = await getFreeImagePack();
  if (pack.images === null) {
    console.error(`[free-images/topup] payment ${paymentId} arrived with no pack size configured — cannot credit`);
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
  const images = Math.round(pack.images * units);

  const { data: granted, error } = await supabase.rpc("grant_free_images", {
    p_user: user.id,
    p_images: images,
    p_payment: confirmed.paymentId,
  });
  if (error) {
    console.error(`[free-images/topup] grant failed for ${confirmed.paymentId}:`, error.message);
    return NextResponse.json(
      { error: "We could not credit that payment automatically. Contact support with your payment ID, nothing is lost." },
      { status: 500 },
    );
  }

  // Not an error: the same payment arriving twice is the expected shape of a
  // refreshed page, and the customer already has the images.
  if (granted !== true) {
    return NextResponse.json({ ok: true, alreadyCredited: true, images });
  }

  // Mirror the other wallets' ledger write so a top-up shows up in revenue
  // alongside subscriptions. Fail-soft and deduped on dodo_payment_id: the
  // customer has their images regardless.
  if (confirmed.amountCents > 0) {
    const { error: revErr } = await supabase.from("revenue_events").insert({
      user_id: user.id,
      user_email: (user.email ?? "").toLowerCase() || null,
      event_type: "payment_succeeded",
      amount_cents: confirmed.amountCents,
      currency: confirmed.currency,
      plan: "heclus_free_image_top",
      dodo_payment_id: confirmed.paymentId,
      dodo_raw: confirmed.raw,
    });
    if (revErr && revErr.code !== "23505") {
      console.warn("[free-images/topup] revenue row failed:", revErr.message);
    }
  }

  return NextResponse.json({ ok: true, images });
}
