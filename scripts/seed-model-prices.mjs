// Write the generated half of the seed price table from production billing.
//
//   npx tsx scripts/seed-model-prices.mjs          # write and report
//   npx tsx scripts/seed-model-prices.mjs --check  # report only, non-zero on drift
//
// Run through tsx, not plain node: the gap list at the end imports the model
// catalogues, and those are TypeScript.
//
// model_cost_and_speed is refreshed from the cost ledger, so it holds what
// vendors actually took rather than what they advertise. That makes it the
// better source for a seed price, and re-running this is how the table keeps
// up as more models get used.
//
// Read from every database we have, not just one. The two hold different
// sets: staging carries the models being tried out, production carries the
// ones customers actually run, and a model missing from one is usually
// present in the other. Where both have priced the same model and resolution,
// the row with more observations behind it wins, which is neither environment
// winning by name.
//
// What it does NOT touch is lib/pricing/seed-prices.manual.ts. That half is
// hand-entered from published pricing for models nobody has run, and the gap
// list this prints is the to-do for it.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = "lib/pricing/seed-prices.generated.ts";
const CHECK = process.argv.includes("--check");

/** Where to read from. A file that is absent or unreachable is skipped with a
 *  note rather than failing the run: one database being down is not a reason
 *  to refuse to refresh from the other. */
const SOURCES = [
  { label: "staging",    file: ".env" },
  { label: "production", file: ".env.prod.readonly" },
];

function loadEnv(file) {
  return Object.fromEntries(
    readFileSync(file, "utf8").split("\n")
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        let v = l.slice(i + 1);
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        return [l.slice(0, i), v];
      }),
  );
}

const data = [];
const readFrom = [];
for (const src of SOURCES) {
  let env;
  try { env = loadEnv(src.file); } catch { console.log(`skipped ${src.label}: no ${src.file}`); continue; }
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_ANON_KEY;
  if (!env.SUPABASE_URL || !key) { console.log(`skipped ${src.label}: ${src.file} has no url or key`); continue; }
  const db = createClient(env.SUPABASE_URL, key);
  const { data: rows, error } = await db
    .from("model_cost_and_speed")
    .select("provider, model_type, model_name, resolution, cost_per_unit_credits, cost_per_second_credits, sample_count");
  if (error) { console.log(`skipped ${src.label}: ${error.message}`); continue; }
  for (const r of rows ?? []) data.push({ ...r, __source: src.label });
  readFrom.push(`${src.label} ${rows?.length ?? 0} rows`);
}
if (!readFrom.length) { console.error("no database could be read"); process.exit(1); }
console.log(`read ${readFrom.join(", ")}`);

// A row with no cost is a model that ran and never reported one. It is not a
// price, and writing 0 would say the generation was free.
const priced = data.filter((r) => costOf(r) != null && costOf(r) > 0);
function costOf(r) {
  return r.model_type === "video" ? r.cost_per_second_credits : r.cost_per_unit_credits;
}

const table = { kie: { image: {}, video: {} }, poyo: { image: {}, video: {} } };
// Which source and how many observations stand behind each cell, so a second
// row for the same cell only replaces the first when it is better evidenced.
const best = {};
const fromSource = { staging: 0, production: 0 };
for (const r of priced) {
  const provider = r.provider === "poyo" ? "poyo" : "kie";
  const kind = r.model_type === "video" ? "video" : "image";
  if (r.model_type !== "video" && r.model_type !== "image") continue;
  const cost = Number(costOf(r));
  const n = r.sample_count ?? 0;
  const cell = `${provider}|${kind}|${r.model_name}|${r.resolution ?? ""}`;
  if (best[cell] && best[cell].n >= n) continue;
  if (best[cell]) fromSource[best[cell].source] -= 1;
  best[cell] = { n, source: r.__source };
  fromSource[r.__source] += 1;
  const slot = (table[provider][kind][r.model_name] ??= {});
  // A null resolution is the blend across everything ever run on the model,
  // which is exactly what a flat figure means here.
  if (r.resolution) (slot.byResolution ??= {})[r.resolution] = cost;
  else slot.flat = cost;
}

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
for (const p of Object.keys(table)) {
  for (const k of Object.keys(table[p])) {
    table[p][k] = sortKeys(table[p][k]);
    for (const m of Object.keys(table[p][k])) {
      if (table[p][k][m].byResolution) table[p][k][m].byResolution = sortKeys(table[p][k][m].byResolution);
    }
  }
}

