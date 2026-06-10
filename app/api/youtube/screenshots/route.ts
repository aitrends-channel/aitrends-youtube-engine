import { NextResponse } from "next/server";
import { uploadFromUrl, userFolderFor } from "@/lib/supabase/storage";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
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
    const { videos, projectId, kinds, attempt: rawAttempt }: {
      videos: VideoInput[];
      projectId: string;
      kinds?: Kind[];
      attempt?: number;
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

    // Frame stills: 2 per video × 10 videos = 20 frames. The vision-
    // analysis route's MAX_VIDEO_IMAGES is bumped to 20 to actually
    // consume all captured frames. Thumbnail-only calls are light
    // (1 image per video) so we still pull 5 from the top of the
    // channel's view-count list.
    //
    // Refetch variety (`attempt` from the client, defaults to 0):
    // YouTube only exposes three auto-sampled frame thumbs per video
    // (1.jpg ≈ ~25%, 2.jpg ≈ ~50%, 3.jpg ≈ ~75%), so each refetch
    // first shifts the video window to surface entirely different
    // videos when more than MAX_VIDEOS are available, then cycles
    // through different frame-index pairs once windows are exhausted.
    // Cap the cycle so the file paths in R2 stay deterministic per
    // (videoId, frame-index) — uploads short-circuit if the object
    // already exists.
    const MAX_VIDEOS = wantFrames ? 10 : 5;
    const FRAME_PAIRS: readonly (readonly [number, number])[] = [[1, 3], [1, 2], [2, 3]];
    const attempt = Number.isFinite(rawAttempt) && (rawAttempt ?? 0) >= 0 ? Math.floor(rawAttempt!) : 0;
    const windowsAvailable = Math.max(1, Math.ceil(videos.length / MAX_VIDEOS));
    const videoOffset = (attempt % windowsAvailable) * MAX_VIDEOS;
    const framePairIdx = wantFrames
      ? Math.floor(attempt / windowsAvailable) % FRAME_PAIRS.length
      : 0;
    const FRAME_INDICES = FRAME_PAIRS[framePairIdx];
    // wrap the slice — if the window runs past the end of the array, we
    // still want MAX_VIDEOS results when possible.
    const limitedVideos = videos.length > MAX_VIDEOS
      ? Array.from({ length: MAX_VIDEOS }, (_, i) => videos[(videoOffset + i) % videos.length])
      : videos;
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
          ? (await Promise.all(FRAME_INDICES.map((n) =>
              tryUpload(`${base}-frame-${n}.jpg`, `https://img.youtube.com/vi/${videoId}/${n}.jpg`)
            ))).filter((u): u is string => u !== null)
          : [];

        return { videoId, title, thumbnailUrl, frameUrls };
      })
    );

    // Persist the frame-capture results to the project so the visuals
    // page can re-hydrate the grid on refresh. Only write on frame
    // fetches — thumbnail-only calls (Thumbnails step) don't belong on
    // this column. Best-effort: a write failure here doesn't undo the
    // R2 uploads or fail the request — the client still gets the
    // URLs, and the user just loses the refresh-resume convenience.
    if (wantFrames) {
      const { error: updErr } = await supabase
        .from("projects")
        .update({ auto_frames: results })
        .eq("id", projectId)
        .eq("user_id", user.id);
      if (updErr) console.warn("[screenshots] failed to persist auto_frames", updErr);
    }

    return NextResponse.json({ screenshots: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Screenshot extraction failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
