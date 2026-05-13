import { NextResponse } from "next/server";
import { checkImageTask } from "@/lib/kie/images";
import { uploadFromUrl } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 30;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { projectId, beatNumber, taskId } = await req.json() as {
      projectId: string; beatNumber: number; taskId: string;
    };

    if (!projectId || !beatNumber || !taskId) {
      return NextResponse.json({ error: "projectId, beatNumber, and taskId are required" }, { status: 400 });
    }

    const result = await checkImageTask(taskId, user.id);

    if (result.status === "done" && result.url) {
      const storagePath = `${projectId}/images/beat-${beatNumber}_${Date.now()}.png`;
      const publicUrl = await uploadFromUrl(storagePath, result.url, "image/png");

      await supabase.from("project_beats")
        .update({ image_url: publicUrl, image_status: "done" })
        .eq("project_id", projectId)
        .eq("beat_number", beatNumber);

      return NextResponse.json({ status: "done", url: publicUrl });
    }

    if (result.status === "failed") {
      await supabase.from("project_beats")
        .update({ image_status: "failed" })
        .eq("project_id", projectId)
        .eq("beat_number", beatNumber);

      return NextResponse.json({ status: "failed", error: result.error });
    }

    return NextResponse.json({ status: "pending" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to poll image task";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
