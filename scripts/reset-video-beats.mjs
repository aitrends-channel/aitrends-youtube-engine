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

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const projectId = process.argv[2] ?? "944ac1c5-9aa6-4cb8-b39f-1ab7d527c045";

const { data: before } = await supabase
  .from("project_beats")
  .select("video_status")
  .eq("project_id", projectId);

const counts = (before ?? []).reduce((acc, b) => {
  const k = b.video_status ?? "(null)";
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});
console.log("Before reset:", counts);

// Reset all non-done beats (failed + queued + processing + null)
const { error, count } = await supabase
  .from("project_beats")
  .update({ video_status: null, video_url: null, video_job_id: null, video_error: null }, { count: "exact" })
  .eq("project_id", projectId)
  .neq("video_status", "done");

if (error) {
  console.error("Reset error:", error.message);
  process.exit(1);
}

console.log(`Reset ${count} beats to a clean state. Re-submit from the UI.`);
