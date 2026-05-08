import { NextResponse } from "next/server";
import { supabase as serviceClient } from "@/lib/supabase/client";
import { generateTempPassword, sendTempPasswordEmail } from "@/lib/email";

const WEBHOOK_SECRET = process.env.GUMROAD_WEBHOOK_SECRET;

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  if (WEBHOOK_SECRET && searchParams.get("secret") !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Gumroad posts application/x-www-form-urlencoded
  const formData = await request.formData();
  const email = (formData.get("email") as string | null)?.trim().toLowerCase();

  if (!email) {
    return NextResponse.json({ error: "No email in payload" }, { status: 400 });
  }

  const tempPassword = generateTempPassword();

  // Try to create a new user
  const { error: createError } = await serviceClient.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    app_metadata: { paid: true },
    user_metadata: { must_change_password: true },
  });

  if (createError) {
    // User already exists — find and update them with a fresh temp password
    const { data: listData } = await serviceClient.auth.admin.listUsers({ perPage: 1000 });
    const existing = listData?.users.find((u) => u.email?.toLowerCase() === email);
    if (!existing) {
      console.error("[gumroad-webhook] user lookup failed after create error:", createError.message);
      return NextResponse.json({ error: "User lookup failed" }, { status: 500 });
    }
    const { error: updateError } = await serviceClient.auth.admin.updateUserById(existing.id, {
      password: tempPassword,
      app_metadata: { paid: true },
      user_metadata: { must_change_password: true },
    });
    if (updateError) {
      console.error("[gumroad-webhook] update failed:", updateError.message);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
  }

  try {
    await sendTempPasswordEmail(email, tempPassword);
  } catch (err) {
    console.error("[gumroad-webhook] email send failed:", (err as Error).message);
    // Don't fail the webhook — the account was created successfully
  }

  return NextResponse.json({ success: true });
}
