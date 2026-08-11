import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// Returns one of the caller's own saved keys in full, so Setup can show what
// is actually stored rather than only its last four characters. People need
// this to answer "is the value in here the one I think it is", which is
// otherwise unanswerable and is exactly how a truncated or wrong key sits
// undetected for weeks.
//
// Reads account_settings directly, NOT getSettings: that helper falls back to
// the platform ELEVENLABS_API_KEY / KIE_API_KEY when a user has none of their
// own, and handing those out to any signed-in account would leak our
// credentials. No stored key means nothing to reveal.
//
// POST rather than GET so the field name stays out of URLs and request logs,
// and so no cache layer treats the response as fetchable.

const REVEALABLE = ["kie_api_key", "elevenlabs_api_key", "anthropic_api_key"] as const;
type RevealableField = (typeof REVEALABLE)[number];

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await req.json().catch(() => ({})) as { field?: string };
  const field = body.field;
  if (!field || !REVEALABLE.includes(field as RevealableField)) {
    return NextResponse.json({ error: "Unknown field" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("account_settings")
    .select(field)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const value = ((data as Record<string, string | null> | null)?.[field] ?? "").trim();
  return NextResponse.json({ value });
}
