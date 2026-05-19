import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function POST(request: Request) {
  const secret = process.env.FLW_WEBHOOK_SECRET;
  const hash = request.headers.get("verif-hash");

  if (!secret || hash !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: { event?: string; data?: Record<string, unknown> };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const event = payload.event ?? "";
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const customer = data.customer as Record<string, string> | undefined;
  const email = (customer?.email ?? "").trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: "No email in payload" }, { status: 400 });
  }

  const status = data.status as string;
  const updatedAt = new Date().toISOString();
  const flwMeta = { event, status, updated_at: updatedAt };

  const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) {
    return NextResponse.json({ error: listError.message }, { status: 500 });
  }

  const existing = users.find((u) => u.email?.toLowerCase() === email);
  const baseMetadata = existing?.app_metadata ?? {};

  if (event === "charge.completed" && status === "successful") {
    const metadata = { ...baseMetadata, paid: true, paid_at: updatedAt, flutterwave: flwMeta };
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

  if (event === "charge.failed" || status === "failed") {
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, {
        app_metadata: { ...baseMetadata, paid: false, flutterwave: flwMeta },
      });
    }
    return NextResponse.json({ success: true, event });
  }

  return NextResponse.json({ received: true, event });
}
