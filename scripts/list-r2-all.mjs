import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
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

const projectId = "944ac1c5-9aa6-4cb8-b39f-1ab7d527c045";
const out = await r2.send(new ListObjectsV2Command({
  Bucket: env.R2_BUCKET_NAME,
  Prefix: projectId,
  MaxKeys: 1000,
}));

console.log(`Total objects with prefix containing project ID: ${(out.Contents ?? []).length}`);
for (const o of out.Contents ?? []) {
  console.log(`  ${o.Key}  (${o.Size}B)`);
}
