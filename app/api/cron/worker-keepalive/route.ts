import { NextResponse } from "next/server";
import { withCronRun } from "@/lib/cron/runs";
import { WORKER_URL } from "@/lib/workerUrl";

// Pings the Render worker's /health endpoint on a schedule so the
// service doesn't sleep. Render's starter tier puts services to sleep
// after ~15 min of inactivity; when asleep the worker's poll loop
// stops claiming queued beats. A small periodic GET keeps the wire
// warm. Triggered by Vercel cron defined in vercel.json — protected
// by Vercel's automatic CRON_SECRET header check on Pro plans.

export const dynamic = "force-dynamic";
export const maxDuration = 60; // worker cold start can take ~30s

export async function GET(req: Request) {
  // Vercel cron requests carry the standard authorization header.
  // Reject any other caller to avoid being used as an open relay.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return withCronRun("worker-keepalive", async () => {
    const startedAt = Date.now();
    try {
      const res = await fetch(`${WORKER_URL}/health`, { cache: "no-store" });
      const text = await res.text();
      const elapsed = Date.now() - startedAt;
      console.log(`[worker-keepalive] ${res.status} in ${elapsed}ms — body=${text.slice(0, 200)}`);
      return NextResponse.json({ ok: res.ok, status: res.status, elapsedMs: elapsed });
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : "fetch failed";
      console.error(`[worker-keepalive] failed after ${elapsed}ms — ${message}`);
      return NextResponse.json({ ok: false, error: message, elapsedMs: elapsed }, { status: 502 });
    }
  });
}
