import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { isAdminEmail } from "@/lib/admin";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function POST() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
