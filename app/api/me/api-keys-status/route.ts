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
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { data } = await supabase
    .from("account_settings")
    .select("kie_api_key, elevenlabs_api_key")
    .eq("user_id", user.id)
    .maybeSingle();

  const row = data as { kie_api_key: string | null; elevenlabs_api_key: string | null } | null;
  const kieSet = !!row?.kie_api_key?.trim();
  const elevenlabsSet = !!row?.elevenlabs_api_key?.trim();
  return NextResponse.json({
    kieSet,
    elevenlabsSet,
    bothSet: kieSet && elevenlabsSet,
  } satisfies ApiKeysStatus);
}
