/**
 * Re-send a bulk campaign to the recipients a timed-out run never reached.
 *
 * The 2026-08-09 "Kie Issue Resolved" send died at the route's 300s
 * maxDuration after 231 of 664 recipients (1.29s per email, serial). This
 * script finishes the job from a machine with no request timeout.
 *
 * It recomputes "who is missing" from the emails table on every run, so it is
 * safe to stop it and start it again: anyone already logged is skipped. That
 * also means it can never double-send, provided the DB insert keeps working.
 *
 *   node scripts/resend-missed-campaign.mjs --dry-run      # counts only
 *   node scripts/resend-missed-campaign.mjs --test <addr>  # one copy, to you
 *   node scripts/resend-missed-campaign.mjs --send         # the real run
 *
 * Reads prod Supabase from .env.prod.readonly and SMTP from
 * .env.production.local.
 */
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import { readFileSync } from "node:fs";

const SUBJECT_MATCH = "%Kie Issue Resolved%";
// Sends stay serial with a small pause. The mailbox is a shared Hostinger
// account and a burst of 434 is exactly what gets a sender rate-limited or
// blacklisted; 1.3s per email is what the original run was doing anyway.
const PAUSE_MS = 400;

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
// --paid narrows the audience to paying accounts, the same scope the route's
// "All paid users" audience uses.
const PAID_ONLY = args.includes("--paid");
const SEND = args.includes("--send");
const testTo = args.includes("--test") ? args[args.indexOf("--test") + 1] : null;
if (!DRY && !SEND && !testTo) {
  console.error("Pass one of --dry-run, --test <address>, --send");
  process.exit(1);
}

const readEnv = (f) => Object.fromEntries(
  readFileSync(f, "utf8").split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      let v = l.slice(i + 1);
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      return [l.slice(0, i), v];
    })
);

const dbEnv = readEnv(".env.prod.readonly");
// SMTP comes from .env, not .env.production.local: the latter's values are
// masked (its HOSTINGER_SMTP_HOST is not even a resolvable hostname). Both
// point at the same support@heclus.com mailbox, which is the account the
// campaign was sent from.
const smtpEnv = readEnv(".env");
const supabase = createClient(dbEnv.NEXT_PUBLIC_SUPABASE_URL ?? dbEnv.SUPABASE_URL, dbEnv.SUPABASE_SERVICE_ROLE_KEY);

// The original message, taken from a copy that actually went out rather than
// retyped: same subject, same HTML shell, same wording.
const { data: sentRows, error: sentErr } = await supabase
  .from("emails")
  .select("to_addresses, from_address, subject, body_text, body_html")
  .ilike("subject", SUBJECT_MATCH);
if (sentErr) throw sentErr;
if (!sentRows.length) throw new Error("No sent copy found to clone");

const template = sentRows[0];
const already = new Set();
for (const r of sentRows) for (const a of r.to_addresses ?? []) already.add(String(a).toLowerCase());

// The greeting is the only personalized part. Swap the name out of the
// cloned copy rather than reconstructing the template's {{name}} token.
const greetedName = (String(template.body_text ?? "").match(/^Hi ([^,\n]+),/) ?? [])[1];
if (!greetedName) throw new Error("Could not find the greeting in the cloned copy");
const personalize = (s, name) =>
  String(s ?? "").split(`Hi ${greetedName},`).join(`Hi ${name},`);

const allUsers = [];
for (let page = 1; page <= 25; page++) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  allUsers.push(...(data.users ?? []));
  if ((data.users ?? []).length < 1000) break;
}

// Same exclusions the route applies: admins and production-test accounts.
const ADMIN_EMAILS = new Set(["nyefene1@gmail.com", "solomon@keydolphin.com"]);
const firstNameFor = (u) => {
  const m = u.user_metadata ?? {};
  const raw = m.full_name ?? m.name ?? m.first_name;
  return (typeof raw === "string" && raw.trim()) ? raw.trim().split(/\s+/)[0] : "there";
};
const audience = allUsers.filter((u) =>
  u.email
  && u.app_metadata?.is_production_test !== true
  && u.app_metadata?.is_admin !== true
  && !ADMIN_EMAILS.has(u.email.toLowerCase())
  && (!PAID_ONLY || u.app_metadata?.paid === true)
);
const missed = audience
  .filter((u) => !already.has(u.email.toLowerCase()))
  .map((u) => ({ email: u.email, name: firstNameFor(u) }));

console.log(`subject   : ${template.subject}`);
console.log(`from      : ${template.from_address}`);
console.log(`audience  : ${audience.length}${PAID_ONLY ? " (paid only)" : ""}`);
console.log(`already   : ${already.size} (campaign-wide)`);
console.log(`to send   : ${missed.length}`);
if (DRY) {
  console.log("\nfirst 10:");
  for (const m of missed.slice(0, 10)) console.log(`  ${m.name} <${m.email}>`);
  console.log("\nDry run, nothing sent.");
  process.exit(0);
}

const port = Number(smtpEnv.HOSTINGER_SMTP_PORT);
const transport = nodemailer.createTransport({
  host: smtpEnv.HOSTINGER_SMTP_HOST,
  port,
  secure: port === 465,
  auth: { user: smtpEnv.HOSTINGER_SMTP_USER, pass: smtpEnv.HOSTINGER_SMTP_PASS },
});

async function sendOne(to, name, { log }) {
  const text = personalize(template.body_text, name);
  const html = personalize(template.body_html, name);
  const result = await transport.sendMail({
    from: `"Heclus Support" <${template.from_address}>`,
    to,
    subject: template.subject,
    text,
    html,
    // Envelope MAIL FROM must be the authenticated mailbox or Hostinger
    // rejects it as spoofing and the mail silently never leaves.
    envelope: { from: smtpEnv.HOSTINGER_SMTP_USER, to: [to] },
  });
  if (!result.messageId) throw new Error("SMTP returned no Message-ID");
  // The dedupe on the next run reads this table, so a failed insert would
  // risk a double-send. Loud, unlike the app's fail-soft copy.
  if (log) {
    const { error } = await supabase.from("emails").insert({
      direction: "outbound",
      message_id: result.messageId,
      thread_root_id: result.messageId,
      from_address: template.from_address,
      to_addresses: [to],
      cc_addresses: [],
      subject: template.subject,
      body_text: text,
      body_html: html,
      sent_at: new Date().toISOString(),
      is_read: false,
    });
    if (error) console.error(`  !! sent to ${to} but NOT logged: ${error.message}`);
  }
  return result.messageId;
}

if (testTo) {
  await sendOne(testTo, "there", { log: false });
  console.log(`\nTest copy sent to ${testTo}. Not logged, so it does not affect the dedupe.`);
  process.exit(0);
}

console.log(`\nSending to ${missed.length} recipients…`);
let sent = 0;
const failed = [];
for (const m of missed) {
  try {
    await sendOne(m.email, m.name, { log: true });
    sent += 1;
    if (sent % 25 === 0) console.log(`  ${sent}/${missed.length}`);
  } catch (e) {
    failed.push({ email: m.email, error: e instanceof Error ? e.message : String(e) });
    console.error(`  FAILED ${m.email}: ${e instanceof Error ? e.message : e}`);
  }
  await new Promise((r) => setTimeout(r, PAUSE_MS));
}

console.log(`\nDone. sent=${sent} failed=${failed.length}`);
for (const f of failed.slice(0, 20)) console.log(`  ${f.email}: ${f.error}`);
