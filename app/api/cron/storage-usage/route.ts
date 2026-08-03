import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { listAllObjects, listTopLevelPrefixes } from "@/lib/supabase/storage";

// R2 storage sweep, every 6 hours. Sums bytes per top-level prefix
// (userFolderFor = lowercased email, or uuid) and caches the totals in
// storage_usage for the cap check to read.
//
// A sweep rather than summing on demand: heavy accounts already hold 27k+
// objects, so a live sum is far too slow for an upload path. The whole
// estate is ~195k objects, which is ~195 Class B ops — a rounding error
// against R2's free tier, which is why this runs 4x a day rather than
// nightly: it bounds how far a heavy account can overshoot its cap between
// sweeps to one generating session, at no real cost.
//
// Account prefixes are walked concurrently because listing is latency-bound
// (a page is 1000 keys, one round trip) — serially the whole estate took
// ~190s, uncomfortably close to maxDuration.
//
// Scheduled in vercel.json, protected by the standard CRON_SECRET bearer
// check.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const WALK_CONCURRENCY = 8;

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const startedAt = Date.now();
  const byPrefix = new Map<string, { bytes: number; count: number }>();

  try {
    const prefixes = await listTopLevelPrefixes();
    const queue = [...prefixes];

    const walk = async () => {
      for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
        const key = p.toLowerCase();
        const entry = { bytes: 0, count: 0 };
        for await (const obj of listAllObjects(`${p}/`)) {
          entry.bytes += obj.size;
          entry.count += 1;
        }
        // Merged rather than set: two folders differing only in case share
        // one row, since the cap check looks up a lowercased prefix.
        const existing = byPrefix.get(key);
        if (existing) {
          existing.bytes += entry.bytes;
          existing.count += entry.count;
        } else {
          byPrefix.set(key, entry);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(WALK_CONCURRENCY, queue.length) }, walk));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[cron/storage-usage] bucket walk failed:", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Resolve prefixes to user ids so the per-user read and RLS work. Prefixes
  // that match no account (deleted users) keep a null user_id — their bytes
  // still count toward the estate total in the admin view.
  const emailToId = new Map<string, string>();
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    for (const u of data.users) if (u.email) emailToId.set(u.email.toLowerCase(), u.id);
    if (data.users.length < 1000) break;
  }

  const measured_at = new Date().toISOString();
  const rows = [...byPrefix.entries()].map(([prefix, v]) => ({
    prefix,
    user_id: emailToId.get(prefix) ?? null,
    bytes: v.bytes,
    object_count: v.count,
    measured_at,
  }));

  // bonus_bytes is deliberately absent from the upsert payload so an admin
  // grant survives every sweep.
  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await supabase.from("storage_usage").upsert(chunk, { onConflict: "prefix" });
    if (error) console.error(`[cron/storage-usage] upsert chunk ${i} failed:`, error.message);
    else written += chunk.length;
  }

  const totalBytes = rows.reduce((a, r) => a + r.bytes, 0);
  const summary = {
    accounts: rows.length,
    written,
    totalGb: +(totalBytes / 1024 ** 3).toFixed(2),
    objects: rows.reduce((a, r) => a + r.object_count, 0),
    ms: Date.now() - startedAt,
  };
  console.log("[cron/storage-usage]", JSON.stringify(summary));
  return NextResponse.json({ ok: true, ...summary });
}
