import { NextResponse } from "next/server";
import { planSlugForProductId, productIdOnSubscription } from "@/lib/dodo/plan-products";
import { supabase } from "@/lib/supabase/client";
import { createHmac } from "crypto";
import { getPaymentSettings } from "@/lib/plans";
import { shouldWelcome, sendWelcomeEmail } from "@/lib/email/welcome";
import { walletForPayment } from "@/lib/dodo/pack-products";
import { addHeclusCredits } from "@/lib/heclus-credits";
import { getHeclusPack } from "@/lib/heclus-pack";
import { addCredits, CREDIT_PACK } from "@/lib/credits";
import { purchasedQuantity } from "@/lib/dodo/payment";

// Standard Webhooks spec: webhook-id + webhook-timestamp + webhook-signature headers
// signed payload: "{msgId}\n{timestamp}\n{body}", secret is base64-encoded (whsec_ prefix)
function verifySignature(
  payload: string,
  msgId: string | null,
  msgTimestamp: string | null,
  sigHeader: string | null,
  secret: string,
): boolean {
  if (!msgId || !msgTimestamp || !sigHeader) return false;
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedPayload = `${msgId}.${msgTimestamp}.${payload}`;
  const expected = createHmac("sha256", secretBytes).update(signedPayload).digest("base64");
  return sigHeader.split(" ").some((part) => part.split(",")[1] === expected);
}

