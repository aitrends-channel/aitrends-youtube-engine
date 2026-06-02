import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = "prioritylearn@gmail.com";
const VALID = new Set(["client_kie", "heclus_kie", "heclus_direct"]);

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("product_config")
    .select("anthropic_routing")
    .eq("service", "_global")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ routing: data?.anthropic_routing ?? "client_kie" });
}

export async function PUT(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { routing?: string };
  const routing = body.routing;
  if (!routing || !VALID.has(routing)) {
    return NextResponse.json({ error: "routing must be one of: client_kie, heclus_kie, heclus_direct" }, { status: 400 });
  }

  const { error } = await supabase
    .from("product_config")
    .update({ anthropic_routing: routing })
    .eq("service", "_global");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, routing });
}
