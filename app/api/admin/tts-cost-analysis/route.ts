import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

// ElevenLabs Creator-plan effective per-char cost (USD). Pulled from
// their public pricing page as the comparison anchor. Adjust if you
// move plans — overage rates differ on Starter / Pro / Scale tiers.
const ELEVENLABS_USD_PER_CHAR = 0.00018;

// Compares KIE-proxied TTS spend against the equivalent ElevenLabs
// direct cost on the same per-beat workload, so we can verify the
// "KIE is cheaper" assumption against actual usage rather than the
// long-chunk math the proxy was originally chosen on.
//
// Sources:
//   • project_costs (step='tts', unit_kind='kie_credits') → credits + task count
//   • project_beats with voiceover_url set                → chars generated
//   • model_cost_and_speed.usd_per_credit                 → KIE USD rate (if seeded)
//
// The char total intentionally counts current script_segment lengths
// of beats with a voiceover_url — a coarse proxy that ignores
// regenerations on the cost side but matches what was actually shipped
// to the user. Good enough for the make-or-revert decision.
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const daysRaw = Number(url.searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, Math.floor(daysRaw)) : 30;
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  // Optional override — model_cost_and_speed doesn't seed a TTS row
  // yet, so passing ?usdPerCredit=0.00015 lets the admin plug in the
  // rate from their KIE invoice and see the comparison immediately.
  const usdPerCreditOverrideRaw = Number(url.searchParams.get("usdPerCredit"));
  const usdPerCreditOverride = Number.isFinite(usdPerCreditOverrideRaw) && usdPerCreditOverrideRaw > 0 ? usdPerCreditOverrideRaw : null;

  const [costsRes, beatsRes, modelRes] = await Promise.all([
    supabase
      .from("project_costs")
      .select("units, created_at")
      .eq("step", "tts")
      .eq("unit_kind", "kie_credits")
      .gte("created_at", sinceIso),
    supabase
      .from("project_beats")
      .select("script_segment, voiceover_url")
      .not("voiceover_url", "is", null),
    supabase
      .from("model_cost_and_speed")
      .select("usd_per_credit")
      .eq("model_name", "elevenlabs/text-to-speech-turbo-2-5")
      .maybeSingle(),
  ]);

  const costRows = (costsRes.data ?? []) as Array<{ units: number }>;
  const beatRows = (beatsRes.data ?? []) as Array<{ script_segment: string | null }>;

  const totalCredits = costRows.reduce((sum, r) => sum + (r.units ?? 0), 0);
  const taskCount = costRows.length;
  const avgCreditsPerTask = taskCount > 0 ? totalCredits / taskCount : 0;

  const totalChars = beatRows.reduce((sum, b) => sum + (b.script_segment?.length ?? 0), 0);
  const beatCount = beatRows.length;
  const avgCharsPerBeat = beatCount > 0 ? totalChars / beatCount : 0;

  const creditsPerChar = totalChars > 0 ? totalCredits / totalChars : null;

  const seededUsdPerCredit = (modelRes.data as { usd_per_credit: number | null } | null)?.usd_per_credit ?? null;
  const usdPerCredit = usdPerCreditOverride ?? seededUsdPerCredit;
  const kieUsd = usdPerCredit !== null ? totalCredits * usdPerCredit : null;
  const elevenlabsUsd = totalChars * ELEVENLABS_USD_PER_CHAR;

  let cheaper: "kie" | "elevenlabs" | "tie" | "unknown" = "unknown";
  if (kieUsd !== null && totalChars > 0) {
    if (kieUsd < elevenlabsUsd * 0.95) cheaper = "kie";
    else if (kieUsd > elevenlabsUsd * 1.05) cheaper = "elevenlabs";
    else cheaper = "tie";
  }

  return NextResponse.json({
    windowDays: days,
    kie: {
      totalCredits,
      taskCount,
      avgCreditsPerTask,
      usdPerCredit,
      totalUsd: kieUsd,
    },
    beats: {
      totalChars,
      beatCount,
      avgCharsPerBeat,
    },
    elevenlabs: {
      usdPerChar: ELEVENLABS_USD_PER_CHAR,
      totalUsd: elevenlabsUsd,
    },
    derived: {
      creditsPerChar,
      cheaper,
      // Positive = KIE costs more than EL would. Null when usd_per_credit
      // isn't seeded yet.
      kieMinusElUsd: kieUsd !== null ? kieUsd - elevenlabsUsd : null,
    },
  });
}
