import { NextResponse } from "next/server";
import { finishImageTask } from "@/lib/operators/finishImage";
import { KieUpstreamError } from "@/lib/kie/client";
import { supabase } from "@/lib/supabase/client";
import { verifyKieWebhookSignature, getKieWebhookSecret } from "@/lib/kie/webhook";

// KIE webhook receiver for image task completions. KIE POSTs here the
// moment a submitted image finishes (success or failure). We don't
// trust the callback payload directly — we look up the beat by
// task_id, then call our standard finishImageTask helper which hits
// recordInfo and normalizes the result the same way the foreground
// poll and cron paths do. That keeps one source of truth for the
// "upload to storage + update beat row" logic.
//
// Idempotency: KIE warns "the same task_id may receive multiple
// callbacks, ensure processing logic is idempotent." Our pattern:
//   - Look up the beat by image_task_id = taskId. The first path
//     that finishes a task (webhook, poll, or cron) clears
//     image_task_id to null inside finishImageTask, so a duplicate
//     callback for the same task finds no beat and is a no-op.
//   - finishImageTask itself uses .eq("image_task_id", taskId) in
//     its UPDATE as a second-level guard against the cron+webhook
//     race window — only the first writer's UPDATE matches.
//
// We do NOT check row.image_url here. On regeneration the beat
// row carries the previous gen's URL from the moment the user
// clicks Regenerate (we don't wipe it because we want to keep
// showing the old frame in the UI until the new one lands). An
// "if image_url" guard would silently swallow every regeneration
// webhook and leave the new URL forever unwritten — that was the
// "regen finished in KIE but UI never updated" bug.
//
// We always return 200 (even on internal errors) so KIE doesn't retry
// us into a tight loop on a transient bug — the cron will pick up
// anything we drop. Real failures are logged.

export const dynamic = "force-dynamic";
// Higher ceiling so finishing a large asset (e.g. nano-banana-pro at 4K,
// downloaded in full and re-uploaded to R2) completes rather than timing
// out mid-transfer and dropping the completion to the slower cron.
export const maxDuration = 120;

interface KieCallbackPayload {
  code?: number;
  msg?: string;
  data?: {
    task_id?: string;
    taskId?: string;
  };
}

export async function POST(req: Request) {
  // Read the body once as text so we can hand it to the signature
  // verifier (which parses it) and still re-JSON-parse below without
  // consuming the request stream twice.
  const bodyText = await req.text();

  // Verify HMAC-SHA256 signature against `${taskId}.${timestamp}` per
  // docs.kie.ai/common-api/webhook-verification. Returns 401 on
  // mismatch — KIE may retry, which is fine if a secret rotation is
  // in progress. If KIE_WEBHOOK_HMAC_KEY isn't set the verifier
  // returns false and everything is rejected: that's the intentional
  // fail-closed behavior so a misconfigured env can't accept forged
  // webhooks and poison beat state.
  const verify = verifyKieWebhookSignature(req.headers, bodyText, getKieWebhookSecret());
  if (!verify.ok) {
    console.warn(`[webhooks/kie/image] rejected: ${verify.reason}`);
    return NextResponse.json({ error: verify.reason }, { status: 401 });
  }

  let body: KieCallbackPayload;
  try {
    body = JSON.parse(bodyText) as KieCallbackPayload;
  } catch {
    console.warn("[webhooks/kie/image] non-JSON body");
    return NextResponse.json({ ok: true });
  }

  // Prefer the verifier's parsed taskId (it already validated the
  // signature against this value). Fall back to the body's data for
  // any edge case where the top-level taskId is absent but data.task_id
  // is set.
  const taskId = verify.taskId ?? body.data?.task_id ?? body.data?.taskId;
  if (!taskId) {
    console.warn(`[webhooks/kie/image] no task_id in payload: code=${body.code} msg=${body.msg}`);
    return NextResponse.json({ ok: true });
  }

  // Find the beat that owns this task. Join projects to grab the
  // user_id (needed for the storage path).
  const { data: row, error } = await supabase
    .from("project_beats")
    .select("beat_number, image_task_id, image_model_id, image_operator, image_url, project_id, projects(user_id)")
    .eq("image_task_id", taskId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[webhooks/kie/image] lookup failed for task ${taskId}: ${error.message}`);
    return NextResponse.json({ ok: true });
  }
  if (!row) {
    // No beat owns this task — either an old/stray callback or someone
    // poking the endpoint. Silently ack.
    console.log(`[webhooks/kie/image] no beat for task ${taskId}`);
    return NextResponse.json({ ok: true });
  }
  // No row.image_url guard here — see header comment. The
  // image_task_id lookup above is the real idempotency check; if
  // another path already finished this task it cleared the id and
  // our maybeSingle() returned null (handled above).
  // Defensive, mirroring the PoYo receiver: a KIE callback for a task stamped
  // to another operator is either an id collision or a forgery, and finishing
  // it would poll the wrong provider.
  if (row.image_operator && row.image_operator !== "kie") {
    console.warn(`[webhooks/kie/image] task ${taskId} belongs to operator ${row.image_operator}, ignoring`);
    return NextResponse.json({ ok: true });
  }

  const projectRel = row.projects as unknown as { user_id: string } | null;
  const userId = projectRel?.user_id;
  if (!userId) {
    console.warn(`[webhooks/kie/image] beat ${row.beat_number} project=${row.project_id} has no user_id`);
    return NextResponse.json({ ok: true });
  }

  let userEmail: string | null = null;
  try {
    const { data: u } = await supabase.auth.admin.getUserById(userId);
    userEmail = u?.user?.email ?? null;
  } catch {
    // Falls back to userId in userFolderFor — non-fatal.
  }

  try {
    const result = await finishImageTask({
      projectId: row.project_id,
      beatNumber: row.beat_number,
      taskId,
      modelId: row.image_model_id ?? undefined,
      operator: row.image_operator,
      userId,
      userEmail,
    });
    console.log(`[webhooks/kie/image] beat=${row.beat_number} task=${taskId} status=${result.status}`);
  } catch (err) {
    if (err instanceof KieUpstreamError) {
      console.warn(`[webhooks/kie/image] KIE ${err.upstreamStatus} on task ${taskId}: ${err.message.slice(0, 200)}`);
    } else {
      console.error(`[webhooks/kie/image] task ${taskId} error:`, err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({ ok: true });
}
