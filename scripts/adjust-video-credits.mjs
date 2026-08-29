// Correct a free-video credit balance, and say why in the ledger.
//
// davidstamu80@gmail.com bought three 300-credit packs for $3.75 on
// 2026-08-28, five seconds before the credits landed. The purchase worked
// exactly as designed; the mistake was ours, in the lane being reachable and
// priced as it was. He is being told, and his balance is being set to 200.
//
// Written as a ledger entry rather than a bare UPDATE. A balance that changes
// with no row explaining it is indistinguishable from a bug six months later,
// and this one will look like one: money in, credits out, credits reduced.
//
//   node scripts/adjust-video-credits.mjs           # show what would change
//   node scripts/adjust-video-credits.mjs --apply   # write it
//
// Reads .env.prod.readonly, which holds a service-role key, so --apply does
// write to production despite the name.

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");

const TARGET_EMAIL = "davidstamu80@gmail.com";
const NEW_PAID = 200;
const NOTE = "Adjusted to 200 by Heclus. The free video lane was reachable and priced in error; the customer has been contacted.";

const env = Object.fromEntries(
  fs.readFileSync(".env.prod.readonly", "utf8").split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: { users } } = await sb.auth.admin.listUsers({ perPage: 1000 });
const user = users.find((u) => u.email === TARGET_EMAIL);
if (!user) { console.error(`no account for ${TARGET_EMAIL}`); process.exit(1); }

const { data: wallet, error: wErr } = await sb
  .from("genai_credits").select("*").eq("user_id", user.id).maybeSingle();
if (wErr || !wallet) { console.error("could not read the wallet:", wErr?.message ?? "no row"); process.exit(1); }

const before = Number(wallet.paid_credits ?? 0);
const delta = NEW_PAID - before;

console.log(`${TARGET_EMAIL}`);
console.log(`  paid credits   ${before} -> ${NEW_PAID}   (${delta >= 0 ? "+" : ""}${delta})`);
console.log(`  grant          ${wallet.grant_credits}`);
console.log(`  reserved       ${wallet.reserved_credits}`);
console.log(`  ledger note    ${NOTE}`);

// Refuse to run over work in flight: a reservation is credits already spoken
// for, and cutting the balance under it would settle against a number that no
// longer exists.
if (Number(wallet.reserved_credits ?? 0) > 0) {
  console.error("\nRefusing: this wallet has credits reserved for work in progress. Try again once it settles.");
  process.exit(1);
}
if (delta === 0) { console.log("\nalready at the target, nothing to do."); process.exit(0); }
if (!APPLY) { console.log("\ndry run, nothing written. Re-run with --apply."); process.exit(0); }

const { error: ledErr } = await sb.from("genai_credits_ledger").insert({
  user_id: user.id,
  // The kinds in use are monthly_grant, topup, refund and debit. A reduction
  // of bought credit is a debit against the paid bucket.
  kind: delta < 0 ? "debit" : "topup",
  credits: Math.abs(delta),
  bucket: "paid",
  note: NOTE,
});
if (ledErr) { console.error("ledger write failed, balance untouched:", ledErr.message); process.exit(1); }

const { error: balErr } = await sb
  .from("genai_credits").update({ paid_credits: NEW_PAID }).eq("user_id", user.id);
if (balErr) {
  console.error("BALANCE UPDATE FAILED after the ledger row was written:", balErr.message);
  console.error("The ledger now claims a change that did not happen. Fix by hand.");
  process.exit(1);
}

console.log(`\ndone. ${TARGET_EMAIL} now holds ${NEW_PAID} video credits, with the reason on the ledger.`);
