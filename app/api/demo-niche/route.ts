export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { data, error } = await supabase
    .from("account_settings")
    .select("demo_niche_created")
    .eq("user_id", user.id)
    .single();

  if (error && error.code !== "PGRST116") {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ demo_niche_created: data?.demo_niche_created ?? false });
}

export async function POST() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { error } = await supabase
    .from("account_settings")
    .upsert({ user_id: user.id, demo_niche_created: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
