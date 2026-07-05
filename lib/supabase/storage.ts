import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  // R2 will 429/503 under sustained burst (the voiceover-concat route
  // fans out N parallel PutObjects on top of parallel downloads).
  // Default maxAttempts=3 with base-1 backoff drops requests before
  // R2's throttle window clears. Bumping to 6 gives ~15s of total
  // backoff (AWS SDK uses exponential jitter internally) which is
  // enough to ride out typical SlowDown responses.
  maxAttempts: 6,
  // AWS SDK v3 added a CRC32 integrity checksum to every PutObject by
  // default. The checksum gets baked into presigned URLs as
  // x-amz-checksum-crc32=AAAAAA== plus x-amz-sdk-checksum-algorithm=CRC32,
  // which R2 enforces — but a browser doing a direct PUT can't easily
  // compute and forward the matching checksum header, so the upload
  // gets rejected. Setting these to WHEN_REQUIRED drops the auto-added
  // checksum and lets R2 accept the body as-is. Server-side uploads via
  // r2.send(...) are unaffected (R2 still validates the signature).
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  // R2 only fully supports path-style addressing. Without this the
  // SDK signs with virtual-hosted style (bucket as subdomain) and R2
  // rejects with SignatureDoesNotMatch on some operations — same
  // class of issue we hit on the worker.
  forcePathStyle: true,
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

// Best-effort delete of a single object by R2 key. Used by callers that
// already know the exact key (e.g. parsed from a public URL stored on
// the project row) and don't want to list/delete a whole prefix.
// Quiet — a missing key is not an error.
export async function deleteObject(key: string): Promise<void> {
  if (!BUCKET) return;
  await r2.send(new DeleteObjectsCommand({
    Bucket: BUCKET,
    Delete: { Objects: [{ Key: key }], Quiet: true },
  }));
}

// True when the object exists. Goes through the S3 API, NOT the public
// r2.dev URL — the r2.dev development subdomain is rate-limited by
// Cloudflare and HEAD requests against it burn that budget (and can
// themselves 429, forcing needless rebuilds).
export async function objectExists(key: string): Promise<boolean> {
  if (!BUCKET) return false;
  try {
    await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

// Download an object to a local file via the S3 API. Streams the body
// to disk. Exists so server-side consumers (voiceover concat) don't
// fetch through the rate-limited r2.dev public URL — the S3 endpoint
// has no such throttle and the client already retries with backoff
// (maxAttempts: 6 above).
export async function getObjectToFile(key: string, destPath: string): Promise<void> {
  if (!BUCKET) throw new Error("R2 storage is not configured — R2_BUCKET_NAME environment variable is missing");
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Empty body for R2 key ${key}`);
  await pipeline(res.Body as NodeJS.ReadableStream, createWriteStream(destPath));
}

// Convert a R2 public URL back to its bucket key. Returns null when the
// URL is unrelated to our R2 bucket (e.g. the worker's /api/preview/
// proxy URL, or a Supabase legacy URL) so callers can skip the delete.
export function r2KeyFromUrl(url: string): string | null {
  if (!PUBLIC_URL) return null;
  if (!url.startsWith(PUBLIC_URL + "/")) return null;
  return url.slice(PUBLIC_URL.length + 1);
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

// Folder delete with a predicate. Use this when a prefix holds keys
// owned by different features (e.g. auto-frames/ contains both
// thumbnail refs and frame stills) and only some of them should be
// removed.
export async function deleteFolderWhere(
  prefix: string,
  predicate: (key: string) => boolean,
): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const list = await r2.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    const objects = (list.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => !!k && predicate(k))
      .map((Key) => ({ Key }));

    if (objects.length > 0) {
      await r2.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: objects, Quiet: true },
      }));
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}
