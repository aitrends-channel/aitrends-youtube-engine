import { getSettings } from "@/lib/settings";
import type { TopVideo, VideoMetadata } from "@/lib/types";

const YT_API = "https://www.googleapis.com/youtube/v3";

async function fetchCommentsForVideo(videoId: string, apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(
      `${YT_API}/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&order=relevance&maxResults=20&key=${apiKey}`
    );
    const data = await res.json();
    if (data.error) return [];
    return (data.items ?? [])
      .map((item: { snippet: { topLevelComment: { snippet: { textOriginal: string } } } }) =>
        (item.snippet.topLevelComment.snippet.textOriginal ?? "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
      )
      .filter((t: string) => t.length > 10 && t.length < 500);
  } catch {
    return [];
  }
}

export async function fetchVideoMetadata(videos: TopVideo[], userId: string): Promise<VideoMetadata[]> {
  const { youtube_api_key: apiKey } = await getSettings(userId);
  if (!apiKey) throw new Error("YouTube API key not configured. Add it in Settings.");
  if (!videos.length) return [];

  const ids = videos.map((v) => v.videoId).join(",");
  const res = await fetch(
    `${YT_API}/videos?part=snippet,statistics,contentDetails&id=${encodeURIComponent(ids)}&key=${apiKey}`
  );
  const data = await res.json();

  const itemsMap: Record<string, {
    snippet: { title: string; description: string; tags?: string[]; publishedAt: string };
    statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
    contentDetails: { duration: string };
  }> = {};
  for (const item of data.items ?? []) {
    itemsMap[item.id] = item;
  }

  // Fetch comments for all videos in parallel
  const commentsMap: Record<string, string[]> = {};
  await Promise.all(
    videos.map(async (v) => {
      commentsMap[v.videoId] = await fetchCommentsForVideo(v.videoId, apiKey);
    })
  );

  return videos
    .filter((v) => itemsMap[v.videoId])
    .map((v) => {
      const item = itemsMap[v.videoId];
      return {
        videoId: v.videoId,
        title: item.snippet.title,
        description: item.snippet.description ?? "",
        tags: item.snippet.tags ?? [],
        viewCount: parseInt(item.statistics.viewCount ?? "0", 10),
        likeCount: parseInt(item.statistics.likeCount ?? "0", 10),
        commentCount: parseInt(item.statistics.commentCount ?? "0", 10),
        publishedAt: item.snippet.publishedAt,
        duration: item.contentDetails.duration,
        topComments: commentsMap[v.videoId] ?? [],
      };
    });
}
