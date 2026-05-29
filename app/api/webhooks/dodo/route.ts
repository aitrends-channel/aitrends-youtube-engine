import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { createHmac } from "crypto";

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
  const secret = process.env.DODO_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const rawBody = await request.text();
  const msgId = request.headers.get("webhook-id");
  const msgTimestamp = request.headers.get("webhook-timestamp");
  const sigHeader = request.headers.get("webhook-signature");

  console.log("[dodo-webhook] msgId:", msgId, "timestamp:", msgTimestamp, "sig:", sigHeader);
  console.log("[dodo-webhook] secret prefix:", secret.slice(0, 10));
  console.log("[dodo-webhook] body:", rawBody.slice(0, 200));

  if (!verifySignature(rawBody, msgId, msgTimestamp, sigHeader, secret)) {
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
