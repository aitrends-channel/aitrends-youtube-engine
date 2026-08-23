import { NextResponse } from "next/server";

import { withPromptLengthRetry } from "@/lib/kie/promptLength";
import { withRateLimitRetry } from "@/lib/operators/upstream";
import { deleteObject, r2KeyFromUrl, uploadFromUrl, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getConcurrencyConfig } from "@/lib/concurrency-config";
import { logProjectCost } from "@/lib/costs";
import type { User } from "@supabase/supabase-js";
import { requireActiveSubscription } from "@/lib/subscription";
import { requireStorageHeadroom } from "@/lib/storage-quota";
import { requireWalletFunds } from "@/lib/heclus-charge";
import { resolveImageOperator } from "@/lib/operators/image";
import { getMediaOperatorForUser } from "@/lib/operators/routing";

export const maxDuration = 800;

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
  const expired = requireActiveSubscription(user);
  if (expired) return expired;
  const noRoom = await requireStorageHeadroom(user);
  if (noRoom) return noRoom;
  // Wallet-funded users pay for this step in credits, so an empty balance is
  // refused before any provider is called.
  const broke = await requireWalletFunds(user);
  if (broke) return broke;

  try {
    const { projectId, thumbnails, modelId, aspectRatio = "16:9", resolution, clearFirst = false } = await req.json() as {
      projectId: string; thumbnails: ThumbnailInput[]; modelId: string;
      aspectRatio?: string; resolution?: string; clearFirst?: boolean;
    };

    if (!projectId || !thumbnails?.length || !modelId) {
      return NextResponse.json({ error: "projectId, thumbnails, and modelId are required" }, { status: 400 });
    }

    // One operator for the whole batch. Resolved from the admin switch, with
    // BYO clients pinned to KIE and free-lane models exempt; see
    // lib/operators/routing.ts.
    const op = resolveImageOperator(modelId, await getMediaOperatorForUser(user.id, "image"));

    // Fetch text overlays + the current image_url for every position
    // BEFORE any clearFirst wipe — otherwise the wipe would null out
    // image_url and we'd lose the chance to delete the previous R2
    // object, leaving an orphan in storage for every regen.
    //
    // text_overlay reason: Claude's generated stylePrompt only includes
    // "text placement guidance" (where to put text); the literal overlay
    // string lives on text_overlay and would never reach the image
    // generator otherwise. We inject it on demand here so edits to the
    // overlay text take effect immediately, no Claude rerun needed.
    const positions = thumbnails.map((t) => t.position);
    const { data: thumbRows } = await supabase
      .from("project_thumbnails")
      .select("position, text_overlay, image_url")
      .eq("project_id", projectId)
      .in("position", positions);
    const textOverlayByPosition = new Map<number, string>(
      (thumbRows ?? [])
        .map((r) => [r.position as number, (r.text_overlay as string | null) ?? ""] as const)
        .filter(([, v]) => v.length > 0)
    );
    const oldImageUrlByPosition = new Map<number, string>(
      (thumbRows ?? [])
        .map((r) => [r.position as number, (r.image_url as string | null) ?? ""] as const)
        .filter(([, v]) => v.length > 0)
    );

    if (clearFirst) {
      await supabase.from("project_thumbnails").update({ image_url: null, image_status: null }).eq("project_id", projectId);
    }

    function augmentPromptWithOverlay(stylePrompt: string, textOverlay: string | undefined): string {
      if (!textOverlay) return stylePrompt;
      // Skip the augmentation if Claude already included the literal
      // overlay text in the prompt — appending again would just nag the
      // image model and sometimes cause it to render the text twice.
      // Match is case-insensitive on the full overlay phrase (cheap and
      // good enough — overlays are short, exact-quoted strings).
      if (stylePrompt.toLowerCase().includes(textOverlay.toLowerCase())) return stylePrompt;
      return `${stylePrompt}\n\nThumbnail text overlay (render exactly as written, large and legible): ${textOverlay}`;
    }

    const results: { position: number; url: string }[] = [];
    const failures: { position: number; error: string }[] = [];
    // Admin-tunable: product_config.batched_processes.thumbnail_batch.
    const batchSize = (await getConcurrencyConfig()).thumbnail_batch;

    for (let i = 0; i < thumbnails.length; i += batchSize) {
      const batch = thumbnails.slice(i, i + batchSize);

      const batchResults = await Promise.allSettled(
        batch.map(async (thumb) => {
          await supabase.from("project_thumbnails").update({ image_status: "generating" }).eq("project_id", projectId).eq("position", thumb.position);

          // Overlay re-appended per attempt so shortening never costs us the
          // literal text the thumbnail is meant to render.
          const overlay = textOverlayByPosition.get(thumb.position);
          const { url: imageUrl, units: creditsConsumed } = await withPromptLengthRetry(
            thumb.stylePrompt,
            (stylePrompt) => withRateLimitRetry(() => op.generate({
              prompt: augmentPromptWithOverlay(stylePrompt, overlay),
              modelId, aspectRatio, resolution, userId: user.id,
            })),
          );
          if (creditsConsumed) {
            void logProjectCost({
              projectId,
              userId: user.id,
              step: "thumbnail_image",
              provider: op.id === "poyo" ? "poyo" : "kie",
              model: modelId,
              units: creditsConsumed,
              unitKind: op.unitKind,
            });
          }
          const storagePath = `${userFolderFor(user)}/${projectId}/thumbnails/thumb-${thumb.position}_${Date.now()}.png`;
          const publicUrl = await uploadFromUrl(storagePath, imageUrl, "image/png");

          await supabase.from("project_thumbnails").update({ image_url: publicUrl, image_status: "done" }).eq("project_id", projectId).eq("position", thumb.position);

          // Best-effort cleanup of the previous R2 object now that the
          // new one is live and the DB column points at it. Runs AFTER
          // the DB write so a failed delete can't leave the user with
          // no image. Non-fatal: a missed delete just orphans a file
          // (cheap in R2; clear_for_script_regen sweeps the whole
          // folder later anyway). r2KeyFromUrl returns null for any
          // URL not owned by our bucket so we never try to delete
          // someone else's asset.
          const previousUrl = oldImageUrlByPosition.get(thumb.position);
          if (previousUrl && previousUrl !== publicUrl) {
            const previousKey = r2KeyFromUrl(previousUrl);
            if (previousKey) {
              deleteObject(previousKey).catch((err) => {
                console.warn(`[thumbnail-images] failed to delete previous key ${previousKey}:`, err instanceof Error ? err.message : err);
              });
            }
          }

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
