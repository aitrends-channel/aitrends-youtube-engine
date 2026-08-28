// Give back access to customers whose renewal Dodo took but Heclus never heard.
//
// The webhook endpoint was disabled on Dodo's side on 2026-08-24 after repeated
// signature failures, so no subscription.renewed reached us. A renewal charged
// the card, Dodo moved the next billing date a month on, and Heclus kept the old
// plan_expires_at and locked the customer out on it.
//
// Only touches accounts Dodo reports as `active` with a billing date later than
// the one we hold. An `on_hold` subscription is Dodo retrying a failed payment,
// not a completed renewal, and its next date moves for a different reason — so
// those are listed and left alone.
//
//   node scripts/restore-missed-renewals.mjs           # show what would change
//   node scripts/restore-missed-renewals.mjs --apply   # write it
//
// Reads .env.prod.readonly. That file holds a service-role key, so --apply does
// write to production despite the name; the dry run does not.

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");

const env = Object.fromEntries(
  fs.readFileSync(".env.prod.readonly", "utf8").split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: cfg, error: cfgErr } = await sb
  .from("product_config").select("dodo_secret_key_production").eq("service", "_global").single();
if (cfgErr) { console.error("could not read the Dodo key:", cfgErr.message); process.exit(1); }
const dodoKey = cfg.dodo_secret_key_production;

const users = [];
for (let page = 1; ; page++) {
  const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) { console.error("listUsers failed:", error.message); process.exit(1); }
  users.push(...data.users);
  if (data.users.length < 1000) break;
}

const restore = [];
const retrying = [];

for (const u of users) {
  const meta = u.app_metadata ?? {};
  const sub = (meta.dodo ?? {}).subscription_id;
  if (typeof sub !== "string" || !sub) continue;

  const res = await fetch(`https://live.dodopayments.com/subscriptions/${sub}`, {
    headers: { Authorization: `Bearer ${dodoKey}` },
  });
  if (!res.ok) { console.warn(`  ${u.email}: Dodo returned HTTP ${res.status}, skipped`); continue; }
  const s = await res.json();

  const dodoNext = s.next_billing_date ? String(s.next_billing_date) : null;
  const ours = typeof meta.plan_expires_at === "string" ? meta.plan_expires_at : null;
  if (!dodoNext || !ours || dodoNext.slice(0, 10) <= ours.slice(0, 10)) continue;

  const row = { user: u, email: u.email, plan: meta.plan, status: s.status, dodoNext, ours };
  if (s.status === "active") restore.push(row); else retrying.push(row);
}

console.log(`\n${restore.length} to restore (Dodo says active and billed further ahead than we hold):`);
for (const r of restore) {
  console.log(`  ${String(r.email).padEnd(32)} ${String(r.plan).padEnd(8)} ${r.ours.slice(0, 10)} -> ${r.dodoNext.slice(0, 10)}`);
}

console.log(`\n${retrying.length} left alone (Dodo is retrying a failed payment, not renewed):`);
for (const r of retrying) {
  console.log(`  ${String(r.email).padEnd(32)} ${String(r.plan).padEnd(8)} dodo=${r.status}  next attempt ${r.dodoNext.slice(0, 10)}`);
}

if (!APPLY) {
  console.log("\ndry run, nothing written. Re-run with --apply to restore the accounts above.");
  process.exit(0);
}

let done = 0;
for (const r of restore) {
  const meta = r.user.app_metadata ?? {};
  const { error } = await sb.auth.admin.updateUserById(r.user.id, {
    app_metadata: {
      ...meta,
      // paid is already true on these: nothing revoked them, the date simply
      // lapsed. Set anyway so a partially-revoked account is repaired too.
      paid: true,
      plan_expires_at: r.dodoNext,
    },
  });
  if (error) { console.error(`  ${r.email}: FAILED ${error.message}`); continue; }
  done++;
  console.log(`  ${r.email}: restored through ${r.dodoNext.slice(0, 10)}`);
}
console.log(`\nrestored ${done} of ${restore.length}.`);
console.log("Revenue is a separate gap: these renewals have no revenue_events row, so the");
console.log("dashboard still understates income until they are backfilled from Dodo's payments.");
