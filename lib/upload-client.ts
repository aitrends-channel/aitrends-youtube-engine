// Browser → R2 direct upload via a presigned PUT URL. Bypasses
// Vercel's ~4.5 MB body limit on Route Handlers — uploading larger
// assets through /api/upload would silently 413 in prod and look like
// "upload succeeded but the asset is missing downstream".
//
// Server side: POST /api/upload/presign validates auth + project
// ownership and returns { uploadUrl, publicUrl }. The browser then PUTs
// the file directly to R2 with the matching Content-Type.
export async function presignedUpload(
  file: File,
  projectId: string,
  folder: string,
): Promise<string> {
  const contentType = file.type || "application/octet-stream";
  const presignRes = await fetch("/api/upload/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, folder, filename: file.name, contentType }),
  });
  const presignData = await presignRes.json().catch(() => ({}));
  if (!presignRes.ok) throw new Error(presignData.error ?? "Failed to presign upload");
  const { uploadUrl, publicUrl } = presignData as { uploadUrl: string; publicUrl: string };
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!putRes.ok) throw new Error(`Upload to storage failed (${putRes.status})`);
  return publicUrl;
}
