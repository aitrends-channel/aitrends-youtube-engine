import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { createHmac } from "crypto";

function verifySignature(payload: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return expected === signature;
}

export async function POST(request: Request) {
  const secret = process.env.DODO_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const rawBody = await request.text();
  const sig = request.headers.get("webhook-signature");

  if (!verifySignature(rawBody, sig, secret)) {
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
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, { app_metadata: metadata });
    } else {
      const { origin } = new URL(request.url);
      const appUrl = process.env.APP_URL ?? origin;
      const { data: invite, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${appUrl}/auth/callback?next=/set-password`,
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
