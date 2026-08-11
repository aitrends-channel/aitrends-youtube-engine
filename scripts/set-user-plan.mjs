// Mirrors app/api/admin/users/[email]/plan/route.ts against prod.
// Usage: node set-plan.mjs <email> <plan> [--apply]
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

// .env.production.local is a Vercel pull with [SENSITIVE] placeholders — unusable.
const ENV_PATH = process.env.ENV_FILE || ".env.prod.readonly";
const env = Object.fromEntries(
  fs.readFileSync(ENV_PATH, "utf8").split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing prod Supabase URL/service key"); process.exit(1); }

const [email, plan] = process.argv.slice(2);
const apply = process.argv.includes("--apply");
const ALLOWED = new Set(["starter", "pro", "founder"]);
if (!ALLOWED.has(plan)) { console.error("plan must be starter|pro|founder"); process.exit(1); }

const supabase = createClient(url, key);
const target = email.toLowerCase().trim();

let user = null;
for (let page = 1; page <= 20 && !user; page++) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) { console.error(error); process.exit(1); }
  if (!data.users.length) break;
  user = data.users.find((u) => u.email?.toLowerCase() === target) ?? null;
  if (data.users.length < 1000) break;
}
if (!user) { console.error(`User ${target} not found in ${url}`); process.exit(1); }

const meta = user.app_metadata ?? {};
console.log("project:", url);
console.log("user id:", user.id, "| created:", user.created_at);
console.log("current app_metadata:", JSON.stringify(meta, null, 2));

if (meta.is_admin === true) { console.error("Refusing: target is an admin account"); process.exit(1); }

const nowIso = new Date().toISOString();
const patch = {
  paid: true,
  paid_at: typeof meta.paid_at === "string" ? meta.paid_at : nowIso,
  plan_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  plan,
};
console.log("would patch:", JSON.stringify(patch, null, 2));

if (!apply) { console.log("\nDRY RUN — no write performed. Re-run with --apply."); process.exit(0); }

const { error } = await supabase.auth.admin.updateUserById(user.id, {
  app_metadata: { ...meta, ...patch },
});
if (error) { console.error(error); process.exit(1); }
console.log(`\nOK — set plan="${plan}" on ${target}`);
