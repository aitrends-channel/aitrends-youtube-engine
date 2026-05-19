import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

const FOUNDER_LIMIT = 100;

export async function GET() {
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    return NextResponse.json({ taken: 0, remaining: FOUNDER_LIMIT, limit: FOUNDER_LIMIT });
  }
  const taken = data.users.filter(u => u.app_metadata?.plan === "founder").length;
  const remaining = Math.max(0, FOUNDER_LIMIT - taken);
  return NextResponse.json({ taken, remaining, limit: FOUNDER_LIMIT }, {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
