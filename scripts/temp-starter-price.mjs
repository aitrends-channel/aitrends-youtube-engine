// DEV ONLY: temporarily display Starter as $0.50 for end-to-end
// payment-flow testing. The actual amount charged is set by Dodo's
// product behind the payment link — update there too if you want a
// real $0.50 charge. In test mode, the verify-route price guard is
// skipped, so display + real don't need to match for QA.
//
// Run:    node scripts/temp-starter-price.mjs
// Revert: node scripts/temp-starter-price.mjs --revert
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const revert = process.argv.includes("--revert");

const envPath = path.join(process.cwd(), ".env.local");
const env = Object.fromEntries(
  fs.readFileSync(envPath, "utf8").split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const newDisplay = revert ? "$21" : "$0.50";
const { data, error } = await supabase
  .from("plans")
  .update({ price_display: newDisplay })
  .eq("slug", "starter")
  .select("slug, price_display");

if (error) { console.error(error); process.exit(1); }
console.log(`OK — starter price_display is now ${newDisplay}`);
console.log(data);
