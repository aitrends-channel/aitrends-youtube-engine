import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { getFundingMode, type FundingMode } from "@/lib/funding";
import { billingPlanOf } from "@/lib/plans-gating";
import { isHeclusCreditsPlan } from "@/lib/plan-tier";

export const dynamic = "force-dynamic";

// Reports whether the current user has personally set their own KIE
// and ElevenLabs keys in account_settings. Different from
// /api/api-status, which treats the platform env-var fallback as
// "configured" — that's fine for the live balance check but the wrong
// signal for the dashboard's pre-niche gate, where the goal is
// confirming each paid user has brought their own keys before
// burning project resources against shared / platform credentials.
//
// Since wallet funding, "has brought their own keys" is no longer the same
// question as "can generate": a wallet user is meant to have no keys at all.
// readyToGenerate is the one to gate on; kieSet and elevenlabsSet stay for the
// surfaces that genuinely ask about the keys themselves.

export interface ApiKeysStatus {
  kieSet: boolean;
  elevenlabsSet: boolean;
  bothSet: boolean;
  /** Whose provider account pays. A wallet user has nothing to bring, so every
   *  surface that nags for keys has to ask this before nagging. */
  fundingMode: FundingMode;
  /** True when the account can generate without setting a single key. Named for
   *  what the caller actually wants to know, so no surface has to reimplement
   *  "wallet OR both keys" and get it subtly different. */
  readyToGenerate: boolean;
  /** On one of the Heclus Credits products, where provider keys are not part of
   *  the deal at all. Distinct from fundingMode, which a customer can flip: this
   *  is what they bought. */
  onHeclusCreditsPlan: boolean;
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { data } = await supabase
    .from("account_settings")
    .select("kie_api_key, elevenlabs_api_key")
    .eq("user_id", user.id)
    .maybeSingle();

  const row = data as {
    kie_api_key: string | null;
    elevenlabs_api_key: string | null;
  } | null;
  const kieSet = !!row?.kie_api_key?.trim();
  const elevenlabsSet = !!row?.elevenlabs_api_key?.trim();
  const fundingMode = await getFundingMode(user);
  const bothSet = kieSet && elevenlabsSet;
  return NextResponse.json({
    kieSet,
    elevenlabsSet,
    bothSet,
    fundingMode,
    readyToGenerate: fundingMode === "wallet" || bothSet,
    onHeclusCreditsPlan: isHeclusCreditsPlan(billingPlanOf(user)),
  } satisfies ApiKeysStatus);
}
