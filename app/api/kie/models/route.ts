export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { listTTSVoices } from "@/lib/kie/tts";
import { listImageModels } from "@/lib/kie/images";
import { listVideoModels } from "@/lib/kie/videos";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import type { KieModel } from "@/lib/types";

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
      const [models, defaults] = await Promise.all([listImageModels(), getAdminDefaults()]);
      return NextResponse.json(promote(models, defaults.image));
    }
    if (type === "video") {
      const [models, defaults] = await Promise.all([listVideoModels(), getAdminDefaults()]);
      return NextResponse.json(promote(models, defaults.video));
    }

    // Return all
    const [tts, images, videos, defaults] = await Promise.all([
      listTTSVoices(),
      listImageModels(),
      listVideoModels(),
      getAdminDefaults(),
    ]);
    return NextResponse.json({
      tts,
      images: promote(images, defaults.image),
      videos: promote(videos, defaults.video),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch models";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
