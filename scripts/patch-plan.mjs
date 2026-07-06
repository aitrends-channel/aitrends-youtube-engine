// One-time: set plan="starter" on vansolo313@gmail.com so /plan
// renders the plan card. The webhook marked the user paid but never
// wrote a slug (verify route didn't fire on return).
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

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

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(url, key);
const targetEmail = "vansolo313@gmail.com";

const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers();
if (listErr) { console.error(listErr); process.exit(1); }

const u = users.find((x) => x.email?.toLowerCase() === targetEmail);
if (!u) { console.error(`User ${targetEmail} not found`); process.exit(1); }

console.log("Before:", JSON.stringify(u.app_metadata, null, 2));

const { error: updErr } = await supabase.auth.admin.updateUserById(u.id, {
  app_metadata: { ...u.app_metadata, plan: "starter" },
});
if (updErr) { console.error(updErr); process.exit(1); }

console.log(`OK — set plan="starter" on ${targetEmail}`);
