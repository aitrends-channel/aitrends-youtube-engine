import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      const k = l.slice(0, idx);
      let v = l.slice(idx + 1);
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      return [k, v];
    })
);

const url = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing SUPABASE creds in .env");

const supabase = createClient(url, key);
const userId = "da7615a6-c5dc-4d50-a2c1-ee6f762cae4f";

const { data, error } = await supabase
  .from("app_settings")
  .select("user_id, kie_api_key")
  .eq("user_id", userId);

if (error) {
  console.error("Query error:", error.message);
  process.exit(1);
}

if (!data || data.length === 0) {
  console.log(`No app_settings row for user ${userId}`);
} else {
  for (const row of data) {
    const k = row.kie_api_key;
    console.log(`user_id=${row.user_id} kie_api_key=${k ? `SET (${k.length} chars, starts with ${k.slice(0, 6)}...)` : "NULL/EMPTY"}`);
  }
}
