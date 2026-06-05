import { NextResponse } from "next/server";
import { finishImageTask } from "@/lib/kie/finishImageTask";
import { KieUpstreamError } from "@/lib/kie/client";
import { supabase } from "@/lib/supabase/client";

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
//   - If the beat already has image_url, return 200 silently.
//   - If image_task_id is null (already finished by cron or foreground
//     poll), return 200 silently.
//   - Otherwise run finishImageTask. The conditional update inside it
//     guards against the rare cron+webhook race window.
//
// We always return 200 (even on internal errors) so KIE doesn't retry
// us into a tight loop on a transient bug — the cron will pick up
// anything we drop. Real failures are logged.

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface KieCallbackPayload {
  code?: number;
  msg?: string;
  data?: {
    task_id?: string;
    taskId?: string;
  };
}

export async function POST(req: Request) {
  let body: KieCallbackPayload;
  try {
    body = await req.json() as KieCallbackPayload;
  } catch {
    console.warn("[webhooks/kie/image] non-JSON body");
    return NextResponse.json({ ok: true });
  }

  // KIE callback uses snake_case task_id; tolerate camelCase too in case
  // the shape differs across model families.
  const taskId = body.data?.task_id ?? body.data?.taskId;
  if (!taskId) {
    console.warn(`[webhooks/kie/image] no task_id in payload: code=${body.code} msg=${body.msg}`);
    return NextResponse.json({ ok: true });
  }

  // Find the beat that owns this task. Join projects to grab the
  // user_id (needed for the storage path).
  const { data: row, error } = await supabase
    .from("project_beats")
    .select("beat_number, image_task_id, image_model_id, image_url, project_id, projects(user_id)")
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
  if (row.image_url) {
    // Already finished by cron or foreground poll — idempotent ack.
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
