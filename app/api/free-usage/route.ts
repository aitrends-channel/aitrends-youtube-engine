export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getFreeUsageToday, getFreeUsageThisMonth, FREE_IMAGE_DAILY_CAP, FREE_TTS_MONTHLY_CAP } from "@/lib/freeUsage";
import { qwenCapForPlan } from "@/lib/replicate/tts";
import { ai33CapForPlan } from "@/lib/ai33/tts";
import { planSlugOf } from "@/lib/plans-gating";
import { isAdminUser } from "@/lib/admin";
import type { User } from "@supabase/supabase-js";

// Powers the "Free" tab usage bars. Returns the signed-in user's free-image
// count for today (daily Cloudflare quota) and free Google-TTS chars for the
// current month (monthly 1M quota), each against its cap.
export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const [image, ttsChars, qwenTtsChars, ai33TtsChars] = await Promise.all([
    getFreeUsageToday(user.id, "image"),
    getFreeUsageThisMonth(user.id, "tts_chars"),
    getFreeUsageThisMonth(user.id, "qwen_tts_chars"),
    getFreeUsageThisMonth(user.id, "ai33_tts_chars"),
  ]);
  return NextResponse.json({
    image,
    imageCap: FREE_IMAGE_DAILY_CAP,
    ttsChars,
    ttsCap: FREE_TTS_MONTHLY_CAP,
    qwenTtsChars,
    // Plan-tiered: 0 = Qwen not available on this plan (founder).
    qwenTtsCap: qwenCapForPlan(planSlugOf(user), isAdminUser(user)),
    ai33TtsChars,
    // Plan-tiered: 0 = ai33 not available on this plan (founder).
    ai33TtsCap: ai33CapForPlan(planSlugOf(user), isAdminUser(user)),
  });
}
