// Backfill projects.assembled_duration_ms for videos assembled before the
// worker started stamping it (migration 113). Duration is read straight off
// the delivered mp4 with ffprobe over HTTP — the moov atom is at the front
// (+faststart), so this is a few range requests, not a download.
//
//   node scripts/backfill-video-duration.mjs                      # dry run, staging
//   node scripts/backfill-video-duration.mjs --apply
//   node scripts/backfill-video-duration.mjs --env ../.env.prod --apply
//
// Only touches rows where assembled_url is set and assembled_duration_ms is
// null, so it is safe to re-run. Videos whose URL no longer resolves (the
// retired supabase.co/storage bucket) are left null and listed at the end;
// the admin column renders those as a dash, which is the honest answer.

import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const envPath = args.includes("--env") ? args[args.indexOf("--env") + 1] : ".env";
const CONCURRENCY = args.includes("--concurrency") ? Number(args[args.indexOf("--concurrency") + 1]) : 6;

const env = Object.fromEntries(
  fs.readFileSync(envPath, "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);

const supabase = createClient(
  env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);

function probeDuration(url) {
  return new Promise((resolve) => {
    execFile("ffprobe", [
      "-v", "error",
      // Give up on a stalled connection rather than hanging the whole run.
      "-rw_timeout", "30000000",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      url,
    ], { timeout: 90_000 }, (err, stdout, stderr) => {
      if (err) {
        // ffprobe prefixes its message with the whole URL; we print that separately.
        const reason = (stderr || err.message).trim().split("\n").pop().replace(`${url}: `, "");
        return resolve({ error: reason });
      }
      const seconds = Number(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) return resolve({ error: `bad duration ${JSON.stringify(stdout.trim())}` });
      resolve({ seconds });
    });
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const fmt = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return `${h > 0 ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(sec).padStart(2, "0")}`;
};

const { data: rows, error } = await supabase
  .from("projects")
  .select("id, assembled_url, selected_topic")
  .not("assembled_url", "is", null)
  .is("assembled_duration_ms", null)
  .order("created_at", { ascending: false });

if (error) { console.error(`Query failed: ${error.message}`); process.exit(1); }

console.log(`${env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL}`);
console.log(`${rows.length} video${rows.length === 1 ? "" : "s"} missing a duration — ${APPLY ? "APPLYING" : "dry run"}\n`);

const failures = [];
let done = 0;

const results = await mapLimit(rows, CONCURRENCY, async (row) => {
  const { seconds, error: probeError } = await probeDuration(row.assembled_url);
  done++;
  if (probeError) {
    failures.push({ id: row.id, url: row.assembled_url, reason: probeError });
    console.log(`  [${done}/${rows.length}] ${row.id}  FAILED  ${probeError}`);
    return null;
  }
  console.log(`  [${done}/${rows.length}] ${row.id}  ${fmt(seconds).padStart(8)}  ${(row.selected_topic || "").slice(0, 50)}`);
  return { id: row.id, ms: Math.round(seconds * 1000) };
});

const probed = results.filter(Boolean);

if (APPLY && probed.length) {
  let written = 0;
  for (const { id, ms } of probed) {
    const { error: updateError } = await supabase.from("projects").update({ assembled_duration_ms: ms }).eq("id", id);
    if (updateError) failures.push({ id, url: "(update)", reason: updateError.message });
    else written++;
  }
  console.log(`\nWrote ${written} duration${written === 1 ? "" : "s"}.`);
} else if (probed.length) {
  console.log(`\nDry run — ${probed.length} would be written. Re-run with --apply.`);
}

const totalSeconds = probed.reduce((a, r) => a + r.ms / 1000, 0);
console.log(`Probed ${probed.length}/${rows.length}, ${fmt(totalSeconds)} of video total.`);

if (failures.length) {
  console.log(`\n${failures.length} left null:`);
  for (const f of failures) console.log(`  ${f.id}  ${f.reason}\n    ${f.url}`);
}
