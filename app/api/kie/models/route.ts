import { NextResponse } from "next/server";
import { listTTSVoices } from "@/lib/kie/tts";
import { listImageModels } from "@/lib/kie/images";
import { listVideoModels } from "@/lib/kie/videos";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

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
      const models = await listImageModels();
      return NextResponse.json(models);
    }
    if (type === "video") {
      const models = await listVideoModels();
      return NextResponse.json(models);
    }

    // Return all
    const [tts, images, videos] = await Promise.all([
      listTTSVoices(),
      listImageModels(),
      listVideoModels(),
    ]);
    return NextResponse.json({ tts, images, videos });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch models";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
