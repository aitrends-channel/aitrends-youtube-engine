import { NextResponse } from "next/server";
import { uploadFromUrl } from "@/lib/supabase/storage";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

interface VideoInput {
  videoId: string;
  title: string;
}

interface VideoScreenshots {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  frameUrls: string[];
}

async function tryUpload(path: string, url: string): Promise<string | null> {
  try {
    return await uploadFromUrl(path, url, "image/jpeg");
  } catch {
    // R2 upload failed — verify the source URL is accessible and return it directly as fallback
    try {
      const check = await fetch(url, { method: "HEAD" });
      return check.ok ? url : null;
    } catch {
      return null;
    }
  }
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  void user;

  try {
    const { videos, projectId }: { videos: VideoInput[]; projectId: string } = await req.json();

    if (!videos?.length || !projectId) {
      return NextResponse.json({ error: "videos and projectId required" }, { status: 400 });
    }

    const results: VideoScreenshots[] = await Promise.all(
      videos.map(async ({ videoId, title }) => {
        const base = `${projectId}/auto-frames/${videoId}`;

        // Thumbnail — try maxresdefault, fall back to hqdefault
        const thumbnailUrl =
          (await tryUpload(`${base}-thumb.jpg`, `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`)) ??
          (await tryUpload(`${base}-thumb.jpg`, `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`)) ??
          "";

        // Auto-generated frames at ~25%, ~50%, ~75% through the video
        const frameResults = await Promise.all(
          [1, 2, 3].map((n) =>
            tryUpload(`${base}-frame-${n}.jpg`, `https://img.youtube.com/vi/${videoId}/${n}.jpg`)
          )
        );
        const frameUrls = frameResults.filter((u): u is string => u !== null);

        return { videoId, title, thumbnailUrl, frameUrls };
      })
    );

    return NextResponse.json({ screenshots: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Screenshot extraction failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
