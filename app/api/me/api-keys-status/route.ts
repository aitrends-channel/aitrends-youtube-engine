import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// Reports whether the current user has personally set their own KIE
// and ElevenLabs keys in account_settings. Different from
// /api/api-status, which treats the platform env-var fallback as
// "configured" — that's fine for the live balance check but the wrong
// signal for the dashboard's pre-niche gate, where the goal is
// confirming each paid user has brought their own keys before
// burning project resources against shared / platform credentials.

export interface ApiKeysStatus {
  kieSet: boolean;
  elevenlabsSet: boolean;
  bothSet: boolean;
  // Free-tier BYO keys — used to gate the "Free" tabs until the user has
  // connected their own Cloudflare (free images) / Google Cloud TTS
  // (free voiceover) credentials.
  cloudflareSet: boolean;
  googleTtsSet: boolean;
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { data } = await supabase
    .from("account_settings")
    .select("kie_api_key, elevenlabs_api_key, cloudflare_account_id, cloudflare_api_token, google_tts_key")
    .eq("user_id", user.id)
    .maybeSingle();

  const row = data as {
    kie_api_key: string | null;
    elevenlabs_api_key: string | null;
    cloudflare_account_id: string | null;
    cloudflare_api_token: string | null;
    google_tts_key: string | null;
  } | null;
  const kieSet = !!row?.kie_api_key?.trim();
  const elevenlabsSet = !!row?.elevenlabs_api_key?.trim();
  // Free images need BOTH Cloudflare values (account id + token).
  const cloudflareSet = !!row?.cloudflare_account_id?.trim() && !!row?.cloudflare_api_token?.trim();
  const googleTtsSet = !!row?.google_tts_key?.trim();
  return NextResponse.json({
    kieSet,
    elevenlabsSet,
    bothSet: kieSet && elevenlabsSet,
    cloudflareSet,
    googleTtsSet,
  } satisfies ApiKeysStatus);
}