const counts = Object.entries(table).flatMap(([p, ks]) =>
  Object.entries(ks).map(([k, ms]) => `${p} ${k}: ${Object.keys(ms).length}`));

const body = `// GENERATED by scripts/seed-model-prices.mjs. Do not edit by hand.
//
// Written from model_cost_and_speed, which is what vendors actually charged.
// Re-run the script to refresh it as more models accumulate history; edits
// here are lost the next time it runs. Published prices for models with no
// history go in ./seed-prices.manual.ts instead.
//
// Images are credits per generation, video is credits per second, both in the
// vendor's own credit. A resolution key is a figure measured at that
// resolution; \`flat\` is the blend across every run of that model.
//
// ${counts.join(", ")}
// cells taken from staging: ${fromSource.staging}, from production: ${fromSource.production}
import type { SeedTable } from "./seed-types";

export const GENERATED_SEED: SeedTable = ${JSON.stringify(table, null, 2)};
`;

let existing = "";
try { existing = readFileSync(OUT, "utf8"); } catch { /* first run */ }
const changed = existing !== body;

if (CHECK) {
  console.log(changed ? `${OUT} is out of date` : `${OUT} is current`);
} else if (changed) {
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT} — ${counts.join(", ")}`);
} else {
  console.log(`${OUT} already current — ${counts.join(", ")}`);
}

// The to-do list for the manual half: every model the picker can reach that
// this table has no figure for.
const { IMAGE_MODELS } = await import("../lib/kie/imageModels.ts");
const { VIDEO_MODELS } = await import("../lib/kie/videoModels.ts");
const { KIE_TO_POYO_VIDEO, POYO_ONLY_VIDEO } = await import("../lib/poyo/videoModels.ts");
const { MANUAL_SEED } = await import("../lib/pricing/seed-prices.manual.ts");

const covered = (p, k, id) => !!(table[p][k][id] || MANUAL_SEED[p][k][id]);
const gaps = [];
for (const m of IMAGE_MODELS) if (!covered("kie", "image", m.id)) gaps.push(`kie   image  ${m.id}`);
for (const m of VIDEO_MODELS) if (!covered("kie", "video", m.id)) gaps.push(`kie   video  ${m.id}`);
const poyoVideoIds = [...new Set([
  ...Object.keys(KIE_TO_POYO_VIDEO),
  ...POYO_ONLY_VIDEO.map((x) => (typeof x === "string" ? x : x.id)),
])];
for (const id of poyoVideoIds) if (!covered("poyo", "video", id)) gaps.push(`poyo  video  ${id}`);

if (gaps.length) {
  console.log(`\n${gaps.length} model(s) with no seed price. Add published figures to lib/pricing/seed-prices.manual.ts:`);
  for (const g of gaps) console.log("   " + g);
} else {
  console.log("\nevery model the picker can reach has a seed price.");
}

// Rows that ran but never reported a cost. Not a gap the manual file can fix:
// something in the settle path is not recording what the vendor charged.
const nullCost = data.filter((r) => costOf(r) == null);
if (nullCost.length) {
  console.log(`\n${nullCost.length} row(s) ran but recorded no cost — the settle path, not the price table:`);
  for (const r of nullCost) console.log(`   ${r.provider} ${r.model_type} ${r.model_name} ${r.resolution ?? ""} (n=${r.sample_count})`);
}

process.exit(CHECK && changed ? 1 : 0);
