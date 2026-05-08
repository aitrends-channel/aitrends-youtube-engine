import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { generateTempPassword, sendTempPasswordEmail } from "@/lib/email";

export async function POST(request: Request) {
  try { await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await request.json();
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "Email required" }, { status: 400 });

  const { error: upsertError } = await supabase.from("allowed_emails").upsert({ email });
  if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });

  const tempPassword = generateTempPassword();

  // Try to create a new user
  const { error: createError } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { must_change_password: true },
  });

  if (createError) {
    // User already exists — reset their temp password so they can log in
    const { data: listData } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const existing = listData?.users.find((u) => u.email?.toLowerCase() === email);
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, {
        password: tempPassword,
        user_metadata: { must_change_password: true },
      });
    }
  }

  try {
    await sendTempPasswordEmail(email, tempPassword);
  } catch (err) {
    console.error("[add-user] email send failed:", (err as Error).message);
  }

  return NextResponse.json({ success: true });
}
