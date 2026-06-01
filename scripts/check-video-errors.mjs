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
const userId = "da7615a6-c5dc-4d50-a2c1-ee6f762cae4f";

// Get this user's most recent project + video settings
const { data: projects } = await supabase
  .from("projects")
  .select("id, video_model_id, video_duration, video_aspect_ratio, updated_at")
  .eq("user_id", userId)
  .order("updated_at", { ascending: false })
  .limit(1);

if (!projects?.length) {
  console.log("No projects for user");
  process.exit(0);
}

const proj = projects[0];
console.log("Project:", proj.id);
console.log("Video model:", proj.video_model_id);
console.log("Duration:", proj.video_duration);
console.log("Aspect ratio:", proj.video_aspect_ratio);
console.log();

const { data: beats } = await supabase
  .from("project_beats")
  .select("beat_number, video_status, video_error")
  .eq("project_id", proj.id)
  .not("video_error", "is", null)
  .order("beat_number")
  .limit(5);

console.log(`Beats with errors (${beats?.length ?? 0}):`);
for (const b of beats ?? []) {
  console.log(`  beat ${b.beat_number} [${b.video_status}]: ${b.video_error}`);
}
