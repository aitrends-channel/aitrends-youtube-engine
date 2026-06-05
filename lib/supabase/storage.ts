import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

// Per-user folder name for R2 keys. Email is preferred (human-readable
// when browsing the bucket); user.id is the safe fallback. Lowercased
// to avoid case-mismatch surprises.
export function userFolderFor(user: { email?: string | null; id: string }): string {
  return ((user.email ?? user.id) || user.id).trim().toLowerCase();
}

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

// Presigned PUT URL for direct browser → R2 uploads. Use this when the
// payload could exceed Vercel's serverless function body limit (~4.5MB)
// — the browser PUTs straight to R2, bypassing our route entirely. The
// returned publicUrl is what the row should point to once the PUT
// succeeds; the caller is responsible for updating DB state afterwards.
export async function createPresignedUpload(
  path: string,
  contentType: string,
  expiresInSeconds: number = 600
): Promise<{ uploadUrl: string; publicUrl: string }> {
  if (!BUCKET) throw new Error("R2 storage is not configured — R2_BUCKET_NAME environment variable is missing");
  if (!PUBLIC_URL) throw new Error("R2 storage is not configured — R2_PUBLIC_URL environment variable is missing");
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: path,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(r2, cmd, { expiresIn: expiresInSeconds });
  return { uploadUrl, publicUrl: `${PUBLIC_URL}/${path}` };
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
