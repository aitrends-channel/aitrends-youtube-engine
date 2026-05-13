import { NextResponse } from "next/server";
import { submitImageTask } from "@/lib/kie/images";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 30;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { projectId, beatNumber, imagePrompt, modelId, aspectRatio = "16:9", resolution } = await req.json() as {
      projectId: string; beatNumber: number; imagePrompt: string; modelId: string;
      aspectRatio?: string; resolution?: string;
    };

    if (!projectId || !beatNumber || !modelId) {
      return NextResponse.json({ error: "projectId, beatNumber, and modelId are required" }, { status: 400 });
    }
    if (!imagePrompt) {
      console.error(`[images/submit] Beat ${beatNumber} has no imagePrompt`);
      return NextResponse.json({ error: `Beat ${beatNumber} has no image prompt` }, { status: 400 });
    }

    await supabase.from("project_beats")
      .update({ image_status: "generating" })
      .eq("project_id", projectId)
      .eq("beat_number", beatNumber);

    const taskId = await submitImageTask(imagePrompt, modelId, aspectRatio, resolution, user.id);
    console.log(`[images/submit] beat=${beatNumber} model=${modelId} taskId=${taskId}`);

    return NextResponse.json({ taskId, beatNumber });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to submit image task";
    console.error("[images/submit] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
