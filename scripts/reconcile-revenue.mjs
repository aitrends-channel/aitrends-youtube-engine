// Reconcile revenue_events against Dodo — the only source of truth for
// what we were actually paid. Both ledger writers are best-effort and
// have dropped rows before; missing payments never reappear on their own.
//
//   node scripts/reconcile-revenue.mjs            # dry run
//   node scripts/reconcile-revenue.mjs --apply
//   node scripts/reconcile-revenue.mjs --apply --replace-backfills
//
// --replace-backfills deletes synthetic backfill_* rows superseded by a
// real Dodo-keyed row in this run, which would otherwise double-count.
// Defaults to payments from activity_cutoff_at onward; --since <iso> or
// --all widens it. Credentials: --env <path> (default ../.env.prod).
// Dodo keys come from product_config, matching the Payment tab.

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const REPLACE_BACKFILLS = args.includes("--replace-backfills");
const SINCE = args.includes("--since") ? args[args.indexOf("--since") + 1] : null;
const ALL = args.includes("--all");
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

const { data: cfg, error: cfgErr } = await supabase
  .from("product_config")
  .select("dodo_secret_key_production, dodo_base_url_production, activity_cutoff_at")
  .eq("service", "_global")
  .maybeSingle();
if (cfgErr) throw cfgErr;

const dodoKey = cfg?.dodo_secret_key_production;
const dodoBase = cfg?.dodo_base_url_production || "https://live.dodopayments.com";
if (!dodoKey) throw new Error("no dodo_secret_key_production in product_config");

