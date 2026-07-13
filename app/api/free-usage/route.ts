export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getFreeUsageToday, FREE_IMAGE_DAILY_CAP } from "@/lib/freeUsage";
import type { User } from "@supabase/supabase-js";

// Powers the "Free" tab's daily usage bar. Returns today's free-image
// count for the signed-in user against the estimated daily cap.
export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const image = await getFreeUsageToday(user.id, "image");
  return NextResponse.json({ image, imageCap: FREE_IMAGE_DAILY_CAP });
}
