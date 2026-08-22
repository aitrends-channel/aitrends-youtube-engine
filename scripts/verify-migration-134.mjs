// Verify migration 134: the operator columns exist, every row has one, and the
// GenAIPro backfill labelled exactly the free-lane rows and nothing else.
//
// Counted server-side rather than pulled. PostgREST caps a select at 1000 rows,
// so a first version of this scanned the first thousand beats and reported a
// clean table it had not looked at.
//
//   node scripts/verify-migration-134.mjs .env                 # dev
//   node scripts/verify-migration-134.mjs .env.prod.readonly   # prod
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const envPath = process.argv[2];
if (!envPath) { console.error("usage: verify-migration-134.mjs <env-file>"); process.exit(2); }
const env = Object.fromEntries(
  fs.readFileSync(envPath, "utf8").split("\n").map(l => l.trim())
    .filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));

const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false } });

let bad = 0;
const say = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); };

/** Exact server-side count, no rows transferred. */
async function count(build) {
  const { count: n, error } = await build(db.from("project_beats").select("*", { count: "exact", head: true }));
  if (error) throw error;
  return n ?? 0;
}

const total = await count(q => q);
console.log(`${total} beats in project_beats (${envPath})\n`);

// 1. Every row has an operator. NOT NULL DEFAULT means a null is impossible
//    unless the migration did not apply as written.
say(await count(q => q.is("image_operator", null)) === 0, "no null image_operator");
say(await count(q => q.is("video_operator", null)) === 0, "no null video_operator");

// 2. Distribution, so the numbers are on the record rather than just the verdict.
for (const col of ["image_operator", "video_operator"]) {
  const parts = [];
  for (const op of ["kie", "genaipro"]) parts.push(`${op}=${await count(q => q.eq(col, op))}`);
  const other = await count(q => q.not(col, "in", "(kie,genaipro)"));
  parts.push(`other=${other}`);
  say(other === 0, `${col}: ${parts.join("  ")}`);
}

// 3. The backfill, both directions. These are the two ways it could be wrong:
//    a free-lane beat left on kie, or a paid beat swept into genaipro.
const genaiTotal = await count(q => q.ilike("video_model_id", "genaipro%"));
const missed = await count(q => q.ilike("video_model_id", "genaipro%").neq("video_operator", "genaipro"));
const swept = await count(q => q.eq("video_operator", "genaipro").not("video_model_id", "ilike", "genaipro%"));
say(missed === 0, `all ${genaiTotal} genaipro-model beats labelled genaipro (${missed} missed)`);
say(swept === 0, `no non-genaipro beat labelled genaipro (${swept} swept in)`);

// 4. In-flight work, where a wrong operator costs a stranded reservation rather
//    than a wrong report. Small enough to pull.
const { data: inflight, error: ifErr } = await db.from("project_beats")
  .select("project_id, beat_number, video_model_id, video_operator, video_job_id")
  .not("video_job_id", "is", null);
if (ifErr) throw ifErr;
const imgInflight = await count(q => q.not("image_task_id", "is", null));
console.log(`\nin flight: ${imgInflight} image, ${inflight.length} video`);
for (const r of inflight) {
  const model = r.video_model_id;
  if (!model) {
    // Not a failure of the migration: the operator cannot be derived from a
    // null model either way, and 'kie' is what actually ran it. Surfaced
    // because it is the one case the backfill could not have checked.
    console.log(`note  beat ${r.beat_number} has a job id but no model; operator=${r.video_operator} by default`);
    continue;
  }
  const expect = model.toLowerCase().startsWith("genaipro") ? "genaipro" : "kie";
  say(r.video_operator === expect, `in-flight beat ${r.beat_number} model=${model} operator=${r.video_operator} (expected ${expect})`);
}

// 5. The check constraint is real. Attempted against a row that is not in
//    flight, and reverted if the database wrongly accepts it.
const { data: victim } = await db.from("project_beats")
  .select("project_id, beat_number, image_operator").is("image_task_id", null).limit(1).maybeSingle();
if (victim) {
  const { error: ckErr } = await db.from("project_beats")
    .update({ image_operator: "definitely-not-an-operator" })
    .eq("project_id", victim.project_id).eq("beat_number", victim.beat_number);
  say(!!ckErr, `check constraint rejects an unknown operator${ckErr ? "" : " — IT DID NOT, the write went through"}`);
  if (!ckErr) {
    await db.from("project_beats").update({ image_operator: victim.image_operator })
      .eq("project_id", victim.project_id).eq("beat_number", victim.beat_number);
    console.log("     (reverted the test write)");
  }
}

console.log(bad === 0 ? "\nPASS: migration 134 verified" : `\nFAIL: ${bad} problems`);
process.exit(bad === 0 ? 0 : 1);
