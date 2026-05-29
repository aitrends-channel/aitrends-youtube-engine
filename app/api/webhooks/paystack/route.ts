import crypto from "crypto";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

function verifyPaystackSignature(secret: string, payload: string, signature: string) {
  const hash = crypto.createHmac("sha512", secret).update(payload).digest("hex");
  return signature === hash;
}

export async function POST(request: Request) {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  const signature = request.headers.get("x-paystack-signature");
  const rawBody = await request.text();

  if (!secret || !signature || !verifyPaystackSignature(secret, rawBody, signature)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: { event?: string; data?: Record<string, unknown> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const event = payload.event ?? "";
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const customer = data.customer as Record<string, string> | undefined;
  const email = ((customer?.email ?? (data.customer_email as string) ?? "")).trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "No email in payload" }, { status: 400 });
  }

  const subscriptionData = data.subscription as Record<string, string> | undefined;
  const subscriptionCode = subscriptionData?.subscription_code ?? (data.subscription_code as string) ?? null;
  const subscriptionStatus = subscriptionData?.status ?? (data.status as string) ?? null;
  const updatedAt = new Date().toISOString();

  const activeEvents = new Set([
    "subscription.create",
    "subscription.activate",
    "subscription.resume",
    "invoice.payment_success",
    "charge.success",
  ]);
  const inactiveEvents = new Set([
    "subscription.disable",
    "subscription.cancel",
    "subscription.expire",
    "invoice.payment_failed",
    "charge.failed",
  ]);

  const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) {
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }

  const existing = users.find((u) => u.email?.toLowerCase() === email);
  const baseMetadata = existing?.app_metadata ?? {};
  const paystackMetadata = { subscription_code: subscriptionCode, status: subscriptionStatus, event, updated_at: updatedAt };

  if (activeEvents.has(event)) {
    const metadata = { ...baseMetadata, paid: true, paid_at: updatedAt, paystack: paystackMetadata };
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

    // Reset niches_used so the user gets a fresh allocation matching
    // their new (or renewed) plan. Covers initial purchase, repurchase,
    // upgrade, and recurring renewal.
    if (userId) {
      await supabase.rpc("reset_niches_used", { uid: userId });
    }

    return NextResponse.json({ success: true, event });
  }

  if (inactiveEvents.has(event)) {
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, {
        app_metadata: { ...baseMetadata, paid: false, paystack: paystackMetadata },
      });
    }
    return NextResponse.json({ success: true, event });
  }

  return NextResponse.json({ received: true, event });
}
