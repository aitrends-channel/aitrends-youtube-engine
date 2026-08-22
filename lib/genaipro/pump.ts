import { supabase } from "@/lib/supabase/client";
import {
  reserveCredits, releaseReservation, CREDIT_PROVIDER_GENAIPRO,
} from "@/lib/credits";
import {
  submitFramesToVideo, GenAIProError,
  GENAIPRO_MODEL_PREFIX, GENAIPRO_QUEUED_STATUS,
} from "@/lib/genaipro/client";
import { OPERATOR_GENAIPRO } from "@/lib/operators";

// The submit half of the GenAIPro lane, lifted out of the cron route so two
// callers can share it: the every-two-minutes cron, and the warm start the
// generate step fires the moment it queues clips. Without that warm start a
// beat sits in the parking status for up to the full cron interval, which the
// UI can only honestly report as "queued" for two minutes.
//
// Scoping and the limit are what make the second caller safe. GenAIPro allows
// 30 submits a minute; the cron takes 20 every two minutes to leave room for a
// retry storm, so a warm start has to stay small and touch only the project
// that was just queued.

// Well under the ceiling, because submits and polls both draw on it and the
// cron fires every two minutes: 20 of each is 10 a minute, leaving room for a
// retry storm without tipping into 429s.
export const SUBMIT_MAX = 20;

/** Beats a warm start will submit inline. Small on purpose: enough that the
 *  first tiles move within seconds of the click, few enough that it cannot
 *  meaningfully eat into the cron's rate-limit headroom, and quick enough that
 *  the caller is not left waiting on a pile of image uploads. */
export const WARM_START_MAX = 3;

export interface QueuedBeat {
  project_id: string;
  beat_number: number;
  video_prompt: string | null;
  image_url: string | null;
  video_aspect_ratio: string | null;
  projects: { user_id: string } | { user_id: string }[] | null;
}

export function userIdOf(row: QueuedBeat): string | null {
  const p = Array.isArray(row.projects) ? row.projects[0] : row.projects;
  return p?.user_id ?? null;
}

export async function failBeat(projectId: string, beatNumber: number, error: string): Promise<void> {
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
export async function submitQueued(opts?: {
  /** Restrict to one project. The cron omits it and drains the global queue. */
  projectId?: string;
  limit?: number;
}): Promise<{ submitted: number; refused: number; failed: number }> {
  let query = supabase
    .from("project_beats")
    .select("project_id, beat_number, video_prompt, image_url, video_aspect_ratio, projects!inner(user_id)")
    .eq("video_status", GENAIPRO_QUEUED_STATUS)
    .ilike("video_model_id", `${GENAIPRO_MODEL_PREFIX}%`);
  if (opts?.projectId) query = query.eq("project_id", opts.projectId);
  const { data, error } = await query
    .order("beat_number", { ascending: true })
    .limit(opts?.limit ?? SUBMIT_MAX);
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
        .update({ video_status: "rendering", video_job_id: taskId, video_error: null, video_operator: OPERATOR_GENAIPRO })
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