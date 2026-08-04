import { NextResponse } from "next/server";
import { createPresignedUpload, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { requireStorageHeadroom } from "@/lib/storage-quota";

// Returns a short-lived presigned PUT URL so the browser can upload
// directly to R2, bypassing Vercel's ~4.5 MB body limit on Route
// Handlers. The caller PUTs the file to uploadUrl with the same
// Content-Type sent here, then uses publicUrl as the persisted URL.
export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const noRoom = await requireStorageHeadroom(user);
  if (noRoom) return noRoom;

  const body = await req.json().catch(() => ({})) as {
    projectId?: string;
    folder?: string;
    filename?: string;
    contentType?: string;
  };

  const { projectId, folder, filename, contentType } = body;
  if (!projectId || !filename || !contentType) {
    return NextResponse.json({ error: "projectId, filename and contentType are required" }, { status: 400 });
  }

  // "one-click" is a settings-scope sentinel: assets uploaded from the
  // 1Click config page (bgm/logo) belong to the user's preset, not to
  // any project, so they live under <user>/one-click/… and skip the
  // project-ownership check.
  if (projectId !== "one-click") {
    const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).eq("user_id", user.id).single();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const ext = filename.split(".").pop() ?? "bin";
  const key = `${userFolderFor(user)}/${projectId}/${folder ?? "uploads"}/${Date.now()}.${ext}`;

  try {
    const { uploadUrl, publicUrl } = await createPresignedUpload(key, contentType);
    return NextResponse.json({ uploadUrl, publicUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Presign failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
