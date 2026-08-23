export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withCronRun } from "@/lib/cron/runs";
import { supabase } from "@/lib/supabase/client";
import { uploadFromUrl, userFolderFor } from "@/lib/supabase/storage";
import { logProjectCost } from "@/lib/costs";
import {
  reserveCredits, settleReservation, releaseReservation,
  findOpenReservation, sweepStaleReservations, CREDIT_PROVIDER_GENAIPRO,
} from "@/lib/credits";
import {
  submitFramesToVideo, getTaskStatus, GENAIPRO_RATE_LIMIT_PER_MINUTE, GenAIProError,
  GENAIPRO_VIDEO_MODEL_ID, GENAIPRO_MODEL_PREFIX, GENAIPRO_QUEUED_STATUS,
} from "@/lib/genaipro/client";
// The submit half lives in lib/genaipro/pump.ts so the generate step can warm
// start a project's first clips instead of leaving them parked until this cron
// next fires.
import { submitQueued, failBeat, userIdOf, type QueuedBeat } from "@/lib/genaipro/pump";

export const maxDuration = 300;

// The GenAIPro lane: submit queued clips, poll the ones in flight, and never
// leave a customer's credit held by a generation that vanished.
//
// It is a cron rather than a loop because of their rate limit: 30 requests a
// minute for submits and 30 for polls, against a median project of ~147 clips.
// A project therefore cannot be submitted in one pass, and pretending otherwise
// would just mean 429s and half-rendered videos.
//
// It runs beside the separate video-worker, which handles KIE clips. That
// worker claims any beat sitting in "queued", so it carries a filter excluding
// GenAIPro model ids. **That filter must be deployed before this lane starts
// queueing GenAIPro beats**, or the worker will claim them and fail them
// against KIE.

const CRON_SECRET = process.env.CRON_SECRET;

// Well under the ceiling, because submits and polls both draw on it and the
// cron fires every two minutes: 20 of each is 10 a minute, leaving room for a
// retry storm without tipping into 429s. The submit half of that budget lives
// with the pump, as SUBMIT_MAX.
const POLL_MAX = 20;


/** Poll in-flight clips: store the result and settle, or release and fail. */
async function pollRendering(): Promise<{ done: number; failed: number; pending: number }> {
  const { data, error } = await supabase
    .from("project_beats")
    .select("project_id, beat_number, video_job_id, projects!inner(user_id)")
    .eq("video_status", "rendering")
    .ilike("video_model_id", `${GENAIPRO_MODEL_PREFIX}%`)
    .not("video_job_id", "is", null)
    .limit(POLL_MAX);
  if (error) {
    console.warn("[genaipro] poll read failed:", error.message);
    return { done: 0, failed: 0, pending: 0 };
  }

  let done = 0, failed = 0, pending = 0;

  for (const raw of (data ?? []) as unknown as (QueuedBeat & { video_job_id: string })[]) {
    const userId = userIdOf(raw);
    if (!userId || !raw.video_job_id) continue;

    let status;
    try {
      status = await getTaskStatus(raw.video_job_id);
    } catch (e) {
      // Leave the beat alone: a status call that fails says nothing about the
      // generation, and releasing the credit here would charge nobody for a
      // clip that may well arrive.
      console.warn(`[genaipro] status failed beat=${raw.beat_number}:`, e instanceof Error ? e.message : e);
      pending++;
      continue;
    }

    if (status.state === "processing") { pending++; continue; }

    const reservation = await findOpenReservation(raw.project_id, raw.beat_number);

    if (status.state === "failed" || !status.url) {
      if (reservation) await releaseReservation(reservation, status.error ?? "Provider reported failure");
      await failBeat(raw.project_id, raw.beat_number, status.error ?? "The provider could not render this clip.");
      failed++;
      continue;
    }

    // Pull the clip into our own storage before settling. Their URLs sit behind
    // a time-boxed package, and assembly reads this weeks later.
    let storedUrl: string;
    try {
      const folder = userFolderFor({ id: userId });
      // The timestamp is what makes a regenerate visible. Without it every
      // render of a beat writes the same object at the same URL, so video_url
      // comes back byte-identical and the browser and CDN keep serving the
      // clip they already cached: a first generation appeared, a regeneration
      // looked like it never arrived. The KIE lane has always done this — see
      // app/api/webhooks/kie/video/route.ts — and this lane was the outlier.
      storedUrl = await uploadFromUrl(
        `${folder}/${raw.project_id}/videos/beat-${raw.beat_number}_${Date.now()}.mp4`,
        status.url,
        "video/mp4",
      );
    } catch (e) {
      // The clip exists and the provider has been paid, so the credit is spent
      // whether or not we managed to file it. Settle, then fail the beat so it
      // can be retried rather than silently losing the render.
      if (reservation) await settleReservation(reservation, 1, "Clip rendered but could not be stored");
      await failBeat(raw.project_id, raw.beat_number,
        `Rendered, but saving it failed: ${e instanceof Error ? e.message : "storage error"}`);
      failed++;
      continue;
    }

    if (reservation) await settleReservation(reservation, 1, `beat ${raw.beat_number}`);

    await supabase
      .from("project_beats")
      .update({ video_status: "done", video_url: storedUrl, video_error: null })
      .eq("project_id", raw.project_id)
      .eq("beat_number", raw.beat_number);

    // Keep the existing cost dashboards honest: the ledger is the money, this
    // is the meter, and every other provider already reports here.
    await logProjectCost({
      projectId: raw.project_id,
      userId,
      step: "video_gen",
      provider: "genaipro",
      model: GENAIPRO_VIDEO_MODEL_ID,
      units: 1,
      unitKind: "genaipro_clips",
    });

    done++;
  }

  return { done, failed, pending };
}

export async function GET(req: Request) {
  if (CRON_SECRET) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return withCronRun("genaipro-video", async () => {

    const submit = await submitQueued();
    const poll = await pollRendering();
    const releasedStale = await sweepStaleReservations();

    return NextResponse.json({
      ok: true,
      rateLimitPerMinute: GENAIPRO_RATE_LIMIT_PER_MINUTE,
      submit,
      poll,
      releasedStale,
    });
  });
}
