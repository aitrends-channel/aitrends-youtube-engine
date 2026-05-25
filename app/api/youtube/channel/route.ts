import { NextResponse } from "next/server";
import { resolveChannel } from "@/lib/youtube/channel";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 60;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { channelUrl } = await req.json();
    if (!channelUrl?.trim()) {
      return NextResponse.json({ error: "Channel URL is required" }, { status: 400 });
    }

    const channelInfo = await resolveChannel(channelUrl.trim());
    return NextResponse.json(channelInfo);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch channel";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
