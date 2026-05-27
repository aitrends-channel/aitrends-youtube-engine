import type { ChannelInfo, TopVideo } from "@/lib/types";

function getYouTubeApiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY is not configured");
  return key;
}

function formatSubscribers(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}

function parseChannelUrl(channelUrl: string): { type: "id" | "handle" | "username"; value: string } {
  let url: URL;
  try {
    url = new URL(channelUrl.startsWith("http") ? channelUrl : `https://youtube.com/${channelUrl}`);
  } catch {
    if (channelUrl.startsWith("UC") && channelUrl.length > 20) return { type: "id", value: channelUrl };
    return { type: "handle", value: channelUrl.replace(/^@/, "") };
  }

  const p = url.pathname;
  const channelMatch = p.match(/^\/channel\/(UC[\w-]+)/);
  if (channelMatch) return { type: "id", value: channelMatch[1] };

  const handleMatch = p.match(/^\/@([\w.-]+)/);
  if (handleMatch) return { type: "handle", value: handleMatch[1] };

  const userMatch = p.match(/^\/user\/([\w.-]+)/);
  if (userMatch) return { type: "username", value: userMatch[1] };

  // /c/customname — treat as handle
  const customMatch = p.match(/^\/c\/([\w.-]+)/);
  if (customMatch) return { type: "handle", value: customMatch[1] };

  return { type: "handle", value: p.replace(/^\//, "").replace(/^@/, "") };
}

async function fetchChannelInfo(channelUrl: string): Promise<{ id: string; name: string; subscribers: string; description: string }> {
  const apiKey = getYouTubeApiKey();
  const { type, value } = parseChannelUrl(channelUrl);

  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("key", apiKey);
  if (type === "id") url.searchParams.set("id", value);
  else if (type === "handle") url.searchParams.set("forHandle", value);
  else url.searchParams.set("forUsername", value);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube channel fetch failed (${res.status})`);
  const data = await res.json() as {
    items?: {
      id: string;
      snippet: { title: string; description: string };
      statistics: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
    }[];
    error?: { message: string };
  };
  if (data.error) throw new Error(`YouTube API: ${data.error.message}`);

  const channel = data.items?.[0];
  if (!channel) throw new Error("Channel not found. Check the URL and try again.");

  const subscribers = channel.statistics.hiddenSubscriberCount
    ? "Hidden"
    : formatSubscribers(parseInt(channel.statistics.subscriberCount ?? "0", 10));

  return { id: channel.id, name: channel.snippet.title, subscribers, description: channel.snippet.description };
}

async function fetchTopVideos(channelId: string): Promise<TopVideo[]> {
  const apiKey = getYouTubeApiKey();

  // Top 10 videos by view count
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("channelId", channelId);
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("order", "viewCount");
  searchUrl.searchParams.set("maxResults", "10");
  searchUrl.searchParams.set("key", apiKey);

  const searchRes = await fetch(searchUrl.toString());
  if (!searchRes.ok) throw new Error(`YouTube search failed (${searchRes.status})`);
  const searchData = await searchRes.json() as {
    items?: { id: { videoId: string } }[];
    error?: { message: string };
  };
  if (searchData.error) throw new Error(`YouTube API: ${searchData.error.message}`);

  const videoIds = (searchData.items ?? []).map(i => i.id.videoId);
  if (!videoIds.length) return [];

  // Exact stats and duration
  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.searchParams.set("part", "snippet,statistics,contentDetails");
  videosUrl.searchParams.set("id", videoIds.join(","));
  videosUrl.searchParams.set("key", apiKey);

  const videosRes = await fetch(videosUrl.toString());
  if (!videosRes.ok) throw new Error(`YouTube videos fetch failed (${videosRes.status})`);
  const videosData = await videosRes.json() as {
    items?: {
      id: string;
      snippet: { title: string };
      statistics: { viewCount?: string };
      contentDetails: { duration: string };
    }[];
    error?: { message: string };
  };
  if (videosData.error) throw new Error(`YouTube API: ${videosData.error.message}`);

  return (videosData.items ?? []).map(v => ({
    videoId: v.id,
    title: v.snippet.title,
    viewCount: parseInt(v.statistics.viewCount ?? "0", 10) || 0,
    duration: v.contentDetails.duration,
  }));
}

export async function resolveChannel(channelUrl: string): Promise<ChannelInfo> {
  const channel = await fetchChannelInfo(channelUrl);
  const topVideos = await fetchTopVideos(channel.id);

  return {
    channelId: channel.id,
    channelName: channel.name,
    subscribers: channel.subscribers,
    description: channel.description,
    topVideos,
  };
}
