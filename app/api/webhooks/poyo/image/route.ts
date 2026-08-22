import { NextResponse } from "next/server";
import { finishImageTask } from "@/lib/operators/finishImage";
import { asUpstreamError } from "@/lib/operators/upstream";
import { supabase } from "@/lib/supabase/client";
import { verifyPoyoCallbackToken } from "@/lib/poyo/webhook";

// PoYo webhook receiver for image task completions.
//
// Structurally the same as the KIE receiver: look the beat up by task id, hand
// it to finishImageTask, always ack. Two differences, both forced by PoYo not
// signing its callbacks (see lib/poyo/webhook.ts):
//
//   - Authentication is a capability token in the query string rather than an
//     HMAC over the body.
//   - The payload is read for a task id and nothing else. Status and result
//     URL are deliberately ignored even though PoYo sends them, because an
//     unsigned body must not be allowed to write a beat. finishImageTask
//     re-reads the task over the authenticated API and that answer is the one
//     that lands.
//
// Idempotency is inherited: the first path to finish a task (webhook, poll or
// cron) clears image_task_id, so a duplicate callback finds no beat.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface PoyoCallbackPayload {
  code?: number;
  data?: { task_id?: string; taskId?: string; status?: string };
  task_id?: string;
}

export async function POST(req: Request) {
  const verify = verifyPoyoCallbackToken(req.url);
  if (!verify.ok) {
    console.warn(`[webhooks/poyo/image] rejected: ${verify.reason}`);
    return NextResponse.json({ error: verify.reason }, { status: 401 });
  }

  let body: PoyoCallbackPayload;
  try {
    body = (await req.json()) as PoyoCallbackPayload;
  } catch {
    console.warn("[webhooks/poyo/image] non-JSON body");
    return NextResponse.json({ ok: true });
  }

  const taskId = body.data?.task_id ?? body.data?.taskId ?? body.task_id;
  if (!taskId) {
    console.warn(`[webhooks/poyo/image] no task_id in payload: code=${body.code}`);
    return NextResponse.json({ ok: true });
  }

  const { data: row, error } = await supabase
    .from("project_beats")
    .select("beat_number, image_task_id, image_model_id, image_operator, project_id, projects(user_id)")
    .eq("image_task_id", taskId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[webhooks/poyo/image] lookup failed for task ${taskId}: ${error.message}`);
    return NextResponse.json({ ok: true });
  }
  if (!row) {
    console.log(`[webhooks/poyo/image] no beat for task ${taskId}`);
    return NextResponse.json({ ok: true });
  }

  // A PoYo callback naming a task stamped to another operator means either a
  // task id collision across providers or a forged delivery. Either way, do
  // not touch the beat: finishing it would poll the wrong provider.
  if (row.image_operator !== "poyo") {
    console.warn(`[webhooks/poyo/image] task ${taskId} belongs to operator ${row.image_operator}, ignoring`);
    return NextResponse.json({ ok: true });
  }

  const projectRel = row.projects as unknown as { user_id: string } | null;
  const userId = projectRel?.user_id;
  if (!userId) {
    console.warn(`[webhooks/poyo/image] beat ${row.beat_number} project=${row.project_id} has no user_id`);
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
    console.log(`[webhooks/poyo/image] beat=${row.beat_number} task=${taskId} status=${result.status}`);
  } catch (err) {
    const upstream = asUpstreamError(err);
    if (upstream) {
      console.warn(`[webhooks/poyo/image] PoYo ${upstream.upstreamStatus} on task ${taskId}: ${upstream.message.slice(0, 200)}`);
    } else {
      console.error(`[webhooks/poyo/image] task ${taskId} error:`, err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({ ok: true });
}
