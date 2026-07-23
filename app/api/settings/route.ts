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
      elevenlabs_api_key: mask(s.elevenlabs_api_key),
      cloudflare_account_id: mask(s.cloudflare_account_id),
      cloudflare_api_token: mask(s.cloudflare_api_token),
      google_tts_key: mask(s.google_tts_key),
      // Not a secret — returned in full so the prompts step can show the
      // inherited account default as a placeholder / prefill.
      character_consistency_text: s.character_consistency_text,
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
      elevenlabs_api_key: string;
      cloudflare_account_id: string;
      cloudflare_api_token: string;
      google_tts_key: string;
      character_consistency_text: string;
    }>;

    const update: Record<string, string> = {};
    if (body.kie_api_key?.trim()) update.kie_api_key = body.kie_api_key.trim();
    if (body.elevenlabs_api_key?.trim()) update.elevenlabs_api_key = body.elevenlabs_api_key.trim();
    if (body.cloudflare_account_id?.trim()) update.cloudflare_account_id = body.cloudflare_account_id.trim();
    if (body.cloudflare_api_token?.trim()) update.cloudflare_api_token = body.cloudflare_api_token.trim();
    if (body.google_tts_key?.trim()) update.google_tts_key = body.google_tts_key.trim();
    // Consistency text is free text, not a secret — persist it whenever
    // the key is present (unlike the API keys above, an empty string is a
    // valid value here: it clears a previously-set default).
    if (body.character_consistency_text !== undefined) update.character_consistency_text = body.character_consistency_text;

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No keys provided" }, { status: 400 });
    }

    // Explicit onConflict so the upsert always merges into the
    // existing row instead of leaning on supabase-js's default
    // primary-key inference. ignoreDuplicates: false ensures the
    // EXCLUDED.<col> values overwrite the existing ones on UPDATE.
    const { data: written, error } = await supabase
      .from("account_settings")
      .upsert(
        { user_id: user.id, ...update },
        { onConflict: "user_id", ignoreDuplicates: false },
      )
      .select("user_id, kie_api_key, elevenlabs_api_key, cloudflare_account_id, cloudflare_api_token, google_tts_key")
      .single();

    if (error) throw new Error(error.message);

    invalidateSettingsCache(user.id);

    // Log what was just persisted (key lengths only — never the key
    // itself) so a "I saved it but it didn't stick" report is
    // diagnosable from Vercel logs without exposing secrets.
    console.log(
      `[settings] user=${user.id} update=${Object.keys(update).join(",")} ` +
        `persisted: kie_api_key.len=${written?.kie_api_key?.length ?? 0} ` +
        `elevenlabs_api_key.len=${written?.elevenlabs_api_key?.length ?? 0} ` +
        `cloudflare_account_id.len=${written?.cloudflare_account_id?.length ?? 0} ` +
        `cloudflare_api_token.len=${written?.cloudflare_api_token?.length ?? 0} ` +
        `google_tts_key.len=${written?.google_tts_key?.length ?? 0}`,
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save settings" }, { status: 500 });
  }
}
