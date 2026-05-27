import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { active } = await req.json();
  const { error } = await supabase
    .from("product_api_keys")
    .update({ active })
    .eq("id", params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { error } = await supabase
    .from("product_api_keys")
    .delete()
    .eq("id", params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
