import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { uploadFromUrl, userFolderFor, r2KeyFromUrl, deleteObject } from "@/lib/supabase/storage";
import { verifyKieWebhookSignature, getKieWebhookSecret, type KieWebhookPayload } from "@/lib/kie/webhook";

// KIE video-completion webhook. Fires the moment a submitted video
// task lands terminal (success or failure) on KIE's side. Cuts the
// "generation done, UI still generating" window from ~10-20s (worker
// poll interval + Vercel/SWR latency) down to a webhook + DB write
// + SWR refresh (~4s max, usually under 2s).
//
// Design mirrors the image webhook: verify HMAC signature, look up the
// beat by video_job_id (the KIE taskId the worker persisted after
// submit), extract the terminal state from the payload, upload the
// KIE-hosted video to R2, and commit to the beat row. Idempotency
// falls out of the commit guard — a duplicate delivery lands on a
// beat already in "done" state and the UPDATE matches zero rows.
//
// If the payload doesn't carry a video URL, we ACK and let the
// worker's backstop poll finalize the beat instead of failing loudly —
// KIE occasionally sends multi-stage callbacks and we shouldn't
// nuke a beat just because the first callback was informational.

export const dynamic = "force-dynamic";
// R2 upload of a ~50-100MB video can take 20-45s. Fluid Compute
// default 300s is comfortably above that; explicit budget guards
// against a cold-boot misconfig cutting a video upload short.
export const maxDuration = 120;

// Pull the terminal state + URL / error out of the webhook payload.
// KIE's video callbacks share the same body shape as recordInfo, so
// the extraction covers the fields the worker's pollVideoJob already
// reads.
function classifyVideoWebhook(payload: KieWebhookPayload): {
  kind: "done"; url: string;
} | {
  kind: "failed"; error: string;
} | {
  kind: "pending";
} {
  const d = payload.data ?? {};
  const DONE = ["succeed", "success", "completed", "done", "finish", "finished", "complete", "task_completed"];
  const FAIL = ["failed", "error", "fail"];

  // Top-level KIE envelope check FIRST. KIE fires webhooks for failed
  // submits (safety filter blocks, invalid input, insufficient credits,
  // etc.) as {code: non-200, msg: "...", data: {taskId}} — none of the
  // nested state/status/successFlag fields we look at below are set.
  // Without this branch the classifier fell through to "pending", the
  // handler ACKed 200, and the beat sat rendering until the sweeper
  // eventually reclaimed it — the failure was silently dropped.
  if (typeof payload.code === "number" && payload.code !== 200) {
    const reason = (payload.msg ?? "").trim()
      || extractFailureReason(d)
      || `KIE returned code ${payload.code}`;
    return { kind: "failed", error: reason };
  }

  // Veo path: success/failure encoded in successFlag (1 = success,
  // 2/3 = failure). The video URL lives at data.response.resultUrls[0]
  // (Veo's real shape), with flat videoUrl/video_url as fallbacks.
  if (typeof d.successFlag === "number") {
    if (d.successFlag === 1) {
      const url =
        d.response?.resultUrls?.[0]
        ?? d.response?.fullResultUrls?.[0]
        ?? d.response?.full_result_urls?.[0]
        ?? (d.videoUrl as string | undefined)
        ?? (d.video_url as string | undefined);
      if (url) return { kind: "done", url };
      // successFlag=1 but no URL yet: Veo reports the base render "done"
      // then runs a separate upscale pass before the URL is populated.
      // Treat as pending (NOT failed) so we ACK and let the worker's
      // record-info poll finalize the beat once the URL lands — marking
      // it failed here nukes an in-flight job that's about to succeed.
      return { kind: "pending" };
    }
    if (d.successFlag === 0) return { kind: "pending" };
    const reason = extractFailureReason(d);
    return { kind: "failed", error: reason ?? `KIE failure code ${d.successFlag}` };
  }

  // Generic jobs/recordInfo path — state / status string plus various
  // URL fields depending on the model.
  const normalized = String(d.state ?? d.status ?? d.callbackType ?? "").toLowerCase();
  if (DONE.includes(normalized)) {
    // Try every known video-URL location.
    let url: string | undefined =
      (d.videoUrl as string | undefined)
      ?? (d.video_url as string | undefined)
      ?? (typeof d.videoInfo === "object" && d.videoInfo ? (d.videoInfo as { videoUrl?: string }).videoUrl : undefined);
    // Some models nest the URL inside resultJson (a JSON string).
    if (!url && typeof d.resultJson === "string") {
      try {
        const parsed = JSON.parse(d.resultJson) as { url?: string; resultUrls?: string[]; videoUrl?: string };
        url = parsed.videoUrl ?? parsed.url ?? parsed.resultUrls?.[0];
      } catch { /* ignore */ }
    }
    // Fallback to output field (string, array, or object).
    if (!url && typeof d.output === "string") url = d.output;
    if (!url && Array.isArray(d.output)) url = d.output[0];
    if (!url && d.output && typeof d.output === "object" && !Array.isArray(d.output)) {
      const o = d.output as unknown as Record<string, unknown>;
      url = (o.videoUrl as string | undefined) ?? (o.url as string | undefined);
    }
    if (!url) return { kind: "failed", error: "Video task completed but no URL in payload" };
    return { kind: "done", url };
  }
  if (FAIL.includes(normalized)) {
    const reason = extractFailureReason(d);
    return { kind: "failed", error: reason ?? "KIE returned failure with no reason" };
  }
  return { kind: "pending" };
}

