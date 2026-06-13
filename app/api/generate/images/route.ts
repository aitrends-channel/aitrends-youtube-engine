import { NextResponse } from "next/server";
import { generateImage } from "@/lib/kie/images";
import { uploadFromUrl, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getConcurrencyConfig } from "@/lib/concurrency-config";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 60;

interface Beat {
  beatNumber: number;
  imagePrompt: string;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { projectId, beats, modelId, aspectRatio = "16:9", resolution, clearFirst = false } = await req.json() as {
      projectId: string; beats: Beat[]; modelId: string;
      aspectRatio?: string; resolution?: string; clearFirst?: boolean;
    };

    if (!projectId || !beats?.length || !modelId) {
      return NextResponse.json({ error: "projectId, beats, and modelId are required" }, { status: 400 });
    }

    if (clearFirst) {
      await supabase.from("project_beats").update({ image_url: null, image_status: null }).eq("project_id", projectId);
      await supabase.from("projects").update({ images_progress: 0 }).eq("id", projectId).eq("user_id", user.id);
    }

    const results: { beatNumber: number; url: string }[] = [];
    const failures: { beatNumber: number; error: string }[] = [];
    // Admin-tunable: product_config.badged_processes.image_generation_batch.
    const batchSize = (await getConcurrencyConfig()).image_generation_batch;

    for (let i = 0; i < beats.length; i += batchSize) {
      const batch = beats.slice(i, i + batchSize);

      const batchResults = await Promise.allSettled(
        batch.map(async (beat) => {
          await supabase.from("project_beats").update({ image_status: "generating" }).eq("project_id", projectId).eq("beat_number", beat.beatNumber);

          const imageUrl = await generateImage(beat.imagePrompt, modelId, aspectRatio, resolution, user.id);
          const storagePath = `${userFolderFor(user)}/${projectId}/images/beat-${beat.beatNumber}_${Date.now()}.png`;
          const publicUrl = await uploadFromUrl(storagePath, imageUrl, "image/png");

          await supabase.from("project_beats").update({ image_url: publicUrl, image_status: "done" }).eq("project_id", projectId).eq("beat_number", beat.beatNumber);

          return { beatNumber: beat.beatNumber, url: publicUrl };
        })
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          const errMsg = result.reason instanceof Error ? result.reason.message : "Unknown error";
          console.error(`Image gen failed (beat ${batch[j].beatNumber}):`, errMsg);
          failures.push({ beatNumber: batch[j].beatNumber, error: errMsg });
          await supabase.from("project_beats").update({ image_status: "failed" }).eq("project_id", projectId).eq("beat_number", batch[j].beatNumber);
        }
      }

      await supabase.from("projects").update({ images_progress: results.length }).eq("id", projectId).eq("user_id", user.id);

      if (i + batchSize < beats.length) await sleep(1000);
    }

    return NextResponse.json({ images: results, failures, total: beats.length, success: results.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Image generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
