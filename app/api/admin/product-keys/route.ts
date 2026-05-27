import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("product_api_keys")
    .select("id, service, label, keys, current_index, quota_tracking, active, created_at")
    .order("service", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { service, key, label } = await req.json();
  if (!service?.trim()) return NextResponse.json({ error: "Service is required" }, { status: 400 });
  if (!key?.trim()) return NextResponse.json({ error: "API key is required" }, { status: 400 });

  const trimmedKey = key.trim();

  // Check if a row already exists for this service
  const { data: existing } = await supabase
    .from("product_api_keys")
    .select("id, keys")
    .eq("service", service.trim())
    .single();

  if (existing) {
    // Append the new key to the existing array
    const updatedKeys = [...((existing.keys as string[]) ?? []), trimmedKey];
    const { data, error } = await supabase
      .from("product_api_keys")
      .update({ keys: updatedKeys })
      .eq("id", existing.id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  // Create a new row for this service
  const { data, error } = await supabase
    .from("product_api_keys")
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
