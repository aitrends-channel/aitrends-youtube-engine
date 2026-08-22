// What the wallet took in against what the work cost us.
//
// Two ledgers answer this between them, and they are deliberately separate:
// credit_ledger is the money (credits bought and spent), project_costs is the
// meter (provider units actually consumed). A wallet that sells credits for less
// than the provider charges is the one failure mode that does not announce
// itself, so this is the report that has to be read rather than the balance.
//
//   node scripts/wallet-margin.mjs                  # current month
//   node scripts/wallet-margin.mjs --since 2026-08-01
//   node scripts/wallet-margin.mjs --by-user
//
// Credentials: --env <path> (default ../.env.prod).

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const BY_USER = args.includes("--by-user");
const SINCE = args.includes("--since")
  ? args[args.indexOf("--since") + 1]
  : new Date(new Date().toISOString().slice(0, 7) + "-01").toISOString();
const envPath = args.includes("--env")
  ? args[args.indexOf("--env") + 1]
  : path.join(process.cwd(), "..", ".env.prod");

const env = Object.fromEntries(
  fs.readFileSync(envPath, "utf8").split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── The money ─────────────────────────────────────────────────────────
const { data: ledger, error: ledgerErr } = await supabase
  .from("credit_ledger")
  .select("user_id, kind, credits, created_at")
  .gte("created_at", SINCE);
if (ledgerErr) throw ledgerErr;

// ── The meter ─────────────────────────────────────────────────────────
// USD per unit comes from model_cost_and_speed where we have it, which is the
// same snapshot the model picker reads. Units with no rate are reported as
// unpriced rather than folded in at zero: a missing rate must look like a gap,
// not like free work.
const { data: costs, error: costsErr } = await supabase
  .from("project_costs")
  .select("user_id, provider, model, units, unit_kind, created_at")
  .gte("created_at", SINCE);
if (costsErr) throw costsErr;

const { data: rateRows, error: rateErr } = await supabase
  .from("model_cost_and_speed")
  .select("model_name, model_type, usd_per_credit");
if (rateErr) throw rateErr;

const usdPerKieCredit = (() => {
  const rates = (rateRows ?? []).map((r) => Number(r.usd_per_credit)).filter((n) => Number.isFinite(n) && n > 0);
  if (!rates.length) return null;
  // The median, not the mean: one mispriced model should not move the figure.
  const sorted = rates.sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
})();

const perUser = new Map();
const bucket = (id) => {
  if (!perUser.has(id)) {
    perUser.set(id, { boughtCredits: 0, grantedCredits: 0, spentCredits: 0, kieCredits: 0, elChars: 0, tokens: 0, freeLane: 0, unpriced: 0 });
  }
  return perUser.get(id);
};

for (const row of ledger ?? []) {
  const b = bucket(row.user_id);
  const n = Number(row.credits);
  if (row.kind === "topup") b.boughtCredits += n;
  else if (row.kind === "adjustment" && n > 0) b.grantedCredits += n;
  else if (n < 0) b.spentCredits += -n;
}

for (const row of costs ?? []) {
  const b = bucket(row.user_id);
  const units = Number(row.units) || 0;
  if (row.unit_kind === "kie_credits") b.kieCredits += units;
  else if (row.unit_kind === "elevenlabs_chars") b.elChars += units;
  else if (String(row.unit_kind).startsWith("claude_tokens")) b.tokens += units;
  // Deliberate zeros, not gaps: free-lane clips come out of the other wallet and
  // transcripts are a flat-rate service. Anything else with no rate is a gap.
  else if (row.unit_kind === "genaipro_clips" || row.unit_kind === "supadata_transcripts") b.freeLane += units;
  else b.unpriced += units;
}

// ── Report ────────────────────────────────────────────────────────────
const fmt = (n, dp = 2) => n.toLocaleString(undefined, { maximumFractionDigits: dp });
const totals = { boughtCredits: 0, grantedCredits: 0, spentCredits: 0, kieCredits: 0, elChars: 0, tokens: 0, freeLane: 0, unpriced: 0 };
for (const b of perUser.values()) for (const k of Object.keys(totals)) totals[k] += b[k];

console.log(`\nWallet margin since ${SINCE.slice(0, 10)}\n`);
console.log(`  credits bought     ${fmt(totals.boughtCredits)}`);
console.log(`  credits granted    ${fmt(totals.grantedCredits)}   (starter grants, not revenue)`);
console.log(`  credits spent      ${fmt(totals.spentCredits)}`);
console.log(`  KIE credits used   ${fmt(totals.kieCredits)}`);
console.log(`  ElevenLabs chars   ${fmt(totals.elChars, 0)}`);
console.log(`  Claude tokens      ${fmt(totals.tokens, 0)}`);
if (totals.freeLane > 0) console.log(`  free-lane units    ${fmt(totals.freeLane, 0)}   (charged to the video wallet or flat-rate, by design)`);
if (totals.unpriced > 0) console.log(`  unpriced units     ${fmt(totals.unpriced, 0)}   (no credit rate — add one in lib/pricing.ts)`);

// The headline: credits spent should track KIE credits consumed one to one,
// since that is the unit the wallet is priced in. A gap means either unbilled
// work (spent well under consumed) or a rate that overcharges.
if (totals.kieCredits > 0) {
  const ratio = totals.spentCredits / totals.kieCredits;
  console.log(`\n  spent / KIE consumed  ${fmt(ratio, 3)}   ${ratio < 0.9 ? "← work is going unbilled" : ratio > 1.5 ? "← charging well above cost" : "ok"}`);
}
if (usdPerKieCredit) {
  console.log(`  provider cost        ~$${fmt(totals.kieCredits * usdPerKieCredit)}   (at $${usdPerKieCredit}/KIE credit, median of ${rateRows.length} models)`);
} else {
  console.log(`  provider cost        unknown — no usd_per_credit set on any model`);
}

if (BY_USER) {
  console.log(`\n  ${"user".padEnd(38)} ${"bought".padStart(10)} ${"granted".padStart(9)} ${"spent".padStart(10)} ${"kie".padStart(10)}`);
  const rows = [...perUser.entries()].sort((a, b) => b[1].spentCredits - a[1].spentCredits);
  for (const [userId, b] of rows) {
    console.log(`  ${String(userId).padEnd(38)} ${fmt(b.boughtCredits).padStart(10)} ${fmt(b.grantedCredits).padStart(9)} ${fmt(b.spentCredits).padStart(10)} ${fmt(b.kieCredits).padStart(10)}`);
  }
}
console.log("");
