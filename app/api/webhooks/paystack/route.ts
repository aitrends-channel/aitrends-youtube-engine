import crypto from "crypto";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

function verifySignature(secret: string, payload: string, signature: string) {
  const hash = crypto.createHmac("sha512", secret).update(payload).digest("hex");
  return signature === hash;
}

export async function POST(request: Request) {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  const signature = request.headers.get("x-paystack-signature");
  const rawBody = await request.text();

  if (!secret || !signature || !verifySignature(secret, rawBody, signature)) {
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
  const customer = data.customer as Record<string, unknown> | undefined;
  const email = ((customer?.email ?? data.customer_email ?? "") as string).trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: "No email in payload" }, { status: 400 });
  }

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

  if (activeEvents.has(event)) {
    const metadata = {
      ...(existing?.app_metadata ?? {}),
      paid: true,
      paid_at: updatedAt,
    };

    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, { app_metadata: metadata });
    } else {
      const appUrl = process.env.APP_URL ?? new URL(request.url).origin;
      const { data: invite, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${appUrl}/set-password`,
      });

      if (invite?.user) {
        await supabase.auth.admin.updateUserById(invite.user.id, { app_metadata: metadata });
      } else if (inviteError) {
        return NextResponse.json({ error: inviteError.message }, { status: 500 });
      }
    }

    await supabase.from("allowed_emails").upsert({ email });
    return NextResponse.json({ success: true, event });
  }

  if (inactiveEvents.has(event)) {
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, {
        app_metadata: {
          ...(existing.app_metadata ?? {}),
          paid: false,
        },
      });
    }
    return NextResponse.json({ success: true, event });
  }

  return NextResponse.json({ received: true, event });
}
