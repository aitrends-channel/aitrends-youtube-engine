export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { listTTSVoices } from "@/lib/kie/tts";
import { listImageModels } from "@/lib/kie/images";
import { listVideoModels } from "@/lib/kie/videos";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { getMinCostPerSecByModel, getMinKieCreditsByModel, getAvgElapsedByModel } from "@/lib/costs";
import type { User } from "@supabase/supabase-js";
import type { KieModel } from "@/lib/types";

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
function withMinCredits(models: KieModel[], mins: Record<string, number>): KieModel[] {
  return models.map((m) => {
    const v = mins[m.id];
    if (v === undefined) return m;
    return { ...m, costPerUnit: round2(v) };
  });
}

/** Decorate models with the observed average wall-clock generation
 *  time (ms) from the ledger. Powers the picker's "Fastest" tab —
 *  the page sorts by avgSpeedMs ascending and hides models without
 *  a value. */
function withAvgSpeed(models: KieModel[], speeds: Record<string, number>): KieModel[] {
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
function promote(models: KieModel[], defaultId: string | null): KieModel[] {
  if (!defaultId) return models;
  const idx = models.findIndex((m) => m.id === defaultId);
  if (idx <= 0) return models;
  const out = models.slice();
  const [picked] = out.splice(idx, 1);
  out.unshift(picked);
  return out;
}

export async function GET(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  void user;

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");

  try {
    if (type === "tts") {
      const models = await listTTSVoices();
      return NextResponse.json(models);
    }
    if (type === "image") {
      const [models, defaults, mins, speeds] = await Promise.all([
        listImageModels(),
        getAdminDefaults(),
        getMinKieCreditsByModel("image_gen"),
        getAvgElapsedByModel("image_gen"),
      ]);
      return NextResponse.json(promote(withAvgSpeed(withMinCredits(models, mins), speeds), defaults.image));
    }
    if (type === "video") {
      const [models, defaults, mins, speeds] = await Promise.all([
        listVideoModels(),
        getAdminDefaults(),
        getMinCostPerSecByModel("video_gen"),
        getAvgElapsedByModel("video_gen"),
      ]);
      return NextResponse.json(promote(withAvgSpeed(withMinCredits(models, mins), speeds), defaults.video));
    }

    // Return all
    const [tts, images, videos, defaults, imageMins, videoMins, imageSpeeds, videoSpeeds] = await Promise.all([
      listTTSVoices(),
      listImageModels(),
      listVideoModels(),
      getAdminDefaults(),
      getMinKieCreditsByModel("image_gen"),
      getMinCostPerSecByModel("video_gen"),
      getAvgElapsedByModel("image_gen"),
      getAvgElapsedByModel("video_gen"),
    ]);
    return NextResponse.json({
      tts,
      images: promote(withAvgSpeed(withMinCredits(images, imageMins), imageSpeeds), defaults.image),
      videos: promote(withAvgSpeed(withMinCredits(videos, videoMins), videoSpeeds), defaults.video),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch models";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
