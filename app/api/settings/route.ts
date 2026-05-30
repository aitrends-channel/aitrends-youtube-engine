export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getSettings, invalidateSettingsCache } from "@/lib/settings";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return "•".repeat(Math.min(value.length - 4, 24)) + value.slice(-4);
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const s = await getSettings(user.id);
    return NextResponse.json({
      kie_api_key: mask(s.kie_api_key),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load settings" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const body = await req.json() as Partial<{
      kie_api_key: string;
    }>;

    const update: Record<string, string> = {};
    if (body.kie_api_key?.trim()) update.kie_api_key = body.kie_api_key.trim();

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No keys provided" }, { status: 400 });
    }

    const { error } = await supabase
      .from("app_settings")
      .upsert({ user_id: user.id, ...update });

    if (error) throw new Error(error.message);

    invalidateSettingsCache(user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save settings" }, { status: 500 });
  }
}
