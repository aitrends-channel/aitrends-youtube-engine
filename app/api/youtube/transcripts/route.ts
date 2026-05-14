import { NextResponse } from "next/server";
import { fetchTranscripts } from "@/lib/youtube/transcripts";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 60;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  void user;

  try {
    const { videos } = await req.json();
    if (!Array.isArray(videos) || !videos.length) {
      return NextResponse.json({ error: "videos array is required" }, { status: 400 });
    }

    const transcripts = await fetchTranscripts(videos);
    return NextResponse.json({ transcripts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch transcripts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
