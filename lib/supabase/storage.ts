import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME!;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");

export async function uploadBuffer(
  path: string,
  buffer: ArrayBuffer,
  contentType: string
): Promise<string> {
  if (!BUCKET) throw new Error("R2 storage is not configured — R2_BUCKET_NAME environment variable is missing");
  if (!PUBLIC_URL) throw new Error("R2 storage is not configured — R2_PUBLIC_URL environment variable is missing");
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: path,
    Body: Buffer.from(buffer),
    ContentType: contentType,
  }));
  return `${PUBLIC_URL}/${path}`;
}

export async function uploadFromUrl(path: string, url: string, contentType: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch asset from URL: ${url}`);
  const buffer = await res.arrayBuffer();
  return uploadBuffer(path, buffer, contentType);
}

export function getPublicUrl(path: string): string {
  return `${PUBLIC_URL}/${path}`;
}

export async function deleteFolder(prefix: string): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const list = await r2.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));

    if (objects.length > 0) {
      await r2.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: objects, Quiet: true },
      }));
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}
