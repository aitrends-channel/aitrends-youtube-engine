// DEV ONLY: inject a placeholder subscription_id into vansolo313@gmail.com's
// app_metadata.dodo so the Cancel Subscription button renders on /plan.
// Clicking the button will still fail at Dodo (the ID isn't real).
//
// Run: node scripts/inject-fake-sub-id.mjs
// Revert: node scripts/inject-fake-sub-id.mjs --remove
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const remove = process.argv.includes("--remove");
const targetEmail = "vansolo313@gmail.com";

const envPath = path.join(process.cwd(), ".env.local");
const envText = fs.readFileSync(envPath, "utf8");
const env = Object.fromEntries(
  envText.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers();
if (listErr) { console.error(listErr); process.exit(1); }

const u = users.find((x) => x.email?.toLowerCase() === targetEmail);
if (!u) { console.error(`User ${targetEmail} not found`); process.exit(1); }

const baseDodo = u.app_metadata?.dodo ?? {};
const newDodo = remove
  ? Object.fromEntries(Object.entries(baseDodo).filter(([k]) => k !== "subscription_id"))
  : { ...baseDodo, subscription_id: "sub_dev_placeholder_001" };

const { error: updErr } = await supabase.auth.admin.updateUserById(u.id, {
  app_metadata: { ...u.app_metadata, dodo: newDodo },
});
if (updErr) { console.error(updErr); process.exit(1); }

console.log(`OK — ${remove ? "removed" : "injected"} subscription_id on ${targetEmail}`);
console.log("dodo metadata is now:", JSON.stringify(newDodo, null, 2));
