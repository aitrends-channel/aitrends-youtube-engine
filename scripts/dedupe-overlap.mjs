// One-off backfill: walk every beat of one (or all) project(s), trim
// any leading text that duplicates the previous beat's ending, and
// persist the cleaned script_segment back to the DB.
//
// Usage (from repo root):
//   node scripts/dedupe-overlap.mjs                 # all projects, dry run
//   node scripts/dedupe-overlap.mjs --apply         # all projects, write
//   node scripts/dedupe-overlap.mjs <projectId>     # one project, dry run
//   node scripts/dedupe-overlap.mjs <projectId> --apply
//
// Dry-run prints each beat that WOULD be trimmed and the before/after
// for verification. With --apply it commits the change to the DB.
// Audio files are NOT touched; the voiceover_script_hash mismatch
// after this fix will mark affected beats as stale on the next bulk
// Generate run, so the user can choose when to regenerate audio.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

function loadEnv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const idx = l.indexOf("=");
        const k = l.slice(0, idx);
        let v = l.slice(idx + 1);
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        return [k, v];
      })
  );
}

// .env first, then .env.local overrides — matches how Next.js loads.
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SUPABASE_URL =
  env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY =
  env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// ── arg parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const projectIdArg = args.find((a) => !a.startsWith("--"));

// ── dedupe algorithm (mirrors lib/text/dedupeOverlap.ts) ─────────────
const SINGLE_WORD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "so", "of", "to", "in", "on", "at",
  "by", "for", "with", "from", "as", "is", "it", "its", "he", "she", "we",
  "i", "you", "they", "them", "us", "was", "were", "are", "be", "been",
  "has", "had", "have", "do", "did", "does", "this", "that", "these",
  "those", "if", "then", "than", "when", "while", "yet", "not", "no",
]);

function dedupeOverlap(current, previous) {
  if (!previous) return current;
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const cur = current.trim().split(/\s+/).filter(Boolean);
  const prev = previous.trim().split(/\s+/).filter(Boolean);
  const maxK = Math.min(cur.length, prev.length, 12);
  for (let k = maxK; k >= 1; k--) {
    const prevTail = prev.slice(-k).map(norm);
    const curHead = cur.slice(0, k).map(norm);
    const allMatch = prevTail.every((w, i) => w === curHead[i] && w !== "");
    if (!allMatch) continue;
    if (k === 1) {
      const word = prevTail[0];
      if (word.length < 3) continue;
      if (SINGLE_WORD_STOPWORDS.has(word)) continue;
    }
    const trimmed = cur.slice(k).join(" ");
    return trimmed || current;
  }
  return current;
}

// ── per-project pass ─────────────────────────────────────────────────
async function processProject(projectId) {
  const { data: beats, error } = await supabase
    .from("project_beats")
    .select("beat_number, script_segment")
    .eq("project_id", projectId)
    .order("beat_number");
  if (error) {
    console.error(`  ERROR loading beats: ${error.message}`);
    return { fixed: 0, total: 0 };
  }
  if (!beats?.length) return { fixed: 0, total: 0 };

  const updates = [];
  let previousOriginal = null;
  for (const b of beats) {
    const current = (b.script_segment ?? "").trim();
    const prev = previousOriginal;
    previousOriginal = current;
    if (!current) continue;
    const trimmed = dedupeOverlap(current, prev);
    if (trimmed !== current) {
      updates.push({ beat_number: b.beat_number, before: current, after: trimmed });
    }
  }

  if (updates.length === 0) {
    console.log(`  ${beats.length} beats — clean.`);
    return { fixed: 0, total: beats.length };
  }

  console.log(`  ${updates.length}/${beats.length} beat(s) have overlap:`);
  for (const u of updates) {
    const beforeSnip = u.before.length > 70 ? u.before.slice(0, 70) + "…" : u.before;
    const afterSnip = u.after.length > 70 ? u.after.slice(0, 70) + "…" : u.after;
    console.log(`    beat ${u.beat_number}: "${beforeSnip}"`);
    console.log(`           → "${afterSnip}"`);
  }

  if (!APPLY) {
    console.log(`  (dry run — pass --apply to commit)`);
    return { fixed: 0, total: beats.length };
  }

  for (const u of updates) {
    const { error: upErr } = await supabase
      .from("project_beats")
      .update({ script_segment: u.after })
      .eq("project_id", projectId)
      .eq("beat_number", u.beat_number);
    if (upErr) {
      console.error(`    UPDATE beat ${u.beat_number} failed: ${upErr.message}`);
      return { fixed: updates.indexOf(u), total: beats.length, err: true };
    }
  }
  console.log(`  ✓ applied ${updates.length} update(s)`);
  return { fixed: updates.length, total: beats.length };
}

// ── driver ───────────────────────────────────────────────────────────
async function main() {
  if (projectIdArg) {
    console.log(`Project ${projectIdArg}${APPLY ? " [APPLY]" : " [DRY RUN]"}:`);
    const r = await processProject(projectIdArg);
    console.log(`Done — fixed ${r.fixed}/${r.total} beats.`);
    return;
  }

  console.log(`All projects${APPLY ? " [APPLY]" : " [DRY RUN]"}:`);
  const { data: projects, error } = await supabase
    .from("projects")
    .select("id, channel_name")
    .order("created_at", { ascending: false });
  if (error) { console.error(error.message); process.exit(1); }

  let totalFixed = 0;
  let totalBeats = 0;
  for (const p of projects ?? []) {
    console.log(`\n[${p.id}] ${p.channel_name ?? "(no name)"}`);
    const r = await processProject(p.id);
    totalFixed += r.fixed;
    totalBeats += r.total;
  }
  console.log(`\n──────────────────────────────────────`);
  console.log(`${APPLY ? "Applied" : "Would apply"} ${totalFixed} update(s) across ${totalBeats} beat(s) in ${projects?.length ?? 0} project(s).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
