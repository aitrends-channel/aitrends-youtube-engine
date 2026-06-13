import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  // Find all beats with the wrong bucket in the URL
  const { data: broken, error: fetchError } = await supabase
    .from("project_beats")
    .select("id, beat_number, project_id, video_url")
    .like("video_url", "%/object/public/media/%");

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!broken?.length) return NextResponse.json({ fixed: 0, message: "No broken URLs found" });

  let fixed = 0;
  const errors: string[] = [];

  for (const beat of broken) {
    const newUrl = (beat.video_url as string).replace("/object/public/media/", "/object/public/assets/");
    const { error } = await supabase
      .from("project_beats")
      .update({ video_url: newUrl })
      .eq("id", beat.id);
    if (error) errors.push(`beat ${beat.beat_number}: ${error.message}`);
    else fixed++;
  }

  return NextResponse.json({ fixed, total: broken.length, errors });
}
