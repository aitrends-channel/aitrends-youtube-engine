import { NextResponse } from "next/server";

import { withPromptLengthRetry } from "@/lib/kie/promptLength";
import { withRateLimitRetry } from "@/lib/operators/upstream";
import { resolveConsistency, applyConsistency } from "@/lib/character-consistency";
import { uploadFromUrl, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getConcurrencyConfig } from "@/lib/concurrency-config";
import { logProjectCost } from "@/lib/costs";
import type { User } from "@supabase/supabase-js";
import { requireActiveSubscription } from "@/lib/subscription";
import { requireStorageHeadroom } from "@/lib/storage-quota";
import { requireWalletFunds, canStartWalletWork, OUT_OF_CREDITS_MESSAGE } from "@/lib/heclus-charge";
import { estimateRun, shortfallResponse } from "@/lib/credits/estimate";
import { holdForOne, releaseHold, findOpenHold } from "@/lib/credits/hold";
import { resolveImageOperator } from "@/lib/operators/image";
import { getMediaOperatorForUser } from "@/lib/operators/routing";

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
  const expired = requireActiveSubscription(user);
  if (expired) return expired;
  const noRoom = await requireStorageHeadroom(user);
  if (noRoom) return noRoom;
  // Wallet-funded users pay for this step in credits, so an empty balance is
  // refused before any provider is called.
  const broke = await requireWalletFunds(user);
  if (broke) return broke;

  try {
    const { projectId, beats, modelId, aspectRatio = "16:9", resolution, clearFirst = false } = await req.json() as {
      projectId: string; beats: Beat[]; modelId: string;
      aspectRatio?: string; resolution?: string; clearFirst?: boolean;
    };

    if (!projectId || !beats?.length || !modelId) {
      return NextResponse.json({ error: "projectId, beats, and modelId are required" }, { status: 400 });
    }

    // One operator for the whole batch. Resolved from the admin switch, with
    // BYO clients pinned to KIE and free-lane models exempt; see
    // lib/operators/routing.ts.
    const op = resolveImageOperator(modelId, await getMediaOperatorForUser(user.id, "image"));

    // Price the whole run before touching anything. The gate at the door asks
    // for one credit, which would let a balance of 10 start five images at 8
    // each and bill 10 of the 40.
    const estimate = await estimateRun({
      userId: user.id, kind: "image", modelId, operator: op.id, count: beats.length, resolution,
    });
    const short = shortfallResponse(estimate);
    if (short) return short;

    if (clearFirst) {
      await supabase.from("project_beats").update({ image_url: null, image_status: null }).eq("project_id", projectId);
      await supabase.from("projects").update({ images_progress: 0 }).eq("id", projectId).eq("user_id", user.id);
    }

    // Character-consistency text (per-project override, else the user's
    // account default). Resolved once per request and appended to each
    // beat prompt only for the KIE call — the stored image_prompt stays
    // clean.
    const consistency = await resolveConsistency(user.id, projectId);

    const results: { beatNumber: number; url: string }[] = [];
    const failures: { beatNumber: number; error: string }[] = [];
    // Admin-tunable: product_config.batched_processes.image_generation_batch.
    const batchSize = (await getConcurrencyConfig()).image_generation_batch;

    for (let i = 0; i < beats.length; i += batchSize) {
      const batch = beats.slice(i, i + batchSize);

      // Re-checked per batch, not just at the door. A project is hundreds of
      // generations, so a wallet that empties on beat 12 would otherwise keep
      // spending Heclus's balance all the way to the last beat. The remaining
      // beats are reported as failures with the same message the banner routes
      // to a top-up, rather than left looking like they never ran.
      // Priced per beat rather than "at least one credit", so the run stops on
      // the batch it can no longer afford instead of part-paying for it.
      if (!(await canStartWalletWork(user.id, estimate.perUnit ?? 1))) {
        for (const remaining of beats.slice(i)) {
          failures.push({ beatNumber: remaining.beatNumber, error: OUT_OF_CREDITS_MESSAGE });
          await supabase.from("project_beats").update({ image_status: "failed" }).eq("project_id", projectId).eq("beat_number", remaining.beatNumber);
        }
        break;
      }

      const batchResults = await Promise.allSettled(
        batch.map(async (beat) => {
          await supabase.from("project_beats").update({ image_status: "generating" }).eq("project_id", projectId).eq("beat_number", beat.beatNumber);

          // Wall-clock the entire KIE submit→poll→download for this
          // beat. Used by the "Fastest" tab in the generate page's
          // model picker to rank models by observed speed. Captures
          // the user's actual experience (queue + generation + cdn
          // fetch), not just the raw model inference time.
          const t0 = Date.now();
          // Held before the provider is called, settled with what it reported.
          // Two of these run at once inside a batch, so the atomic hold is what
          // stops both spending the same credits.
          const { hold, refused } = await holdForOne({
            userId: user.id, kind: "image", modelId, operator: op.id,
            provider: op.id, resolution, projectId, beatNumber: beat.beatNumber,
          });
          if (refused) throw new Error(OUT_OF_CREDITS_MESSAGE);

          const { url: imageUrl, units: creditsConsumed } = await withPromptLengthRetry(
            beat.imagePrompt,
            (prompt) => withRateLimitRetry(() => op.generate({
              prompt: applyConsistency(prompt, consistency.text, consistency.append),
              modelId, aspectRatio, resolution, userId: user.id,
            })),
          );
          const elapsedMs = Date.now() - t0;
          if (creditsConsumed) {
            await logProjectCost({
              projectId,
              userId: user.id,
              step: "image_gen",
              provider: op.id === "poyo" ? "poyo" : "kie",
              model: modelId,
              units: creditsConsumed,
              unitKind: op.unitKind,
              resolution,
              elapsedMs,
              reservationId: hold?.id ?? null,
            });
          } else {
            // No reported cost means nothing to settle against, so the hold
            // goes back rather than sitting open until the sweeper finds it.
            await releaseHold(hold, "image produced no cost figure");
          }
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
          // The hold for this beat, if the failure happened after it was taken.
          // Found rather than tracked: Promise.allSettled has already thrown
          // away the closure that held it.
          await releaseHold(await findOpenHold({ userId: user.id, projectId, beatNumber: batch[j].beatNumber }), "image generation failed");
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
