// Are we billing at the rates the providers actually charge?
//
// Divides what Anthropic invoiced by what Anthropic served, both read from
// their own org reports, and compares the result to CLAUDE_MODEL_PRICING. Then
// does the same for ElevenLabs from its invoice over characters spoken, which
// on a quota plan is an average rather than a marginal rate.
//
//   node scripts/reconcile-rates.mjs            # last 30 days
//   node scripts/reconcile-rates.mjs --days 7
//
// Reads nothing but reports. Keys: ANTHROPIC_ADMIN_KEY (the org admin key, not
// the key the app generates with) and HECLUS_ELEVENLABS_API_KEY, from .env or
// the environment.
//
// The same comparison runs monthly at /api/cron/reconcile-rates and shows in
// Admin → Heclus Credits. This is for when you want it now, in a terminal.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 30;

function loadEnv(file) {
  try {
    return Object.fromEntries(
      readFileSync(file, "utf8").split("\n")
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          let v = l.slice(i + 1).trim();
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
          return [l.slice(0, i).trim(), v];
        }),
    );
  } catch { return {}; }
}

const env = { ...loadEnv(".env"), ...loadEnv(".env.local"), ...process.env };
const adminKey = env.ANTHROPIC_ADMIN_KEY;
const elevenKey = env.HECLUS_ELEVENLABS_API_KEY;

// Kept in step with CLAUDE_MODEL_PRICING in lib/claude/models.ts. Duplicated
// because this script runs without the Next module graph; a mismatch here shows
// as drift against a rate nothing bills at, so check both before believing it.
const TABLE = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15, intro: { in: 2, out: 10, until: "2026-08-31" } },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

function tableRate(model, kind, on) {
  const row = TABLE[model];
  if (!row) return null;
  const price = row.intro && on <= new Date(`${row.intro.until}T23:59:59Z`) ? row.intro : row;
  if (kind === "input") return price.in;
  if (kind === "output") return price.out;
  if (kind === "cache_read") return price.in * 0.1;
  if (kind === "cache_write") return price.in * 1.25;
  return null;
}

const KIND_OF_TOKEN_TYPE = {
  uncached_input_tokens: "input",
  output_tokens: "output",
  cache_read_input_tokens: "cache_read",
  "cache_creation.ephemeral_5m_input_tokens": "cache_write",
};

async function anthropicReport(path, params) {
  const headers = { "anthropic-version": "2023-06-01" };
  if (adminKey.startsWith("sk-ant-")) headers["x-api-key"] = adminKey;
  else headers.Authorization = `Bearer ${adminKey}`;

  const out = [];
  let page = null;
  for (let i = 0; i < 10; i++) {
    const url = new URL(`https://api.anthropic.com${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    for (const bucket of body.data ?? []) out.push(...(bucket.results ?? []));
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return out;
}

const now = new Date();
const from = new Date(now.getTime() - days * 86_400_000);
const window = { starting_at: from.toISOString(), ending_at: now.toISOString(), bucket_width: "1d", limit: "31" };

console.log(`Window: ${from.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}\n`);

if (!adminKey) {
  console.log("Anthropic: no ANTHROPIC_ADMIN_KEY, skipped.");
} else {
  try {
    const [costs, usage] = await Promise.all([
      anthropicReport("/v1/organizations/cost_report", { ...window, "group_by[]": "description" }),
      anthropicReport("/v1/organizations/usage_report/messages", { ...window, "group_by[]": "model" }),
    ]);

    const cents = new Map();
    for (const r of costs) {
      if (r.cost_type && r.cost_type !== "tokens") continue;
      const kind = KIND_OF_TOKEN_TYPE[r.token_type];
      if (!kind || !r.model) continue;
      const k = `${r.model}::${kind}`;
      cents.set(k, (cents.get(k) ?? 0) + Number(r.amount ?? 0));
    }
    const tokens = new Map();
    for (const r of usage) {
      if (!r.model) continue;
      const add = (kind, n) => { if (n) tokens.set(`${r.model}::${kind}`, (tokens.get(`${r.model}::${kind}`) ?? 0) + n); };
      add("input", r.uncached_input_tokens);
      add("output", r.output_tokens);
      add("cache_read", r.cache_read_input_tokens);
      add("cache_write", r.cache_creation?.ephemeral_5m_input_tokens);
    }

    console.log("Anthropic, USD per million tokens:");
    console.log(`  ${"model".padEnd(20)} ${"kind".padEnd(12)} ${"we bill".padStart(9)} ${"invoiced".padStart(9)} ${"drift".padStart(7)}  volume`);
    const rows = [...cents.entries()].sort();
    if (rows.length === 0) console.log("  (no token costs in this window)");
    for (const [k, amount] of rows) {
      const [model, kind] = k.split("::");
      const served = tokens.get(k) ?? 0;
      if (served < 50_000) continue;
      const actual = (amount / 100) / (served / 1e6);
      const table = tableRate(model, kind, now);
      const drift = table ? `${((actual / table - 1) * 100).toFixed(0)}%` : "no rate";
      console.log(
        `  ${model.padEnd(20)} ${kind.padEnd(12)} ${(table ? "$" + table.toFixed(2) : "-").padStart(9)}` +
        ` ${("$" + actual.toFixed(2)).padStart(9)} ${drift.padStart(7)}  ${served.toLocaleString()}`,
      );
    }
  } catch (e) {
    console.log(`Anthropic: ${e.message}`);
  }
}

console.log();

if (!elevenKey) {
  console.log("ElevenLabs: no HECLUS_ELEVENLABS_API_KEY, skipped.");
} else {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": elevenKey } });
    if (!res.ok) throw new Error(`subscription ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const sub = await res.json();
    const chars = Number(sub.character_count ?? 0);
    const invoiceCents = Number(sub.next_invoice?.amount_due_cents ?? 0);
    console.log(`ElevenLabs (${sub.tier ?? "unknown tier"}): ${chars.toLocaleString()} / ${Number(sub.character_limit ?? 0).toLocaleString()} characters this period`);
    if (chars >= 5_000 && invoiceCents > 0) {
      const actual = (invoiceCents / 100) / (chars / 1000);
      console.log(`  invoice $${(invoiceCents / 100).toFixed(2)} → $${actual.toFixed(4)} per 1k characters (we bill $0.05 for turbo)`);
    } else {
      console.log(`  invoice $${(invoiceCents / 100).toFixed(2)}: not enough to divide yet`);
    }
  } catch (e) {
    console.log(`ElevenLabs: ${e.message}`);
  }
}