export async function POST(request: Request) {
  // Try every configured webhook secret in turn — Dodo lets you wire
  // two webhook endpoints (one per env) at the same destination URL,
  // and each has its own signing secret. We can't tell which env the
  // incoming request came from until after we verify it, so we accept
  // any secret that successfully signs the payload. Order: DB-managed
  // values first (test + production, set via the admin "Dodo Variables"
  // card), then the legacy single DODO_WEBHOOK_SECRET env var as a
  // bootstrap fallback.
  const settings = await getPaymentSettings();
  const configured = [
    ["webhookSecretTest", settings.webhookSecretTest],
    ["webhookSecretProduction", settings.webhookSecretProduction],
    ["DODO_WEBHOOK_SECRET", process.env.DODO_WEBHOOK_SECRET ?? null],
  ] as const;

  // A URL pasted into a secret field HMACs to nothing, so every delivery
  // 401s exactly like a forgery would. Name the bad field instead.
  const candidateSecrets: string[] = [];
  for (const [name, value] of configured) {
    if (!value) continue;
    if (/^https?:\/\//i.test(value) || /\s/.test(value)) {
      console.error(`[dodo-webhook] ${name} is a URL, not a signing secret (expected whsec_…) — ignoring it`);
      continue;
    }
    if (!value.startsWith("whsec_")) {
      console.warn(`[dodo-webhook] ${name} has no whsec_ prefix; trying it as a raw base64 secret`);
    }
    candidateSecrets.push(value);
  }

  if (candidateSecrets.length === 0) {
    console.error("[dodo-webhook] no usable whsec_ signing secret configured — rejecting delivery");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const rawBody = await request.text();
  const msgId = request.headers.get("webhook-id");
  const msgTimestamp = request.headers.get("webhook-timestamp");
  const sigHeader = request.headers.get("webhook-signature");

  console.log("[dodo-webhook] msgId:", msgId, "timestamp:", msgTimestamp, "sig:", sigHeader);
  console.log("[dodo-webhook] candidate secrets:", candidateSecrets.length);
  console.log("[dodo-webhook] body:", rawBody.slice(0, 200));

  const verified = candidateSecrets.some((s) => verifySignature(rawBody, msgId, msgTimestamp, sigHeader, s));
  if (!verified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: { type?: string; data?: Record<string, unknown> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const event = payload.type ?? "";
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const customer = data.customer as Record<string, string> | undefined;
  const email = (customer?.email ?? "").trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: "No email in payload" }, { status: 400 });
  }

  const updatedAt = new Date().toISOString();

  // Subscription identifiers Dodo may include on either payment.* or
  // subscription.* events. We persist whichever we can find so the
  // app can later cancel via Dodo's API and proactively warn users
  // before their period ends.
  const subscriptionId =
    (data.subscription_id as string | undefined) ??
    ((data.subscription as Record<string, unknown> | undefined)?.subscription_id as string | undefined) ??
    null;
  // customer_id feeds the "Manage billing" portal URL substitution on
  // the /plan page. Dodo puts it either at the top level or nested
  // under customer depending on the event, so check both.
  const customerId =
    (data.customer_id as string | undefined) ??
    (customer?.customer_id as string | undefined) ??
    null;
  const currentPeriodEnd =
    (data.current_period_end as string | undefined) ??
    (data.next_billing_date as string | undefined) ??
    ((data.subscription as Record<string, unknown> | undefined)?.next_billing_date as string | undefined) ??
    null;

  const dodoMeta = {
    event,
    status: data.status,
    updated_at: updatedAt,
    ...(subscriptionId ? { subscription_id: subscriptionId } : {}),
    ...(customerId ? { customer_id: customerId } : {}),
    ...(currentPeriodEnd ? { current_period_end: currentPeriodEnd } : {}),
  };

  // perPage default is 50 — matches the rest of the codebase, which
  // uses 1000 for email lookups. Without this, once the auth table
  // has >50 users, new paying customers fall off the first page,
  // aren't found here, get routed to the invite branch (which fails
  // because they already exist), and the webhook returns 500. Net
  // effect: metadata never flips to paid, revenue_events row is
  // never written, user shows "paid on Dodo" but not on our side.
  const { data: { users }, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listError) {
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }

  const existing = users.find((u) => u.email?.toLowerCase() === email);
  const baseMetadata = existing?.app_metadata ?? {};

  // Preserve a previously-stored subscription_id when a later event
  // (e.g. payment.succeeded fired without the sub id) would otherwise
  // wipe it. Same idea for period end.
  const baseDodo = (baseMetadata as { dodo?: Record<string, unknown> }).dodo ?? {};
  const mergedDodo = {
    ...baseDodo,
    ...dodoMeta,
    ...(!subscriptionId && baseDodo.subscription_id ? { subscription_id: baseDodo.subscription_id } : {}),
    ...(!customerId && baseDodo.customer_id ? { customer_id: baseDodo.customer_id } : {}),
  };

  // A credit purchase arrives on this same event, and it is NOT a subscription
  // payment: crediting a wallet must not flip app_metadata.paid, extend a plan
  // or send a welcome email. Handled before the plan branch and returning early,
  // so a top-up can never be mistaken for someone buying access.
  //
  // This is a backstop, not the path. Crediting normally happens on the verified
  // return in /api/*-credits/topup, because production's webhook signing secret
  // has never been correct. Both are idempotent on the payment id, so whichever
  // arrives second is a no-op.
  if (event === "payment.succeeded") {
    const wallet = await walletForPayment(data);
    if (wallet) {
      const dodoPaymentId = (data.payment_id ?? data.id) as string | undefined;
      if (!dodoPaymentId) {
        console.warn("[dodo-webhook] credit purchase with no payment id — cannot credit idempotently");
        return NextResponse.json({ success: true, event, credited: false });
      }
      if (!existing) {
        // No account to credit. Deliberately not inviting one: a wallet with no
        // owner is not a thing, and the verified-return path will credit them
        // once they are signed in.
        console.warn(`[dodo-webhook] credit purchase for unknown account ${email} — left for the return path`);
        return NextResponse.json({ success: true, event, credited: false });
      }

      const units = purchasedQuantity(data);
      if (wallet === "heclus") {
        const pack = await getHeclusPack();
        if (pack.credits === null) {
          console.error(`[dodo-webhook] heclus purchase ${dodoPaymentId} with no pack size configured — cannot credit`);
          return NextResponse.json({ success: true, event, credited: false });
        }
        const credits = pack.credits * units;
        const credited = await addHeclusCredits({
          userId: existing.id,
          credits,
          kind: "topup",
          dodoPaymentId,
          note: units > 1 ? `${credits} credits (${units} packs)` : `${credits} credits`,
        });
        console.log(`[dodo-webhook] heclus wallet ${credited ? "credited" : "already credited"} ${credits} for ${email}`);
      } else {
        const credits = CREDIT_PACK.credits * units;
        const credited = await addCredits({
          userId: existing.id,
          credits,
          kind: "topup",
          externalRef: dodoPaymentId,
          note: units > 1 ? `${credits} video credits (${units} packs)` : `${credits} video credits`,
        });
        console.log(`[dodo-webhook] video wallet ${credited ? "credited" : "already credited"} ${credits} for ${email}`);
      }

      // Revenue still gets recorded, labelled as the purchase it was rather
      // than as the customer's plan. Deduped on dodo_payment_id, so the return
      // path having written it first is the expected case.
      const settlement = Number(data.settlement_amount ?? 0);
      const amountCents = settlement > 0 ? settlement : Number(data.total_amount ?? data.amount ?? 0);
      if (amountCents > 0) {
        const { error: revErr } = await supabase.from("revenue_events").insert({
          user_id: existing.id,
          user_email: email,
          event_type: "payment_succeeded",
          amount_cents: amountCents,
          currency: settlement > 0
            ? (((data.settlement_currency as string | undefined) ?? "usd").toLowerCase())
            : (((data.currency as string | undefined) ?? "usd").toLowerCase()),
          plan: wallet === "heclus" ? "heclus_credits" : "credit_pack",
          dodo_payment_id: dodoPaymentId,
          dodo_raw: data,
          occurred_at: updatedAt,
        });
        if (revErr && revErr.code !== "23505") {
          console.warn("[dodo-webhook] revenue_events insert failed:", revErr.message);
        }
      }

      return NextResponse.json({ success: true, event, wallet, credited: true });
    }

    const metadata = {
      ...baseMetadata,
      paid: true,
      paid_at: updatedAt,
      dodo: mergedDodo,
      // Renewal extends plan_expires_at when Dodo tells us the new
      // period end. Keep the existing value if the event didn't carry
      // one (e.g. one-time founder purchase).
      ...(currentPeriodEnd ? { plan_expires_at: currentPeriodEnd } : {}),
    };
    let userId: string | null = null;
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, { app_metadata: metadata });
      userId = existing.id;
    } else {
      const { origin } = new URL(request.url);
      const appUrl = process.env.APP_URL ?? origin;
      const { data: invite, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${appUrl}/auth/callback?next=/set-password`,
      });
      if (invite?.user) {
        await supabase.auth.admin.updateUserById(invite.user.id, { app_metadata: metadata });
        userId = invite.user.id;
      } else if (inviteError) {
        return NextResponse.json({ error: inviteError.message }, { status: 500 });
      }
    }
    await supabase.from("allowed_emails").upsert({ email });

    // Welcome the new subscriber — baseMetadata is the pre-grant copy, so
    // a renewal or upgrade (already paid) and anyone already welcomed by
    // the verify route are both skipped. Fail-soft and awaited, same as
    // the verify path: the customer has paid regardless.
    if (userId && shouldWelcome(baseMetadata as Record<string, unknown>)) {
      try {
        await sendWelcomeEmail({
          userId,
          email,
          userMetadata: existing?.user_metadata,
          plan: (baseMetadata as { plan?: string }).plan ?? null,
        });
        console.log(`[dodo-webhook] welcome email sent to ${email}`);
      } catch (e) {
        console.error(`[dodo-webhook] welcome email failed for ${email}:`, e instanceof Error ? e.message : e);
      }
    }

    // Reset the niches_used counter so the user gets a fresh allocation
    // matching their new (or renewed) plan. Covers initial purchase,
    // repurchase, upgrade, and monthly auto-renewal.
    if (userId) {
      await supabase.rpc("reset_niches_used", { uid: userId });
    }

    // Immutable revenue ledger — survives user deletion so historical
    // revenue stats stay intact. Unique on dodo_payment_id, so Dodo's
    // retry-on-non-2xx replays don't double-count. Fail-soft: a write
    // error here doesn't roll back the user update above — the
    // customer is paid; logging is best-effort.
    const dodoPaymentId = (data.payment_id ?? data.id) as string | undefined;
    // total_amount is in the CUSTOMER'S currency (₹, ₦, ₫, …);
    // settlement_amount is what Dodo actually settles to us in USD.
    // Prefer it so the ledger is single-currency — summing raw
    // total_amounts across currencies was inflating revenue stats
    // (a ₦57k founder purchase counted as $57k).
    const settlement = Number(data.settlement_amount ?? 0);
    const amountCents = settlement > 0 ? settlement : Number(data.total_amount ?? data.amount ?? 0);
    const currency = settlement > 0
      ? (((data.settlement_currency as string | undefined) ?? "usd").toLowerCase())
      : (((data.currency as string | undefined) ?? "usd").toLowerCase());
    if (dodoPaymentId && amountCents > 0) {
      const { error: revErr } = await supabase
        .from("revenue_events")
        .insert({
          user_id: userId,
          user_email: email,
          event_type: "payment_succeeded",
          amount_cents: amountCents,
          currency,
          plan: (baseMetadata as { plan?: string }).plan ?? null,
          dodo_payment_id: dodoPaymentId,
          dodo_raw: data,
          occurred_at: updatedAt,
        });
      // Duplicate (23505) is the expected idempotent-replay case.
      if (revErr && revErr.code !== "23505") {
        console.warn("[dodo-webhook] revenue_events insert failed:", revErr.message);
      }
    }

    return NextResponse.json({ success: true, event });
  }

  if (event === "payment.failed") {
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, {
        app_metadata: { ...baseMetadata, paid: false, dodo: mergedDodo },
      });
    }
    return NextResponse.json({ success: true, event });
  }

  // Which plan the subscription bills as of this event.
  //
  // This is how a scheduled repricing lands. A customer who switched to Heclus
  // Credits keeps their old slug and old price for the rest of the period, then
  // Dodo renews them on the new product and reports it here, so app_metadata.plan
  // becomes heclus_pro on the renewal itself rather than on a date something has
  // to watch for.
  //
  // Null when the product maps to no plan we sell, and the stored slug is then
  // left alone rather than cleared: an unrecognised product must not silently
  // drop a paying customer to the Starter cap.
  const subscriptionSlug =
    event.startsWith("subscription.")
      ? await planSlugForProductId(productIdOnSubscription(data))
      : null;

  // Once the booked change has been applied, the stamp describing it is stale
  // and would keep telling the customer their plan changes on a date that has
  // passed.
  const dodoForSubscription =
    subscriptionSlug && (mergedDodo as Record<string, unknown>).pending_plan === subscriptionSlug
      ? Object.fromEntries(
          Object.entries(mergedDodo).filter(
            ([k]) => k !== "pending_plan" && k !== "pending_plan_effective_at",
          ),
        )
      : mergedDodo;

  // Subscription renewed — same effect as payment.succeeded for our
  // purposes: keep paid, refresh paid_at, extend the period, reset
  // the niches counter. Dodo also fires payment.succeeded on renewal
  // so this branch is mostly defensive; harmless if both arrive.
  if (event === "subscription.renewed" || event === "subscription.active") {
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, {
        app_metadata: {
          ...baseMetadata,
          paid: true,
          paid_at: updatedAt,
          dodo: dodoForSubscription,
          ...(subscriptionSlug ? { plan: subscriptionSlug } : {}),
          ...(currentPeriodEnd ? { plan_expires_at: currentPeriodEnd } : {}),
        },
      });
      await supabase.rpc("reset_niches_used", { uid: existing.id });
    }
    return NextResponse.json({ success: true, event });
  }

  // Plan changed. Fires when a change is applied, including one that was booked
  // for the billing date. Only the slug moves here: the period, the paid flag
  // and the niches counter belong to the renewal that carries it, and an
  // immediate change made from Dodo's dashboard should not silently hand
  // someone a fresh month of niches.
  if (event === "subscription.plan_changed") {
    if (existing && subscriptionSlug) {
      await supabase.auth.admin.updateUserById(existing.id, {
        app_metadata: { ...baseMetadata, plan: subscriptionSlug, dodo: dodoForSubscription },
      });
    }
    return NextResponse.json({ success: true, event });
  }

  // Subscription cancelled — user (or admin) asked Dodo to stop
  // renewing. Keep paid=true so they still have access through the
  // already-paid-for period; just set plan_expires_at to the period
  // end Dodo reports. The app already treats expired plans as
  // gated, so no further app-side work is needed.
  if (event === "subscription.cancelled") {
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, {
        app_metadata: {
          ...baseMetadata,
          dodo: mergedDodo,
          ...(currentPeriodEnd ? { plan_expires_at: currentPeriodEnd } : {}),
        },
      });
    }
    return NextResponse.json({ success: true, event });
  }

  // Subscription expired or fully failed — the customer-facing access
  // window has ended (either the cancelled period ran out or all
  // retry attempts failed). Revoke paid status.
  if (event === "subscription.expired" || event === "subscription.failed") {
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, {
        app_metadata: { ...baseMetadata, paid: false, dodo: mergedDodo },
      });
    }
    return NextResponse.json({ success: true, event });
  }

  // Subscription on hold — payment failed once but Dodo is still
  // retrying. Don't revoke access yet; user might just need their
  // card refreshed. Stash the state for UI surfacing later.
  if (event === "subscription.on_hold") {
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, {
        app_metadata: { ...baseMetadata, dodo: mergedDodo },
      });
    }
    return NextResponse.json({ success: true, event });
  }

  return NextResponse.json({ received: true, event });
}
