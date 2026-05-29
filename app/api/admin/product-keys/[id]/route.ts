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

  const body = await req.json();

  // Toggle active
  if ("active" in body) {
    const { error } = await supabase
      .from("product_config")
      .update({ active: body.active })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // Remove a key by index
  if ("removeKeyIndex" in body) {
    const { data: row } = await supabase
      .from("product_config")
      .select("keys, current_index")
      .eq("id", params.id)
      .single();
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const keys = (row.keys as string[]).filter((_, i) => i !== body.removeKeyIndex);
    const current_index = Math.min(row.current_index, Math.max(0, keys.length - 1));
    const { error } = await supabase
      .from("product_config")
      .update({ keys, current_index })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // Reset current_index to 0
  if ("resetIndex" in body) {
    const { error } = await supabase
      .from("product_config")
      .update({ current_index: 0 })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown operation" }, { status: 400 });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { error } = await supabase
    .from("product_config")
    .delete()
    .eq("id", params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
