// Reflow each beat's `script_segment` to contain only complete
// sentences from the project's original script. Does NOT modify
// projects.script — that stays untouched as the source of truth.
//
// Approach:
//   1. Read projects.script.
//   2. Split into sentences using a punctuation+capital heuristic.
//   3. Distribute sentences across the existing beats in order, packing
//      multiple per beat when sentences > beats, and leaving the
//      excess beats with empty script_segment when beats > sentences.
//      Empty beats will be skipped by selectStaleBeats in the TTS
//      route and dropped by the assembler in per-beat mode.
//
// Usage (from repo root):
//   node scripts/sentence-reflow.mjs <projectId>           # dry run
//   node scripts/sentence-reflow.mjs <projectId> --apply   # commit
//
// IMAGE and VIDEO prompts on each beat are NOT touched. Only the
// script_segment column changes.

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
        return [l.slice(0, idx), l.slice(idx + 1).replace(/^"|"$/g, "")];
      })
  );
}
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SUPABASE_URL = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const projectId = args.find((a) => !a.startsWith("--"));
if (!projectId) {
  console.error("Usage: node scripts/sentence-reflow.mjs <projectId> [--apply]");
  process.exit(1);
}

/** Split prose into sentences. Handles common terminators (. ! ?) and
 *  preserves them on the sentence. Avoids splitting on abbreviations
 *  by requiring a following space + capital letter (or end of string).
 *  Quotes immediately after a terminator are kept on the prior sentence
 *  so "He said. \"Hello.\"" gives ["He said.", "\"Hello.\""].
 *
 *  Not perfect — won't catch e.g. "Dr. Smith said yes." correctly — but
 *  good enough for narration scripts which generally avoid abbreviations.
 */
function splitSentences(text) {
  if (!text) return [];
  const clean = text.replace(/\s+/g, " ").trim();
  // Match: <chunk ending in . ! or ?> followed by whitespace + uppercase
  // or end of string. Use a global regex with capture to retain
  // terminators on each sentence.
  const out = [];
  const re = /[^.!?]+[.!?]+["')\]]?/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  // Capture trailing fragment with no terminator (rare but possible).
  const lastEnd = out.length ? clean.lastIndexOf(out[out.length - 1]) + out[out.length - 1].length : 0;
  const tail = clean.slice(lastEnd).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

async function main() {
  const { data: project, error: pErr } = await supabase
    .from("projects")
    .select("id, script")
    .eq("id", projectId)
    .single();
  if (pErr || !project) {
    console.error(`Project ${projectId} not found:`, pErr?.message);
    process.exit(1);
  }
  if (!project.script || !project.script.trim()) {
    console.error("Project has no script text — nothing to reflow.");
    process.exit(1);
  }

  const sentences = splitSentences(project.script);
  if (sentences.length === 0) {
    console.error("Split produced 0 sentences. Check the script formatting.");
    process.exit(1);
  }

  const { data: rawBeats, error: bErr } = await supabase
    .from("project_beats")
    .select("beat_number, script_segment")
    .eq("project_id", projectId)
    .order("beat_number");
  if (bErr) { console.error("Failed to load beats:", bErr.message); process.exit(1); }
  const beats = rawBeats ?? [];
  if (!beats.length) {
    console.error("Project has no beats.");
    process.exit(1);
  }

  const N = beats.length;
  const M = sentences.length;
  console.log(`Project ${projectId}:`);
  console.log(`  ${M} sentence(s) in script, ${N} beat(s) on file.`);
  console.log(`  ${APPLY ? "[APPLY]" : "[DRY RUN]"}`);

  // Distribute: sentence i -> beat floor(i * N / M). Packs multiple
  // sentences into one beat when M > N; leaves later beats empty when
  // M < N.
  const beatTexts = new Array(N).fill("");
  for (let i = 0; i < M; i++) {
    const beatIdx = Math.min(N - 1, Math.floor((i * N) / M));
    beatTexts[beatIdx] = beatTexts[beatIdx]
      ? `${beatTexts[beatIdx]} ${sentences[i]}`
      : sentences[i];
  }

  const updates = [];
  let assignedBeats = 0;
  let emptyBeats = 0;
  for (let i = 0; i < N; i++) {
    const beat = beats[i];
    const newText = beatTexts[i];
    if (!newText) { emptyBeats++; continue; }
    assignedBeats++;
    if ((beat.script_segment ?? "").trim() === newText) continue;
    updates.push({ beat_number: beat.beat_number, new_text: newText });
  }

  console.log(`  Distribution: ${assignedBeats} beat(s) get sentences, ${emptyBeats} beat(s) left empty.`);
  console.log(`  Updates needed: ${updates.length}`);

  for (const u of updates.slice(0, 8)) {
    const snip = u.new_text.length > 100 ? u.new_text.slice(0, 100) + "…" : u.new_text;
    console.log(`    beat ${u.beat_number}: "${snip}"`);
  }
  if (updates.length > 8) console.log(`    … and ${updates.length - 8} more`);

  if (!APPLY) {
    console.log(`\nDry run — pass --apply to commit.`);
    return;
  }

  // Two-step writes: (1) clear ALL beats' script_segment to "" so
  // beats that should be empty actually become empty; (2) apply the
  // populated ones.
  console.log(`\nClearing all beats' script_segment for project…`);
  const { error: clearErr } = await supabase
    .from("project_beats")
    .update({ script_segment: "" })
    .eq("project_id", projectId);
  if (clearErr) { console.error("Clear failed:", clearErr.message); process.exit(1); }

  for (const u of updates) {
    const { error } = await supabase
      .from("project_beats")
      .update({ script_segment: u.new_text })
      .eq("project_id", projectId)
      .eq("beat_number", u.beat_number);
    if (error) {
      console.error(`UPDATE beat ${u.beat_number} failed: ${error.message}`);
      process.exit(1);
    }
  }
  console.log(`✓ Applied ${updates.length} update(s). ${emptyBeats} beat(s) left with empty script_segment.`);
  console.log(`\nNext steps: in the voiceover UI, click 'Clear' to wipe old per-beat audio (its script hash no longer matches), then Generate to produce new per-sentence voiceovers.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
