import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
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

const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

const projectId = process.argv[2] ?? "944ac1c5-9aa6-4cb8-b39f-1ab7d527c045";
const bucket = env.R2_BUCKET_NAME;
const publicUrl = env.R2_PUBLIC_URL?.replace(/\/$/, "");

console.log(`Listing objects in ${bucket} under prefix ${projectId}/`);

const out = await r2.send(new ListObjectsV2Command({
  Bucket: bucket,
  Prefix: `${projectId}/`,
  MaxKeys: 1000,
}));

const videos = (out.Contents ?? []).filter((o) => o.Key?.includes("/videos/") || o.Key?.includes("video") || o.Key?.endsWith(".mp4"));

console.log(`Found ${videos.length} candidate video objects:`);
for (const v of videos) {
  console.log(`  ${v.Key}  (${v.Size} bytes, ${v.LastModified?.toISOString()})`);
}

if (videos.length === 0) {
  console.log("\nNo video files in R2 for this project. The 3 done beats can't be recovered from storage.");
  process.exit(0);
}

console.log("\nMatching to beats...");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: beats } = await supabase
  .from("project_beats")
  .select("beat_number, video_url, video_status")
  .eq("project_id", projectId)
  .order("beat_number");

for (const v of videos) {
  // Extract beat number from key (likely format: <pid>/videos/beat-N_<ts>.mp4 or similar)
  const m = v.Key.match(/beat[-_]?(\d+)/i);
  const beatNum = m ? parseInt(m[1], 10) : null;
  const beat = beatNum ? beats?.find((b) => b.beat_number === beatNum) : null;
  console.log(`  ${v.Key} → beat=${beatNum ?? "?"} currentStatus=${beat?.video_status ?? "?"} hasUrl=${!!beat?.video_url}`);
}