const dodo = async (pathname) => {
  const r = await fetch(`${dodoBase}/${pathname}`, { headers: { Authorization: `Bearer ${dodoKey}` } });
  if (!r.ok) throw new Error(`Dodo ${pathname} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// ── Every payment Dodo has ────────────────────────────────────────────
const payments = [];
for (let page = 0; ; page++) {
  const j = await dodo(`payments?page_size=100&page_number=${page}`);
  const items = j.items ?? j.data ?? [];
  payments.push(...items);
  if (items.length < 100) break;
}
const succeeded = payments.filter((p) => p.status === "succeeded");

// ── What the ledger already knows ─────────────────────────────────────
const { data: events, error: evErr } = await supabase
  .from("revenue_events")
  .select("id, dodo_payment_id, user_email, amount_cents, currency, plan, occurred_at");
if (evErr) throw evErr;
const known = new Set(events.map((e) => e.dodo_payment_id));

// ── Map Dodo payments back to our accounts ────────────────────────────
// The checkout email often isn't the app account email, so prefer the
// subscription id we stored in app_metadata.
const users = [];
for (let page = 1; ; page++) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  users.push(...data.users);
  if (data.users.length < 1000) break;
}
const bySub = new Map();
const byEmail = new Map();
for (const u of users) {
  const sub = u.app_metadata?.dodo?.subscription_id;
  if (sub) bySub.set(sub, u);
  if (u.email) byEmail.set(u.email.toLowerCase(), u);
}
const matchUser = (p) =>
  (p.subscription_id ? bySub.get(p.subscription_id) : null) ??
  byEmail.get((p.customer?.email ?? "").toLowerCase()) ??
  null;

// ── Build the insert plan ─────────────────────────────────────────────
// Default to launch onward: everything earlier is pre-launch QA at 50¢–$1.
const cutoff = ALL ? null : new Date(SINCE ?? cfg?.activity_cutoff_at ?? 0).getTime();
const missing = succeeded.filter(
  (p) => !known.has(p.payment_id) && (cutoff === null || new Date(p.created_at).getTime() >= cutoff),
);
const rows = [];
const skipped = [];
for (const p of missing) {
  // settlement_* only exist on the single-payment endpoint.
  const full = await dodo(`payments/${p.payment_id}`).catch(() => p);
  const settlement = Number(full.settlement_amount ?? 0);
  const amountCents = settlement > 0 ? settlement : Number(full.total_amount ?? 0);
  const currency = (settlement > 0 ? full.settlement_currency : full.currency ?? "usd").toLowerCase();
  const user = matchUser(p);

  if (!(amountCents > 0)) { skipped.push([p, "zero amount"]); continue; }

  rows.push({
    user_id: user?.id ?? null,
    user_email: user?.email?.toLowerCase() ?? (p.customer?.email ?? "").toLowerCase() ?? null,
    event_type: "payment_succeeded",
    amount_cents: amountCents,
    currency,
    // Prefer the plan slug the app recorded; Dodo doesn't know our slugs.
    plan: user?.app_metadata?.plan ?? null,
    dodo_payment_id: p.payment_id,
    dodo_raw: full,
    occurred_at: p.created_at,
  });
}

const newEmails = new Set(rows.map((r) => r.user_email));
const supersededBackfills = events.filter(
  (e) => String(e.dodo_payment_id ?? "").startsWith("backfill") && newEmails.has(e.user_email),
);

// ── Report ────────────────────────────────────────────────────────────
const RATE = { usd: 1, eur: 1.09, gbp: 1.27 };
const usd = (c, cur) => (RATE[cur] === undefined ? null : (c * RATE[cur]) / 100);
let addUsd = 0, unconverted = 0;

console.log(`Dodo payments: ${payments.length} (succeeded ${succeeded.length}) · ledger rows: ${events.length}`);
console.log(`window: ${cutoff === null ? "all time" : `>= ${new Date(cutoff).toISOString()}`}`);
console.log(`missing from ledger: ${missing.length} → insertable: ${rows.length}\n`);
for (const r of rows.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) {
  const d = usd(r.amount_cents, r.currency);
  if (d === null) unconverted++; else addUsd += d;
  console.log(
    `  ${r.occurred_at.slice(0, 10)} ${(r.user_email ?? "?").padEnd(34)} ` +
    `${String(r.amount_cents).padStart(8)} ${r.currency.padEnd(4)} ` +
    `${d === null ? "  UNCONVERTIBLE" : `$${d.toFixed(2).padStart(8)}`} ` +
    `${(r.plan ?? "-").padEnd(9)} ${r.user_id ? "" : "(no account matched)"}`,
  );
}
if (skipped.length) {
  console.log(`\nskipped ${skipped.length}:`);
  for (const [p, why] of skipped) console.log(`  ${p.created_at.slice(0, 10)} ${p.payment_id} — ${why}`);
}
console.log(`\nadds ≈ $${addUsd.toFixed(2)}${unconverted ? ` (+${unconverted} unconvertible row(s))` : ""}`);
console.log(`superseded backfill_* rows: ${supersededBackfills.length}` +
  (REPLACE_BACKFILLS ? " → will be deleted" : " → left in place (pass --replace-backfills to delete)"));
for (const e of supersededBackfills) console.log(`  ${e.occurred_at?.slice(0, 10)} ${e.user_email} ${e.amount_cents} ${e.currency}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  process.exit(0);
}

// ── Apply ─────────────────────────────────────────────────────────────
if (REPLACE_BACKFILLS && supersededBackfills.length) {
  const { error } = await supabase.from("revenue_events").delete().in("id", supersededBackfills.map((e) => e.id));
  if (error) throw error;
  console.log(`\ndeleted ${supersededBackfills.length} superseded backfill row(s)`);
}
// Chunked so one bad row can't take the batch down; the UNIQUE on
// dodo_payment_id makes re-runs harmless.
let inserted = 0;
for (let i = 0; i < rows.length; i += 25) {
  const chunk = rows.slice(i, i + 25);
  const { error } = await supabase.from("revenue_events").insert(chunk);
  if (error) {
    if (error.code === "23505") { console.warn(`chunk ${i}: duplicate, retrying individually`); }
    else { console.error(`chunk ${i} failed:`, error.message); }
    for (const row of chunk) {
      const { error: one } = await supabase.from("revenue_events").insert(row);
      if (one && one.code !== "23505") console.error(`  ${row.dodo_payment_id}: ${one.message}`);
      else if (!one) inserted++;
    }
    continue;
  }
  inserted += chunk.length;
}
console.log(`inserted ${inserted} row(s)`);
