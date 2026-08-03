export const dynamic = "force-dynamic";
export const maxDuration = 60;
import { NextResponse } from "next/server";
import { uploadBuffer, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { requireStorageHeadroom } from "@/lib/storage-quota";

// Server-side upload: the browser POSTs the file here (multipart) and we
// push it to R2 with the S3 client. Unlike the presigned direct-PUT flow
// (/api/upload/presign), this is a same-origin request, so it needs NO
// bucket CORS policy — the reliable path for smaller assets like images,
// where a missing R2 CORS config otherwise makes the browser PUT fail
// with "Failed to fetch". Large files (video) should keep using the
// presigned flow to bypass the platform request-body cap.
export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const noRoom = await requireStorageHeadroom(user);
  if (noRoom) return noRoom;

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 }); }

  const file = form.get("file");
  const projectId = form.get("projectId");
  const folder = (form.get("folder") as string | null) ?? "uploads";
  if (!(file instanceof File) || typeof projectId !== "string" || !projectId) {
    return NextResponse.json({ error: "file and projectId are required" }, { status: 400 });
  }

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .single();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const ext = (file.name.split(".").pop() || "bin").toLowerCase();
  const key = `${userFolderFor(user)}/${projectId}/${folder}/${Date.now()}.${ext}`;
  try {
    const buf = await file.arrayBuffer();
    const url = await uploadBuffer(key, buf, file.type || "application/octet-stream");
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
