export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { freeImageAllowance } from "@/lib/free-images";
import { getFreeImagePack } from "@/lib/free-image-pack";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getFreeUsageThisMonth } from "@/lib/freeUsage";
import { qwenCapForPlan } from "@/lib/replicate/tts";
import { getQuotaConfig, capFromConfig } from "@/lib/quota-config";
import { planSlugOf } from "@/lib/plans-gating";
import { isAdminUser } from "@/lib/admin";
import type { User } from "@supabase/supabase-js";

// Powers the voiceover Free tab's usage bar. The ai33 cap comes from the
// admin quota config so the bar matches what the server enforces.
export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const plan = planSlugOf(user);
  const isAdmin = isAdminUser(user);

  const [qwenTtsChars, ai33TtsChars, quotas, images, imagePack] = await Promise.all([
    getFreeUsageThisMonth(user.id, "qwen_tts_chars"),
    getFreeUsageThisMonth(user.id, "ai33_tts_chars"),
    getQuotaConfig(),
    freeImageAllowance(user),
    getFreeImagePack(),
  ]);
  return NextResponse.json({
    qwenTtsChars,
    // Plan-tiered: 0 = Qwen not available on this plan (founder).
    qwenTtsCap: qwenCapForPlan(plan, isAdmin),
    ai33TtsChars,
    // Plan-tiered from the admin allocation: 0 = ai33 not included on
    // this plan (Founder by default, but any plan can be set to 0).
    ai33TtsCap: capFromConfig(quotas, "ai33_tts_chars", plan, isAdmin),
    // From freeImageAllowance rather than the quota alone: the cap includes
    // bought images, and the panel would otherwise show somebody less than
    // they have.
    freeImagesUsed: images.used,
    freeImagesCap: images.cap,
    freeImagesMonthly: images.monthly,
    freeImagesBonus: images.bonus,
    freeImagePack: imagePack.images !== null && imagePack.priceUsd !== null
      ? { images: imagePack.images, priceUsd: imagePack.priceUsd }
      : null,
    freeImageCheckoutUrl: imagePack.checkoutUrl,
  });
}
