export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { listTTSVoices } from "@/lib/kie/tts";
import { listImageCatalog, type CatalogModel } from "@/lib/operators/image";
import { getPoyoImageModel } from "@/lib/poyo/imageModels";
import { getFundingModeById } from "@/lib/funding";
import { listVideoModels } from "@/lib/kie/videos";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { getMinCostPerSecByModel, getMinKieCreditsByModel, getAvgElapsedByModel } from "@/lib/costs";
import type { User } from "@supabase/supabase-js";
import type { KieModel } from "@/lib/types";
import { monthlyGrantFor } from "@/lib/credits";
import { GENAIPRO_VIDEO_MODEL_ID } from "@/lib/genaipro/client";
import { getMediaOperatorForUser } from "@/lib/operators/routing";
import { OPERATOR_POYO } from "@/lib/operators";
import { poyoVideoModelFor, isPoyoOnlyVideo } from "@/lib/poyo/videoModels";

/** Round a fractional credit value to 2 decimals for display.
 *  KIE returns NUMERIC values (e.g. 9.6 cr per 6s = 1.6 cr/s). */
function round2(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Decorate models with the observed minimum cost from the ledger.
 *  costPerUnit stores the raw numeric string; ModelOption decides
 *  the unit suffix ("cr/s" for video, "cr" for image) by reading
 *  model.type. Models without ledger history render without the
 *  chip. */
function withMinCredits<T extends KieModel>(models: T[], mins: Record<string, number>): T[] {
  return models.map((m) => {
    const v = mins[m.id];
    if (v === undefined) return m;
    return { ...m, costPerUnit: round2(v) };
  });
}

/**
 * Cost chips for the PoYo entries.
 *
 * Has to run after withMinCredits and overwrite it. The ledger figures are
 * keyed on model id alone, and both operators carry a model called z-image, so
 * a PoYo row would otherwise display KIE's observed cost for a generation PoYo
 * prices differently. Exact rather than observed, because PoYo bills a flat
 * rate per generation and publishes it.
 */
function withPoyoCredits(models: CatalogModel[]): CatalogModel[] {
  return models.map((m) => {
    if (m.operator !== "poyo") return m;
    const priced = getPoyoImageModel(m.id);
    return priced ? { ...m, costPerUnit: round2(priced.credits) } : m;
  });
}

/**
 * Mark the video models the active operator cannot serve.
 *
 * PoYo carries Seedance, Kling 2.6, Grok and Hailuo for video and does not
 * carry Veo, Runway, Kling 3 or Sora: probed directly, all four return "Model
 * not found". Until now those simply fell back to KIE, which is defensible
 * plumbing and a poor thing to do silently, since the customer picked a
 * provider and got another one.
 *
 * Marked rather than hidden. A model that vanishes reads as a bug in the
 * picker; one that is greyed out with a reason reads as a fact about the
 * provider.
 */
function gateByOperator(models: KieModel[], operator: string): KieModel[] {
  return models.map((m) => {
    // The free lane is neither operator's to refuse: it runs on Heclus's own
    // GenAIPro account whatever the switch says.
    if (m.id === GENAIPRO_VIDEO_MODEL_ID) return m;

    if (operator === OPERATOR_POYO) {
      return poyoVideoModelFor(m.id) ? m : { ...m, unavailable: "Not supported" };
    }
    // The other direction, for the same reason. The catalog is KIE's own list
    // today, so nothing is marked here yet; the first PoYo-only model added to
    // it is greyed out under KIE instead of failing at submit.
    return isPoyoOnlyVideo(m.id) ? { ...m, unavailable: "Not supported" } : m;
  });
}

/** Decorate models with the observed average wall-clock generation
 *  time (ms) from the ledger. Powers the picker's "Fastest" tab —
 *  the page sorts by avgSpeedMs ascending and hides models without
 *  a value. */
function withAvgSpeed<T extends KieModel>(models: T[], speeds: Record<string, number>): T[] {
  return models.map((m) => (speeds[m.id] !== undefined ? { ...m, avgSpeedMs: speeds[m.id] } : m));
}

async function getAdminDefaults(): Promise<{ image: string | null; video: string | null }> {
  const { data } = await supabase
    .from("product_config")
    .select("default_image_model, default_video_model")
    .eq("service", "_global")
    .single();
  return {
    image: data?.default_image_model ?? null,
    video: data?.default_video_model ?? null,
  };
}

/** Move the admin-selected default to index 0 so the generate page's
 *  "first entry as default" auto-pick lands on the admin's choice. */
function promote<T extends KieModel>(models: T[], defaultId: string | null): T[] {
  if (!defaultId) return models;
  const idx = models.findIndex((m) => m.id === defaultId);
  if (idx <= 0) return models;
  const out = models.slice();
  const [picked] = out.splice(idx, 1);
  out.unshift(picked);
  return out;
}

/**
 * GenAIPro runs on Heclus's account, so it is only offered to plans that have
 * an allowance. Founder has none, which is how that plan never sees the option
 * at all rather than seeing one it cannot use.
 *
 * Filtering here rather than in the picker means the answer is the same for
 * every surface that asks for the model list, and a plan without an allowance
 * cannot select it by crafting a request either.
 */
async function gateHeclusPaidVideo(models: KieModel[], user: User): Promise<KieModel[]> {
  const allowance = await monthlyGrantFor(user);
  if (allowance > 0) return models;
  return models.filter((m) => m.id !== GENAIPRO_VIDEO_MODEL_ID);
}

export async function GET(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");

  try {
    if (type === "tts") {
      const models = await listTTSVoices(user.id);
      return NextResponse.json(models);
    }
    if (type === "image") {
      const [models, defaults, mins, speeds] = await Promise.all([
        getMediaOperatorForUser(user.id, "image").then(listImageCatalog),
        getAdminDefaults(),
        getMinKieCreditsByModel("image_gen"),
        getAvgElapsedByModel("image_gen"),
      ]);
      return NextResponse.json(promote(withPoyoCredits(withAvgSpeed(withMinCredits(models, mins), speeds)), defaults.image));
    }
    if (type === "video") {
      const [models, defaults, mins, speeds] = await Promise.all([
        listVideoModels(),
        getAdminDefaults(),
        getMinCostPerSecByModel("video_gen"),
        getAvgElapsedByModel("video_gen"),
      ]);
      const gated = gateByOperator(await gateHeclusPaidVideo(models, user), await getMediaOperatorForUser(user.id, "video"));
      return NextResponse.json(promote(withAvgSpeed(withMinCredits(gated, mins), speeds), defaults.video));
    }

    // Return all
    const [tts, images, videos, defaults, imageMins, videoMins, imageSpeeds, videoSpeeds] = await Promise.all([
      listTTSVoices(user.id),
      getMediaOperatorForUser(user.id, "image").then(listImageCatalog),
      listVideoModels(),
      getAdminDefaults(),
      getMinKieCreditsByModel("image_gen"),
      getMinCostPerSecByModel("video_gen"),
      getAvgElapsedByModel("image_gen"),
      getAvgElapsedByModel("video_gen"),
    ]);
    return NextResponse.json({
      tts,
      images: promote(withPoyoCredits(withAvgSpeed(withMinCredits(images, imageMins), imageSpeeds)), defaults.image),
      videos: promote(withAvgSpeed(withMinCredits(
        gateByOperator(await gateHeclusPaidVideo(videos, user), await getMediaOperatorForUser(user.id, "video")),
        videoMins), videoSpeeds), defaults.video),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch models";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
