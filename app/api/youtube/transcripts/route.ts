import { NextResponse } from "next/server";
import { fetchTranscriptsViaSupadata } from "@/lib/youtube/supadata";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

// Supadata batch jobs can legitimately take 60-90s on channels with
// long videos. The default Vercel 60s ceiling was killing functions
// mid-poll and returning plain-text FUNCTION_INVOCATION_TIMEOUT
// instead of the clean "batch job timed out" JSON error our error
// mapper expects. 300s leaves Supadata real headroom and our internal
// pollBatch deadline (now 280s) trips first with a usable error.
export const maxDuration = 300;

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const { videos } = await req.json();
    if (!Array.isArray(videos) || !videos.length) {
      return NextResponse.json({ error: "videos array is required" }, { status: 400 });
    }

    const transcripts = await fetchTranscriptsViaSupadata(videos);
    return NextResponse.json({ transcripts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch transcripts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
