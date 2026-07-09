import { NextResponse } from "next/server";
import { finishImageTask } from "@/lib/kie/finishImageTask";
import { KieUpstreamError } from "@/lib/kie/client";
import { supabase } from "@/lib/supabase/client";
import { getConcurrencyConfig } from "@/lib/concurrency-config";

// Image-finisher cron. Scans project_beats for rows with an in-flight
// KIE task (image_task_id set, no image_url yet) and advances each one
// — uploads completed images to storage, marks failures, leaves pending
// tasks alone. Runs on Vercel cron defined in vercel.json. Protected by
// the Authorization: Bearer ${CRON_SECRET} header, matching the
// worker-keepalive pattern.
//
// Why this exists: image taskIds used to live only in the client's
// in-memory pending array. Tab close / refresh / poll-timeout dropped
// them on the floor, leaving KIE-generated images orphaned. The submit
// route now persists image_task_id; this cron finishes the work
// server-side so completion doesn't depend on whether the user's
// browser is still open.

export const dynamic = "force-dynamic";
// Backstop sweep of in-flight image tasks — needs room to download +
// re-upload large (4K) assets for several beats in one run.
export const maxDuration = 120;

// Stay well clear of KIE's per-key rate limit while still draining
// quickly — 5 concurrent polls + uploads is plenty for ~30 done beats
// per minute, which beats new submissions on most projects.
// Admin-tunable: product_config.batched_processes.finish_images_poll.
// The DB value is read once at the top of each cron tick below.

// Per-invocation cap so a giant backlog can't OOM us. The query is
// indexed via project_beats_inflight_image_idx; this just bounds work.
const MAX_PER_RUN = 100;

interface BeatRow {
  beat_number: number;
  image_task_id: string;
  image_model_id: string | null;
  project_id: string;
  projects: { user_id: string } | null;
}

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const startedAt = Date.now();

  // "image_task_id is not null" = the beat has an in-flight KIE task
  // we still owe completion work on. We deliberately do NOT filter on
  // image_url being null — on regeneration the row keeps the previous
  // gen's URL until the new one lands, and filtering that out would
  // make this cron skip every regen and leave them spinning forever
  // (same bug class as the webhook/finishImageTask fixes).
  const { data, error } = await supabase
    .from("project_beats")
    .select("beat_number, image_task_id, image_model_id, project_id, projects(user_id)")
    .not("image_task_id", "is", null)
    .limit(MAX_PER_RUN);

  if (error) {
    console.error(`[finish-images] query failed: ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as BeatRow[];
  if (rows.length === 0) {
    return NextResponse.json({ scanned: 0, completed: 0, failed: 0, pending: 0, durationMs: Date.now() - startedAt });
  }

  // Cache emails per userId so we hit auth.admin once per user, not
  // once per beat. userFolderFor prefers email for human-readable
  // bucket folders; if the lookup fails we fall back to userId.
  const emailCache = new Map<string, string | null>();
  async function emailFor(userId: string): Promise<string | null> {
    if (emailCache.has(userId)) return emailCache.get(userId) ?? null;
    try {
      const { data: u } = await supabase.auth.admin.getUserById(userId);
      const email = u?.user?.email ?? null;
      emailCache.set(userId, email);
      return email;
    } catch {
      emailCache.set(userId, null);
      return null;
    }
  }

  let completed = 0;
  let failed = 0;
  let pending = 0;
  let upstreamSkipped = 0;
  let errored = 0;

  let nextIdx = 0;
  async function worker() {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= rows.length) return;
      const r = rows[myIdx];
      const userId = r.projects?.user_id;
      if (!userId) {
        console.warn(`[finish-images] beat ${r.beat_number} project=${r.project_id} has no user_id — skipping`);
        errored++;
        continue;
      }

      try {
        const userEmail = await emailFor(userId);
        const result = await finishImageTask({
          projectId: r.project_id,
          beatNumber: r.beat_number,
          taskId: r.image_task_id,
          modelId: r.image_model_id ?? undefined,
          userId,
          userEmail,
        });
        if (result.status === "done") completed++;
        else if (result.status === "failed") { failed++; console.warn(`[finish-images] beat ${r.beat_number} failed: ${result.error}`); }
        else pending++;
      } catch (err) {
        if (err instanceof KieUpstreamError) {
          // Transient — the row's image_task_id stays put so the next
          // cron tick retries. Don't burn an attempt on the beat row.
          upstreamSkipped++;
          if (err.upstreamStatus !== 429) {
            console.warn(`[finish-images] beat ${r.beat_number} KIE ${err.upstreamStatus}: ${err.message.slice(0, 200)}`);
          }
        } else {
          errored++;
          console.error(`[finish-images] beat ${r.beat_number} error:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  const CONCURRENCY = (await getConcurrencyConfig()).finish_images_poll;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()));

  const durationMs = Date.now() - startedAt;
  console.log(`[finish-images] scanned=${rows.length} done=${completed} failed=${failed} pending=${pending} upstream=${upstreamSkipped} errored=${errored} in ${durationMs}ms`);
  return NextResponse.json({ scanned: rows.length, completed, failed, pending, upstreamSkipped, errored, durationMs });
}
