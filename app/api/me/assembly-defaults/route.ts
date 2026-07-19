import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// Per-user "Use this always" assembly defaults (background music + logo).
// Saved from the Assemble step so new videos prefill without re-selecting.
export interface AssemblyDefaults {
  // Background music and logo are saved independently — each has its own
  // "Use this always" toggle on the Assemble step.
  bgmEnabled: boolean;
  logoEnabled: boolean;
  backgroundMusicUrl: string | null;
  backgroundMusicVolume: number;
  logoUrl: string | null;
  logoX: number;
  logoY: number;
  logoSize: number;
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { data, error } = await supabase
    .from("account_settings")
    .select("assembly_defaults")
    .eq("user_id", user.id)
    .maybeSingle();
  // 42703 = column missing (migration 099 not applied) — degrade gracefully.
  if (error && error.code !== "42703") {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ defaults: (data?.assembly_defaults as AssemblyDefaults | null) ?? null });
}

export async function PUT(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = (await req.json().catch(() => ({}))) as Partial<AssemblyDefaults>;
  const clamp01 = (n: unknown, dflt: number) => {
    const v = Number(n);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : dflt;
  };
  const defaults: AssemblyDefaults = {
    bgmEnabled: Boolean(body.bgmEnabled),
    logoEnabled: Boolean(body.logoEnabled),
    backgroundMusicUrl: typeof body.backgroundMusicUrl === "string" ? body.backgroundMusicUrl : null,
    backgroundMusicVolume: clamp01(body.backgroundMusicVolume, 0.15),
    logoUrl: typeof body.logoUrl === "string" ? body.logoUrl : null,
    logoX: clamp01(body.logoX, 0.85),
    logoY: clamp01(body.logoY, 0.05),
    logoSize: clamp01(body.logoSize, 0.1),
  };

  // Upsert — the user may not have an account_settings row yet.
  const { error } = await supabase
    .from("account_settings")
    .upsert({ user_id: user.id, assembly_defaults: defaults }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, defaults });
}
