export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
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
// retry storm without tipping into 429s.
const SUBMIT_MAX = 20;
const POLL_MAX = 20;

interface QueuedBeat {
  project_id: string;
  beat_number: number;
  video_prompt: string | null;
  image_url: string | null;
  video_aspect_ratio: string | null;
  projects: { user_id: string } | { user_id: string }[] | null;
}

function userIdOf(row: QueuedBeat): string | null {
  const p = Array.isArray(row.projects) ? row.projects[0] : row.projects;
  return p?.user_id ?? null;
}

async function failBeat(projectId: string, beatNumber: number, error: string): Promise<void> {
  await supabase
    .from("project_beats")
    .update({ video_status: "failed", video_error: error.slice(0, 500), video_job_id: null })
    .eq("project_id", projectId)
    .eq("beat_number", beatNumber);
}

/**
 * Claim, reserve, submit.
 *
 * Order matters and is the whole point of the wallet: the beat is claimed
 * first so no second run can take it, then credit is reserved, and only then
 * does anything reach the provider. Reserving after submitting would generate
 * clips nobody has paid for.
 */
async function submitQueued(): Promise<{ submitted: number; refused: number; failed: number }> {
  const { data, error } = await supabase
    .from("project_beats")
    .select("project_id, beat_number, video_prompt, image_url, video_aspect_ratio, projects!inner(user_id)")
    .eq("video_status", GENAIPRO_QUEUED_STATUS)
    .ilike("video_model_id", `${GENAIPRO_MODEL_PREFIX}%`)
    .limit(SUBMIT_MAX);
  if (error) {
    console.warn("[genaipro] queue read failed:", error.message);
    return { submitted: 0, refused: 0, failed: 0 };
  }

  let submitted = 0, refused = 0, failed = 0;

  for (const row of (data ?? []) as unknown as QueuedBeat[]) {
    const userId = userIdOf(row);
    if (!userId) continue;

    // Conditional claim: whoever flips the parking status to "submitting" owns
    // the beat. From here on the status vocabulary is the shared one, so the
    // progress UI, cancel and merge all behave as they do for KIE clips.
    const { data: claimed } = await supabase
      .from("project_beats")
      .update({ video_status: "submitting", video_started_at: new Date().toISOString() })
      .eq("project_id", row.project_id)
      .eq("beat_number", row.beat_number)
      .eq("video_status", GENAIPRO_QUEUED_STATUS)
      .select("beat_number")
      .maybeSingle();
    if (!claimed) continue;

    if (!row.video_prompt?.trim() || !row.image_url?.trim()) {
      await failBeat(row.project_id, row.beat_number, "This beat has no prompt or no image to animate.");
      failed++;
      continue;
    }

    const reservation = await reserveCredits({
      userId,
      credits: 1,
      provider: CREDIT_PROVIDER_GENAIPRO,
      projectId: row.project_id,
      beatNumber: row.beat_number,
    });
    if (!reservation) {
      // Out of credit is a normal outcome, not an error. The message is what
      // the customer reads on the tile, so it says what to do next.
      await failBeat(
        row.project_id, row.beat_number,
        "You have no video credits left this month. Top up to keep generating, or wait for next month's free credits.",
      );
      refused++;
      continue;
    }

    try {
      const { taskId } = await submitFramesToVideo({
        imageUrl: row.image_url,
        prompt: row.video_prompt,
        aspectRatio: row.video_aspect_ratio,
      });
      await supabase
        .from("project_beats")
        .update({ video_status: "rendering", video_job_id: taskId, video_error: null })
        .eq("project_id", row.project_id)
        .eq("beat_number", row.beat_number);
      submitted++;
    } catch (e) {
      // Nothing was generated, so nothing is charged.
      await releaseReservation(reservation, "Submit failed");
      const msg = e instanceof GenAIProError ? e.message : (e instanceof Error ? e.message : "Submit failed");
      // The beat gets the customer-safe wording; the log gets the provider,
      // the code and the fix. Without this line the detail is simply lost.
      if (e instanceof GenAIProError && e.operatorMessage) {
        console.warn(`[genaipro] ${e.operatorMessage}`);
      }
      await failBeat(row.project_id, row.beat_number, msg);
      failed++;
      // A rate limit means the whole batch is going to fail; stop early and
      // let the next run pick up where this one left off.
      if (e instanceof GenAIProError && e.status === 429) break;
    }
  }

  return { submitted, refused, failed };
}

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
      storedUrl = await uploadFromUrl(
        `${folder}/${raw.project_id}/videos/beat-${raw.beat_number}.mp4`,
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
}
