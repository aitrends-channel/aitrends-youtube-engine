// Attach old wallet charges to the video that caused them.
//
// Until the routes were fixed, five steps took their credit hold before
// reading the request body, so the reservation had no project id and neither
// did the ledger row it produced. The charge was real and the balance was
// right, but the video's Used chip could not see it: on one account the chip
// read 2.48 while 39.77 had been spent.
//
// The orphans are recoverable because project_costs recorded the same work
// with a project id. Matched on user, step and a ten minute window, and left
// alone whenever more than one video is a candidate rather than guessing.
//
//   node scripts/backfill-ledger-project-ids.mjs           # dry run
//   node scripts/backfill-ledger-project-ids.mjs --apply

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".env","utf8").split("\n").map(l=>l.trim())
  .filter(l=>l&&!l.startsWith("#")&&l.includes("=")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1).replace(/^["']|["']$/g,"")];}));
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");

const { data: orphans } = await sb.from("credit_ledger")
  .select("id, user_id, credits, note, created_at")
  .in("kind", ["spend","refund"]).is("project_id", null)
  .order("created_at", { ascending: true });

const WINDOW_MS = 10 * 60 * 1000;
for (const row of orphans) {
  const step = (row.note ?? "").split(" · ")[0].trim();
  if (!step || !(row.note ?? "").includes(" · ")) { console.log("skip (not a step row):", row.note); continue; }
  const t = Date.parse(row.created_at);
  const { data: costs } = await sb.from("project_costs")
    .select("project_id, created_at")
    .eq("user_id", row.user_id).eq("step", step)
    .gte("created_at", new Date(t - WINDOW_MS).toISOString())
    .lte("created_at", new Date(t + WINDOW_MS).toISOString());
  const projects = [...new Set((costs ?? []).map(c => c.project_id))];
  if (projects.length === 1) {
    console.log(`${row.created_at.slice(0,19)}  ${step.padEnd(17)} -> ${projects[0]}`);
    if (APPLY) {
      const { error } = await sb.from("credit_ledger").update({ project_id: projects[0] }).eq("id", row.id);
      if (error) console.log("   UPDATE FAILED:", error.message);
    }
  } else {
    console.log(`${row.created_at.slice(0,19)}  ${step.padEnd(17)} -> ${projects.length} candidates, left alone`);
  }
}
console.log(APPLY ? "\napplied" : "\ndry run, nothing written");