function extractFailureReason(d: NonNullable<KieWebhookPayload["data"]>): string | null {
  const candidates = [d.failMsg, d.failReason, d.error, d.errorMessage];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const code = d.failCode ?? d.errorCode;
  if (code !== null && code !== undefined && String(code).trim()) {
    return `fail code ${String(code).trim()}`;
  }
  return null;
}

export async function POST(req: Request) {
  const bodyText = await req.text();

  // Verify HMAC-SHA256 against `${taskId}.${timestamp}` per docs.kie.ai
  // /common-api/webhook-verification. Fail-closed on missing secret so
  // a misconfigured env can't accept forged callbacks.
  const verify = verifyKieWebhookSignature(req.headers, bodyText, getKieWebhookSecret());
  if (!verify.ok) {
    console.warn(`[webhooks/kie/video] rejected: ${verify.reason}`);
    return NextResponse.json({ error: verify.reason }, { status: 401 });
  }
  const { taskId } = verify;

  let payload: KieWebhookPayload;
  try { payload = JSON.parse(bodyText) as KieWebhookPayload; }
  catch { return NextResponse.json({ ok: true }); }

  // Look up the beat by video_job_id (the taskId the worker persisted
  // after submitVideoJob returned).
  const { data: beatRow, error: beatErr } = await supabase
    .from("project_beats")
    .select(`
      beat_number, project_id, video_url, video_status, video_job_id,
      projects!inner(user_id)
    `)
    .eq("video_job_id", taskId)
    .maybeSingle();
  if (beatErr) {
    console.error(`[webhooks/kie/video] beat lookup failed for taskId ${taskId}:`, beatErr.message);
    return NextResponse.json({ error: beatErr.message }, { status: 500 });
  }
  if (!beatRow) {
    // Beat isn't ours or the task was superseded by a regen. Ack so
    // KIE stops retrying.
    console.log(`[webhooks/kie/video] taskId ${taskId} not attached to any beat — acking`);
    return NextResponse.json({ ok: true, matched: 0 });
  }
  const proj = Array.isArray(beatRow.projects) ? beatRow.projects[0] : beatRow.projects as Record<string, unknown>;
  const userId = proj?.user_id as string;
  if (!userId) {
    console.error(`[webhooks/kie/video] beat ${beatRow.beat_number} has no owning user`);
    return NextResponse.json({ error: "beat missing user" }, { status: 500 });
  }

  const classification = classifyVideoWebhook(payload);
  console.log(`[webhooks/kie/video] beat=${beatRow.beat_number} task=${taskId} classification=${classification.kind}`);

  if (classification.kind === "pending") {
    // Multi-stage KIE callback (e.g. task_accepted). Nothing to persist yet.
    return NextResponse.json({ ok: true, status: "pending" });
  }

  if (classification.kind === "failed") {
    // Guard on the beat still being in an active state — if the user
    // cancelled the beat mid-flight, don't overwrite the "Cancelled by
    // user" reason with a KIE failure that landed after the cancel.
    await supabase
      .from("project_beats")
      .update({ video_status: "failed", video_error: classification.error, video_job_id: null })
      .eq("project_id", beatRow.project_id)
      .eq("beat_number", beatRow.beat_number)
      .in("video_status", ["submitting", "rendering"])
      .eq("video_job_id", taskId);
    return NextResponse.json({ ok: true, status: "failed" });
  }

  // done — grab the previous video URL for orphan cleanup, upload the
  // new KIE-hosted video to R2, commit under the same idempotency
  // guard the worker uses.
  let userEmail: string | null = null;
  try {
    const { data: u } = await supabase.auth.admin.getUserById(userId);
    userEmail = u?.user?.email ?? null;
  } catch { /* fall back to userId in the folder path */ }

  const folder = userFolderFor({ id: userId, email: userEmail });
  const storagePath = `${folder}/${beatRow.project_id}/videos/beat-${beatRow.beat_number}_${Date.now()}.mp4`;

  let publicUrl: string;
  try {
    publicUrl = await uploadFromUrl(storagePath, classification.url, "video/mp4");
    console.log(`[webhooks/kie/video] beat=${beatRow.beat_number} uploaded ${publicUrl.slice(0, 80)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "R2 upload failed";
    console.error(`[webhooks/kie/video] beat=${beatRow.beat_number} R2 upload failed:`, message);
    // Same failure marking as the worker's catch handler — the beat
    // shows as failed and the user can retry. Guard on being still
    // in-flight so a cancel doesn't get resurrected.
    await supabase.from("project_beats")
      .update({ video_status: "failed", video_error: message })
      .eq("project_id", beatRow.project_id)
      .eq("beat_number", beatRow.beat_number)
      .in("video_status", ["submitting", "rendering"])
      .eq("video_job_id", taskId);
    // Return 500 so KIE retries the webhook — R2 might have been a
    // transient blip and the retry could succeed.
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Commit with the same guard the worker uses: only overwrite if the
  // beat is still in submitting/rendering AND we still own the job_id.
  // Prevents a cancelled beat from getting resurrected by a late
  // webhook delivery.
  const previousUrl = beatRow.video_url as string | null;
  const { data: committed } = await supabase.from("project_beats")
    .update({ video_url: publicUrl, video_status: "done" })
    .eq("project_id", beatRow.project_id)
    .eq("beat_number", beatRow.beat_number)
    .in("video_status", ["submitting", "rendering"])
    .eq("video_job_id", taskId)
    .select("beat_number");

  if (!committed || committed.length === 0) {
    // Beat was cancelled / completed by the worker's fallback poll /
    // superseded by a regen — the new upload is an orphan. Best-effort
    // R2 cleanup.
    console.log(`[webhooks/kie/video] beat ${beatRow.beat_number} no longer in flight — cleaning orphan`);
    const orphanKey = r2KeyFromUrl(publicUrl);
    if (orphanKey) {
      try { await deleteObject(orphanKey); }
      catch (e) { console.warn(`[webhooks/kie/video] orphan delete failed:`, e instanceof Error ? e.message : e); }
    }
    return NextResponse.json({ ok: true, orphaned: true });
  }

  // Committed — try to clean up the previous R2 object.
  if (previousUrl && previousUrl !== publicUrl) {
    const oldKey = r2KeyFromUrl(previousUrl);
    if (oldKey) {
      try {
        await deleteObject(oldKey);
        console.log(`[webhooks/kie/video] deleted previous ${oldKey}`);
      } catch (e) {
        console.warn(`[webhooks/kie/video] previous delete failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  // Bump the project's videos_progress counter — matches the worker's
  // atomic increment so the UI progress bar advances even when the
  // webhook (not the worker) is what finalized the beat.
  try {
    await supabase.rpc("increment_videos_progress", { p_project_id: beatRow.project_id });
  } catch (e) {
    console.warn(`[webhooks/kie/video] videos_progress increment failed:`, e instanceof Error ? e.message : e);
  }

  return NextResponse.json({ ok: true, status: "done" });
}
