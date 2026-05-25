import type { TopVideo, VideoMetadata } from "@/lib/types";

const SUPADATA_BASE = "https://api.supadata.ai/v1";

function secondsToISO(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `PT${m}M${s}S`;
}

export async function fetchVideoMetadata(videos: TopVideo[]): Promise<VideoMetadata[]> {
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) throw new Error("SUPADATA_API_KEY is not configured");
  if (!videos.length) return [];

  const results = await Promise.all(
    videos.map(async (v): Promise<VideoMetadata | null> => {
      try {
        const res = await fetch(
          `${SUPADATA_BASE}/youtube/video?id=${encodeURIComponent(v.videoId)}`,
          { headers: { "x-api-key": apiKey } }
        );
        if (!res.ok) return null;
        const data = await res.json() as {
          title?: string;
          description?: string;
          tags?: string[];
          viewCount?: number;
          likeCount?: number;
          uploadDate?: string;
          duration?: number;
        };
        return {
          videoId: v.videoId,
          title: data.title ?? v.title,
          description: data.description ?? "",
          tags: data.tags ?? [],
          viewCount: data.viewCount ?? 0,
          likeCount: data.likeCount ?? 0,
          commentCount: 0,
          publishedAt: data.uploadDate ?? "",
          duration: typeof data.duration === "number" ? secondsToISO(data.duration) : "",
          topComments: [],
        };
      } catch {
        return null;
      }
    })
  );

  return results.filter((r): r is VideoMetadata => r !== null);
}
