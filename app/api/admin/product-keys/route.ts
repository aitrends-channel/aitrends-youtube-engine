import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";


export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const user = guard.user;

  const { data, error } = await supabase
    .from("product_config")
    .select("id, service, label, keys, current_index, quota_tracking, active, created_at")
    .neq("service", "_global")
    .order("service", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const user = guard.user;

  const { service, key, label } = await req.json();
  if (!service?.trim()) return NextResponse.json({ error: "Service is required" }, { status: 400 });
  if (!key?.trim()) return NextResponse.json({ error: "API key is required" }, { status: 400 });

  const trimmedKey = key.trim();

  // Check if a row already exists for this service
  const { data: existing } = await supabase
    .from("product_config")
    .select("id, keys")
    .eq("service", service.trim())
    .single();

  if (existing) {
    // Append the new key to the existing array
    const updatedKeys = [...((existing.keys as string[]) ?? []), trimmedKey];
    const { data, error } = await supabase
      .from("product_config")
      .update({ keys: updatedKeys })
      .eq("id", existing.id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  // Create a new row for this service
  const { data, error } = await supabase
    .from("product_config")
    .insert({
      service: service.trim(),
      label: label?.trim() || null,
      keys: [trimmedKey],
      current_index: 0,
      active: true,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
