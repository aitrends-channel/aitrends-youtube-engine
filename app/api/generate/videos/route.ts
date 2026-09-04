import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { requireActiveSubscription } from "@/lib/subscription";
import { requireStorageHeadroom } from "@/lib/storage-quota";
import { requireWalletFunds, OUT_OF_CREDITS_MESSAGE } from "@/lib/heclus-charge";
import { effectiveVideoResolution } from "@/lib/models/effective-resolution";
import { estimateRun, shortfallResponse } from "@/lib/credits/estimate";
import { holdForRun } from "@/lib/credits/hold";
import { GENAIPRO_QUEUED_STATUS, GENAIPRO_MODEL_PREFIX } from "@/lib/genaipro/client";

export const maxDuration = 30;

interface Beat {
  beatNumber: number;
  videoPrompt: string;
  imageUrl?: string;
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const expired = requireActiveSubscription(user);
  if (expired) return expired;
  const noRoom = await requireStorageHeadroom(user);
  if (noRoom) return noRoom;
  try {
    const { projectId, beats, modelId, duration, aspectRatio = "16:9", resolution } = await req.json() as {
      projectId: string; beats: Beat[]; modelId: string; duration?: string | number; aspectRatio?: string; resolution?: string;
    };

    if (!projectId || !beats?.length || !modelId) {
      return NextResponse.json({ error: "projectId, beats, and modelId are required" }, { status: 400 });
    }

    // GenAIPro clips are parked in a status the shared video-worker never
    // claims or recovers, so they wait for this app's own lane instead of
    // being sent to KIE two minutes later.
    const isGenAIPro = modelId.toLowerCase().startsWith(GENAIPRO_MODEL_PREFIX);

    // The wallet gate applies to the paid lane only. A free clip is paid for by
    // the separate video-credit wallet, so refusing it because the Heclus
    // balance is empty would take the free tier away from exactly the people it
    // is there for. Checked here rather than at the door because it needs the
    // model, which arrives in the body.
    if (!isGenAIPro) {
      const broke = await requireWalletFunds(user);
      if (broke) return broke;

      // Priced, not just non-empty. A clip is the most expensive single unit
      // the wallet buys, so "at least one credit" was the weakest gate in the
      // product: a balance of 1 could queue a whole project of clips.
      const short = shortfallResponse(await estimateRun({
        userId: user.id,
        kind: "video",
        modelId,
        count: beats.length,
        durationSec: Number(duration) || null,
        // Priced at the resolution the clips will really run at. A client that
        // sends none still gets the provider's default, which is the lowest the
        // model offers, and pricing that against the blend of every resolution
        // is how a known price turns into a padded guess. Only the estimate
        // reads this: what the worker forwards is still exactly what was asked
        // for, since an unasked-for resolution is an extra input some models
        // reject.
        resolution: effectiveVideoResolution(modelId, null, resolution),
      }));
      if (short) return short;
    }

    // Store job config on the project so the worker can read it.
    // video_resolution is always written — NULL when the client omitted
    // resolution (either the picker chose null for a no-resolution
    // model, or the field was left untouched). Previously we skipped
    // the key when resolution was falsy, which meant a submit against
    // a no-resolution model kept the previous submit's video_resolution
    // in the DB and the worker forwarded that stale value as an extra
    // KIE input the new model didn't accept.
    await supabase.from("projects").update({
      video_model_id: modelId,
      video_duration: duration ?? null,
      video_aspect_ratio: aspectRatio,
      video_resolution: resolution ?? null,
    }).eq("id", projectId).eq("user_id", user.id);

    // Mark each beat as queued. We deliberately do NOT null
    // video_url here — keeping the previous URL means the UI
    // continues to show the old clip while the new one renders,
    // and if the new render fails the user doesn't lose what they
    // had. The worker reads the existing video_url before its
    // upload and best-effort deletes the old R2 object only after
    // the new URL has been written successfully (see worker
    // processBeat).
    let submitted = 0;
    const failures: { beatNumber: number; error: string }[] = [];
    /** Beats a retry could not re-queue because they are still running. */
    const alreadyRunning: number[] = [];

    // Re-queue EXCEPT when the beat is actively in flight. Re-queueing a
    // beat that's already "submitting"/"rendering" nulls its video_job_id
    // and lets the worker claim it again — while the original processBeat
    // is STILL polling the first KIE job in memory. That's a SECOND KIE
    // submission for the same beat → double charge, and it makes retry
    // clicks bounce (the beat is already being worked on), so the user
    // clicks repeatedly. A beat that's genuinely in flight doesn't need a
    // retry, so we skip it and report it as submitted (no-op success) —
    // the UI then reconciles to its real in-progress state.
    for (const beat of beats) {
      // Read the current state first. Never re-queue a beat that's
      // already in flight ("submitting"/"rendering") — that would null
      // its video_job_id and let the worker submit a SECOND KIE job for
      // the same beat (double charge). It's already being generated, so
      // report it as submitted (no-op success) and let the UI reconcile.
      const { data: existing, error: readErr } = await supabase
        .from("project_beats")
        .select("video_status")
        .eq("project_id", projectId)
        .eq("beat_number", beat.beatNumber)
        .maybeSingle();
      if (readErr) {
        failures.push({ beatNumber: beat.beatNumber, error: readErr.message });
        continue;
      }
      if (!existing) {
        failures.push({ beatNumber: beat.beatNumber, error: `Beat ${beat.beatNumber} not found.` });
        continue;
      }
      if (existing.video_status === "submitting" || existing.video_status === "rendering") {
        // Counted as submitted, and reported separately. Re-queueing a beat
        // that is genuinely in flight would null its job id and let the worker
        // submit a second one, so skipping is right; saying nothing about it is
        // not, because a retry that silently does nothing reads as a broken
        // button and gets pressed again.
        submitted++;
        alreadyRunning.push(beat.beatNumber);
        continue;
      }

      // Held at queue time, per clip, and settled by the worker when the clip
      // finishes. A clip is the most expensive thing the wallet buys and it is
      // rendered minutes later in another process, so the hold is what stops a
      // queue of them being authorised against a balance that covers one.
      if (!isGenAIPro) {
        const { refused } = await holdForRun({
          userId: user.id,
          provider: "kie",
          projectId,
          beatNumber: beat.beatNumber,
          estimate: await estimateRun({
            userId: user.id, kind: "video", modelId, count: 1,
            durationSec: Number(duration) || null, resolution,
          }),
        });
        if (refused) {
          failures.push({ beatNumber: beat.beatNumber, error: OUT_OF_CREDITS_MESSAGE });
          continue;
        }
      }

      const { data, error } = await supabase
        .from("project_beats")
        .update({
          video_status: isGenAIPro ? GENAIPRO_QUEUED_STATUS : "queued",
          video_job_id: null,
          video_error: null,
          // Snapshot the config on the beat itself so a later settings
          // change on the project row can't rewrite an already-queued
          // beat. Worker reads beat-level values first and only falls
          // back to projects.* when these are NULL (legacy rows). All
          // four write unconditionally — a NULL from the client (e.g.
          // no-resolution model) is the correct value to persist.
          video_model_id: modelId,
          video_aspect_ratio: aspectRatio,
          video_duration: duration != null ? String(duration) : null,
          video_resolution: resolution ?? null,
          // Persist the prompt from the payload — the worker generates
          // from the DB row, so without this an edited prompt (preview
          // dialog's Save & regenerate) was silently ignored. Normal
          // regens pass the unchanged current prompt, so this is a
          // value no-op for them.
          ...(beat.videoPrompt?.trim() ? { video_prompt: beat.videoPrompt.trim() } : {}),
        })
        .eq("project_id", projectId)
        .eq("beat_number", beat.beatNumber)
        .select("beat_number");

      if (error) {
        failures.push({ beatNumber: beat.beatNumber, error: error.message });
      } else if (!data || data.length === 0) {
        failures.push({ beatNumber: beat.beatNumber, error: `Beat ${beat.beatNumber} not found.` });
      } else {
        submitted++;
      }
    }

    return NextResponse.json({ submitted, failures, total: beats.length, alreadyRunning });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to submit video jobs";
    console.error("[video-submit]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
