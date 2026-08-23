import { NextResponse } from "next/server";
import { withCronRun } from "@/lib/cron/runs";
import { supabase } from "@/lib/supabase/client";

// Daily retention sweep for system_logs. Deletes rows older than 7 days
// so the admin Logs tab stays fast and the table doesn't grow unbounded.
// Scheduled in vercel.json — protected by the standard CRON_SECRET bearer
// check.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const RETENTION_DAYS = 7;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return withCronRun("cleanup-logs", async () => {
    const startedAt = Date.now();
    const cutoff = new Date(startedAt - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    try {
      const { data, error } = await supabase
        .from("system_logs")
        .delete()
        .lt("created_at", cutoff)
        .select("id");
      if (error) throw error;

      const deleted = data?.length ?? 0;
      const elapsed = Date.now() - startedAt;
      console.log(`[cleanup-logs] deleted=${deleted} older than ${cutoff} in ${elapsed}ms`);
      return NextResponse.json({ ok: true, deleted, cutoff, elapsedMs: elapsed });
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : "cleanup failed";
      console.error(`[cleanup-logs] failed after ${elapsed}ms — ${message}`);
      return NextResponse.json({ ok: false, error: message, elapsedMs: elapsed }, { status: 500 });
    }
  });
}
