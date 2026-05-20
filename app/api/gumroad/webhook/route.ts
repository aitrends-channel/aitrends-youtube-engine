import { NextResponse } from "next/server";
import { supabase as serviceClient } from "@/lib/supabase/client";
import { sendInviteEmail } from "@/lib/email";

const WEBHOOK_SECRET = process.env.GUMROAD_WEBHOOK_SECRET;

const PERMALINK_TO_PLAN: Record<string, string> = {
  [process.env.NEXT_PUBLIC_GUMROAD_PRODUCT_FOUNDER ?? "svxbq"]:  "founder",
  [process.env.NEXT_PUBLIC_GUMROAD_PRODUCT_STARTER ?? "ipntsc"]: "starter",
  [process.env.NEXT_PUBLIC_GUMROAD_PRODUCT_PRO     ?? "htvrim"]: "pro",
};

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  if (WEBHOOK_SECRET && searchParams.get("secret") !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const email = (formData.get("email") as string | null)?.trim().toLowerCase();
  const permalink = (formData.get("short_product_id") as string | null) ?? (formData.get("permalink") as string | null) ?? "";

  if (!email) {
    return NextResponse.json({ error: "No email in payload" }, { status: 400 });
  }

  const plan = PERMALINK_TO_PLAN[permalink] ?? "starter";
  const isFounder = plan === "founder";
  const now = new Date().toISOString();
  const planExpiry = isFounder ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() : null;

  const metadata = {
    paid: true,
    paid_at: now,
    plan,
    ...(isFounder && { plan_expires_at: planExpiry }),
  };

  const { data: listData } = await serviceClient.auth.admin.listUsers({ perPage: 1000 });
  const existing = listData?.users.find((u) => u.email?.toLowerCase() === email);

  if (existing) {
    await serviceClient.auth.admin.updateUserById(existing.id, {
      app_metadata: { ...existing.app_metadata, ...metadata },
    });
  } else {
    const { origin } = new URL(request.url);
    const appUrl = process.env.APP_URL ?? origin;
    const { data: invite, error: inviteError } = await serviceClient.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${appUrl}/auth/callback?next=/set-password`,
    });
    if (invite?.user) {
      await serviceClient.auth.admin.updateUserById(invite.user.id, { app_metadata: metadata });
      try { await sendInviteEmail(email, invite.user.id); } catch {}
    } else if (inviteError) {
      return NextResponse.json({ error: inviteError.message }, { status: 500 });
    }
  }

  await serviceClient.from("allowed_emails").upsert({ email });
  return NextResponse.json({ success: true, plan });
}
