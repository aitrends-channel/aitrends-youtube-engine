import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { createHmac } from "crypto";
import { getPaymentSettings } from "@/lib/plans";

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
  const candidateSecrets = [
    settings.webhookSecretTest,
    settings.webhookSecretProduction,
    process.env.DODO_WEBHOOK_SECRET ?? null,
  ].filter((s): s is string => !!s);

  if (candidateSecrets.length === 0) {
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
  const dodoMeta = { event, status: data.status, updated_at: updatedAt };

  const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) {
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }

  const existing = users.find((u) => u.email?.toLowerCase() === email);
  const baseMetadata = existing?.app_metadata ?? {};

  if (event === "payment.succeeded") {
    const metadata = { ...baseMetadata, paid: true, paid_at: updatedAt, dodo: dodoMeta };
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
    const amountCents = Number(data.total_amount ?? data.amount ?? 0);
    const currency = ((data.currency as string | undefined) ?? "usd").toLowerCase();
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
        app_metadata: { ...baseMetadata, paid: false, dodo: dodoMeta },
      });
    }
    return NextResponse.json({ success: true, event });
  }

  return NextResponse.json({ received: true, event });
}
