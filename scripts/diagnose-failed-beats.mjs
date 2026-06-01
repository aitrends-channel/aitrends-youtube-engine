import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

function loadEnv(file) {
  return Object.fromEntries(
    readFileSync(file, "utf8")
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
}

const env = loadEnv(".env");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const projectId = "944ac1c5-9aa6-4cb8-b39f-1ab7d527c045";

const { data: proj } = await supabase
  .from("projects")
  .select("video_model_id, video_duration, video_aspect_ratio")
  .eq("id", projectId)
  .single();

console.log("Project model config:");
console.log("  model:", proj.video_model_id);
console.log("  duration:", proj.video_duration);
console.log("  aspect:", proj.video_aspect_ratio);
console.log();

const { data: beats } = await supabase
  .from("project_beats")
  .select("beat_number, video_status, video_error, image_url")
  .eq("project_id", projectId)
  .order("beat_number");

const failed = beats.filter((b) => b.video_status === "failed");
console.log(`Failed beats: ${failed.length}/${beats.length}`);

// Group by error message
const errorGroups = {};
for (const b of failed) {
  const key = b.video_error ?? "(no error)";
  errorGroups[key] = (errorGroups[key] ?? 0) + 1;
}
console.log("\nError grouping:");
for (const [err, count] of Object.entries(errorGroups).sort((a, b) => b[1] - a[1])) {
  console.log(`  [${count}x] ${err}`);
}

// Check a few image URLs
console.log("\nSpot-checking image URLs for first 3 failed beats:");
for (const b of failed.slice(0, 3)) {
  const url = b.image_url;
  if (!url) {
    console.log(`  beat ${b.beat_number}: NO IMAGE URL`);
    continue;
  }
  try {
    const res = await fetch(url, { method: "HEAD" });
    console.log(`  beat ${b.beat_number}: ${res.status} ${res.statusText} ${url.slice(0, 80)}...`);
  } catch (e) {
    console.log(`  beat ${b.beat_number}: FETCH ERROR ${e.message} url=${url.slice(0, 80)}...`);
  }
}
