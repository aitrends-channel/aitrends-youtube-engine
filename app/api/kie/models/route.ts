export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { freeImageAllowance } from "@/lib/free-images";
import { FREE_IMAGE_MODEL } from "@/lib/quota-config";
import { FREE_MODEL_TAG } from "@/lib/model-tier";
import { listTTSVoices } from "@/lib/kie/tts";
import { listImageCatalog, type CatalogModel } from "@/lib/operators/image";
import { getPoyoImageModel } from "@/lib/poyo/imageModels";
import { getFundingModeById } from "@/lib/funding";
import { listVideoModels } from "@/lib/kie/videos";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { getMinCostPerSecByModel, getMinKieCreditsByModel, getAvgElapsedByModel, type ObservedByModel } from "@/lib/costs";
import type { User } from "@supabase/supabase-js";
import type { KieModel } from "@/lib/types";
import { monthlyGrantFor } from "@/lib/credits";
import { GENAIPRO_VIDEO_MODEL_ID } from "@/lib/genaipro/client";
import { getMediaOperatorForUser } from "@/lib/operators/routing";
import { OPERATOR_POYO } from "@/lib/operators";
import { poyoVideoModelFor, isPoyoOnlyVideo } from "@/lib/poyo/videoModels";
import { publishedVideoRate } from "@/lib/video-rates";

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
function withMinCredits<T extends KieModel>(models: T[], mins: ObservedByModel): T[] {
  return models.map((m) => {
    // Every resolution the ledger has measured, plus the blend under "".
    // Sending the rows rather than only the blend is what stops the chip and
    // the estimate disagreeing: the estimate has always read the row for the
    // chosen resolution, and a chip quoting the average of every resolution
    // ever run showed one number before selection and another after.
    const rows = mins[m.id];
    if (!rows) return m;
    const byRes: Record<string, number> = {};
    // round2 formats for display and hands back a string; the map is numbers,
    // because the chip multiplies it by a duration.
    for (const [res, v] of Object.entries(rows)) if (res) byRes[res] = Number(round2(v));
    const blend = rows[""];
    return {
      ...m,
      ...(blend === undefined ? {} : { costPerUnit: round2(blend) }),
      ...(Object.keys(byRes).length ? { costByResolution: byRes } : {}),
    };
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
function withPoyoCredits(models: CatalogModel[], observed: ObservedByModel): CatalogModel[] {
  return models.map((m) => {
    if (m.operator !== "poyo") return m;
    // Measured first, catalog second. The catalog has been wrong on four models
    // so far, and PoYo now has its own rows in the snapshot.
    const measured = observed[m.id]?.[""];
    if (measured !== undefined) return { ...m, costPerUnit: round2(measured) };
    const priced = getPoyoImageModel(m.id);
    return priced ? { ...m, costPerUnit: round2(priced.credits) } : m;
  });
}

/**
 * Fill the chip for video models with no history, from the provider's own
 * published rate.
 *
 * Runs after withMinCredits and never overwrites it: a figure we measured beats
 * a figure someone advertised, and the measured one is what the model really
 * costs us. This only reaches the models nobody has generated with, where the
 * alternative is an empty space that reads as a broken chip.
 *
 * Marked as a floor rather than a price. Both providers charge by resolution
 * and duration, and their ranges are wide enough that a single number would
 * mislead — so the client renders "from N" and the exact figure still comes
 * from the estimator once a resolution and duration are chosen.
 */
function withPublishedRates<T extends KieModel>(models: T[], operator: string | null): T[] {
  return models.map((m) => {
    const rate = publishedVideoRate(m.id, (m as { operator?: string }).operator ?? operator);
    if (!rate) return m;
    // Seeded resolutions fill in under measured ones rather than replacing
    // them, in the same order the estimate resolves: a row the ledger has is
    // the better answer, and the seed covers the resolutions it has not.
    const byRes = { ...(rate.byResolution ?? {}), ...(m.costByResolution ?? {}) };
    return {
      ...m,
      costPerUnit: m.costPerUnit ?? round2(rate.from),
      costUnit: m.costPerUnit === undefined ? rate.unit : m.costUnit,
      ...(Object.keys(byRes).length ? { costByResolution: byRes } : {}),
    };
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
      // Selectable, not refused. The worker already falls back per model —
      // a KIE id PoYo does not carry stays on KIE rather than failing — so
      // greying these out withheld five working models to protect against a
      // problem the submit path had already solved.
      //
      // What was worth objecting to was the silence: picking a provider and
      // getting another without being told. So they are offered with the
      // provider named on the card instead.
      return poyoVideoModelFor(m.id) ? m : { ...m, servedBy: "kie" };
    }
    // The other direction is a real refusal. A PoYo-only model has no KIE
    // counterpart to fall back to, so offering it would fail at submit.
    return isPoyoOnlyVideo(m.id) ? { ...m, unavailable: "Not supported" } : m;
  });
}

/**
 * Present the free image lane, when this account still has allowance for it.
 *
 * The model appears twice while the allowance lasts: once in the paid list
 * under its own name, where somebody looking for Z-Image can find it, and once
 * in the Free tab as the lane, where the offer is simply "images, included".
 * The free card still loses everything that identifies the model, because
 * which one we run there is our choice and our cost, and naming it invites a
 * customer to shop the lane against the paid list.
 *
 * Both entries carry the same id, which is what selection and generation need.
 * They are not two products: a generation on this model draws the allowance
 * first whichever card was clicked, so the paid card says so rather than
 * quoting a price the customer will not pay yet.
 *
 * An account with nothing left, or a plan that does not include it, sees only
 * the paid entry, and the Free tab stays a coming-soon teaser on its own.
 *
 * Founder is the plan that means: freeImageAllowance returns 0 for it in every
 * state, so the tab is never live for a Founder.
 */
function withFreeImageTier(models: KieModel[], allowance: { cap: number; remaining: number }): KieModel[] {
  if (allowance.remaining <= 0) return models;
  const left = allowance.remaining.toLocaleString();
  const out: KieModel[] = [];
  for (const m of models) {
    if (m.id !== FREE_IMAGE_MODEL) { out.push(m); continue; }
    // The paid entry, kept whole: real name, vendor tags, observed price and
    // speed. The one addition is why that price is not what happens today.
    out.push({ ...m, description: `Free while your ${left} included image${allowance.remaining === 1 ? "" : "s"} last` });
    out.push({
      ...m,
      // Named for the lane, like Heclus Videos on the clip side. The model
      // underneath is z-image today and may not be tomorrow; what the customer
      // is choosing is our free allowance.
      name: "Heclus Images",
      description: `${left} of ${allowance.cap.toLocaleString()} left this month`,
      tags: [FREE_MODEL_TAG],
      // No price at all, like the free video card beside it.
      //
      // It carried "1 cr", meaning the rate the allowance is drawn down at,
      // and every reading of that was wrong: it is not what z-image bills
      // (0.8), not what the customer pays (nothing), and not the number that
      // matters here, which is how many images are left. The description says
      // that instead.
      costPerUnit: undefined,
      costByResolution: undefined,
      costIsFloor: undefined,
      servedBy: undefined,
      avgSpeedMs: undefined,
    });
  }
  return out;
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
      const [models, defaults, mins, poyoMins, speeds, freeImages] = await Promise.all([
        getMediaOperatorForUser(user.id, "image").then(listImageCatalog),
        getAdminDefaults(),
        getMinKieCreditsByModel("image_gen"),
        getMinKieCreditsByModel("image_gen", "poyo"),
        getAvgElapsedByModel("image_gen"),
        freeImageAllowance(user),
      ]);
      return NextResponse.json(promote(
        withFreeImageTier(withPoyoCredits(withAvgSpeed(withMinCredits(models, mins), speeds), poyoMins), freeImages),
        defaults.image,
      ));
    }
    if (type === "video") {
      const [models, defaults, mins, speeds] = await Promise.all([
        listVideoModels(),
        getAdminDefaults(),
        getMinCostPerSecByModel("video_gen"),
        getAvgElapsedByModel("video_gen"),
      ]);
      const videoOperator = await getMediaOperatorForUser(user.id, "video");
      const gated = gateByOperator(await gateHeclusPaidVideo(models, user), videoOperator);
      return NextResponse.json(promote(
        withPublishedRates(withAvgSpeed(withMinCredits(gated, mins), speeds), videoOperator),
        defaults.video,
      ));
    }

    // Return all
    const [tts, images, videos, defaults, imageMins, videoMins, imageSpeeds, videoSpeeds, poyoImageMins] = await Promise.all([
      listTTSVoices(user.id),
      getMediaOperatorForUser(user.id, "image").then(listImageCatalog),
      listVideoModels(),
      getAdminDefaults(),
      getMinKieCreditsByModel("image_gen"),
      getMinCostPerSecByModel("video_gen"),
      getAvgElapsedByModel("image_gen"),
      getAvgElapsedByModel("video_gen"),
      getMinKieCreditsByModel("image_gen", "poyo"),
    ]);
    return NextResponse.json({
      tts,
      images: promote(withPoyoCredits(withAvgSpeed(withMinCredits(images, imageMins), imageSpeeds), poyoImageMins), defaults.image),
      videos: promote(withAvgSpeed(withMinCredits(
        gateByOperator(await gateHeclusPaidVideo(videos, user), await getMediaOperatorForUser(user.id, "video")),
        videoMins), videoSpeeds), defaults.video),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch models";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
