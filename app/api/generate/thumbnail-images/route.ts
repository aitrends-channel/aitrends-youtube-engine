import { NextResponse } from "next/server";
import { generateImage } from "@/lib/kie/images";
import { uploadFromUrl } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 300;

interface ThumbnailInput {
  position: number;
  stylePrompt: string;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { projectId, thumbnails, modelId, aspectRatio = "16:9", resolution, clearFirst = false } = await req.json() as {
      projectId: string; thumbnails: ThumbnailInput[]; modelId: string;
      aspectRatio?: string; resolution?: string; clearFirst?: boolean;
    };

    if (!projectId || !thumbnails?.length || !modelId) {
      return NextResponse.json({ error: "projectId, thumbnails, and modelId are required" }, { status: 400 });
    }

    if (clearFirst) {
      await supabase.from("project_thumbnails").update({ image_url: null, image_status: null }).eq("project_id", projectId);
    }

    const results: { position: number; url: string }[] = [];
    const failures: { position: number; error: string }[] = [];
    const batchSize = 2;

    for (let i = 0; i < thumbnails.length; i += batchSize) {
      const batch = thumbnails.slice(i, i + batchSize);

      const batchResults = await Promise.allSettled(
        batch.map(async (thumb) => {
          await supabase.from("project_thumbnails").update({ image_status: "generating" }).eq("project_id", projectId).eq("position", thumb.position);

          const imageUrl = await generateImage(thumb.stylePrompt, modelId, aspectRatio, resolution, user.id);
          const storagePath = `${projectId}/thumbnails/thumb-${thumb.position}_${Date.now()}.png`;
          const publicUrl = await uploadFromUrl(storagePath, imageUrl, "image/png");

          await supabase.from("project_thumbnails").update({ image_url: publicUrl, image_status: "done" }).eq("project_id", projectId).eq("position", thumb.position);

          return { position: thumb.position, url: publicUrl };
        })
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          const errMsg = result.reason instanceof Error ? result.reason.message : "Unknown error";
          console.error(`Thumbnail image gen failed (position ${batch[j].position}):`, errMsg);
          failures.push({ position: batch[j].position, error: errMsg });
          await supabase.from("project_thumbnails").update({ image_status: "failed" }).eq("project_id", projectId).eq("position", batch[j].position);
        }
      }

      if (i + batchSize < thumbnails.length) await sleep(1000);
    }

    return NextResponse.json({ images: results, failures, total: thumbnails.length, success: results.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Thumbnail image generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
