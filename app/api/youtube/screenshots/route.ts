import { NextResponse } from "next/server";
import { uploadFromUrl, userFolderFor } from "@/lib/supabase/storage";
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

type Kind = "frames" | "thumbnails";

async function tryUpload(path: string, url: string): Promise<string | null> {
  try {
    return await uploadFromUrl(path, url, "image/jpeg");
  } catch {
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

  try {
    const { videos, projectId, kinds }: {
      videos: VideoInput[];
      projectId: string;
      kinds?: Kind[];
    } = await req.json();

    if (!videos?.length || !projectId) {
      return NextResponse.json({ error: "videos and projectId required" }, { status: 400 });
    }

    // `kinds` controls which image classes to fetch. Visuals step asks
    // for ["frames"] only (video style DNA). Thumbnails step asks for
    // ["thumbnails"] only (channel thumbnail conventions). Default keeps
    // both for backwards compatibility, but no caller should rely on it.
    const want = new Set<Kind>(kinds ?? ["frames", "thumbnails"]);
    const wantFrames = want.has("frames");
    const wantThumbs = want.has("thumbnails");

    // Frame stills are heavy (3 per video → cap at 3 videos = 9 frames,
    // well within the vision-analysis 10-image budget). Thumbnail-only
    // calls are light (1 image per video) so we pull 5 from the top of
    // the channel's view-count list.
    const MAX_VIDEOS = wantFrames ? 3 : 5;
    const limitedVideos = videos.slice(0, MAX_VIDEOS);
    const userFolder = userFolderFor(user);

    const results: VideoScreenshots[] = await Promise.all(
      limitedVideos.map(async ({ videoId, title }) => {
        const base = `${userFolder}/${projectId}/auto-frames/${videoId}`;

        const thumbnailUrl = wantThumbs
          ? ((await tryUpload(`${base}-thumb.jpg`, `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`)) ??
             (await tryUpload(`${base}-thumb.jpg`, `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`)) ??
             "")
          : "";

        const frameUrls = wantFrames
          ? (await Promise.all([1, 2, 3].map((n) =>
              tryUpload(`${base}-frame-${n}.jpg`, `https://img.youtube.com/vi/${videoId}/${n}.jpg`)
            ))).filter((u): u is string => u !== null)
          : [];

        return { videoId, title, thumbnailUrl, frameUrls };
      })
    );

    return NextResponse.json({ screenshots: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Screenshot extraction failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
