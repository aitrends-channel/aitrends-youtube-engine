import type { ChannelInfo, TopVideo } from "@/lib/types";
import { supabase } from "@/lib/supabase/client";

const YOUTUBE_DAILY_QUOTA = 10_000;
// Quota units per call type (YouTube Data API v3)
const QUOTA = { channels_list: 1, search_list: 100, videos_list: 1, playlistItems_list: 1 } as const;
const QUOTA_CACHED_RESOLVE = QUOTA.channels_list; // 1 (only channels.list runs before cache hit)

export { YOUTUBE_DAILY_QUOTA };

class YouTubeQuotaError extends Error {
  constructor() { super("YouTube API quota exceeded"); }
}

class YouTubeNotFoundError extends Error {
  constructor(public reason: string, message: string) { super(message); }
}

async function youtubeGet<T>(url: URL): Promise<T> {
  const res = await fetch(url.toString());
  const data = await res.json() as { error?: { message?: string; errors?: { reason?: string }[] } };
  const reason = data?.error?.errors?.[0]?.reason;
  if (reason === "quotaExceeded" || reason === "rateLimitExceeded") throw new YouTubeQuotaError();
  if (reason === "playlistNotFound" || reason === "playlistItemsNotAccessible") {
    throw new YouTubeNotFoundError(reason, data.error?.message ?? "Playlist not found");
  }
  if (data?.error) throw new Error(`YouTube API: ${data.error.message ?? "unknown error"}`);
  return data as T;
}

async function getYouTubeKeyRow(): Promise<{ id: string; keys: string[]; current_index: number } | null> {
  const { data } = await supabase
    .from("product_config")
    .select("id, keys, current_index")
    .eq("service", "youtube_data_api_key")
    .eq("active", true)
    .single();
  if (!data) return null;
  return { id: data.id, keys: data.keys as string[], current_index: data.current_index ?? 0 };
}

async function advanceKey(rowId: string, failedIndex: number, total: number): Promise<void> {
  const next = (failedIndex + 1) % total;
  await supabase
    .from("product_config")
    .update({ current_index: next })
    .eq("id", rowId);
}

async function recordQuotaUsage(rowId: string, keyIndex: number, units: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  const { data: row } = await supabase
    .from("product_config")
    .select("keys, quota_tracking")
    .eq("id", rowId)
    .single();
  if (!row) return;

  const keysCount = (row.keys as string[]).length;
  const tracking: Array<{ units_used: number; date: string }> = Array.isArray(row.quota_tracking)
    ? [...(row.quota_tracking as Array<{ units_used: number; date: string }>)]
    : [];

  while (tracking.length < keysCount) tracking.push({ units_used: 0, date: today });

  const entry = tracking[keyIndex] ?? { units_used: 0, date: today };
  tracking[keyIndex] = {
    units_used: entry.date === today ? entry.units_used + units : units,
    date: today,
  };

  await supabase.from("product_config").update({ quota_tracking: tracking }).eq("id", rowId);
}

function formatSubscribers(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}

function parseChannelUrl(channelUrl: string): { type: "id" | "handle" | "username"; value: string } {
  // Normalise the input so users can paste in whatever form they have.
  const raw = channelUrl.trim();

  // Bare channel ID: starts with UC, no spaces, length > 20. Skip URL parsing.
  if (/^UC[\w-]{20,}$/.test(raw)) return { type: "id", value: raw };

  // Bare handle / handle with @ prefix and no path → treat as handle directly.
  // e.g. "@thebaseEnglish" or "thebaseEnglish"
  if (/^@?[\w.-]+$/.test(raw) && !raw.includes("/") && !raw.includes(":")) {
    return { type: "handle", value: raw.replace(/^@/, "") };
  }

  // Schemeless URL (youtube.com/@foo, www.youtube.com/@foo, m.youtube.com/@foo,
  // youtu.be/...) — prepend https:// so URL() can parse the path correctly.
  let normalised = raw;
  if (!/^https?:\/\//i.test(normalised) && /^(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(normalised)) {
    normalised = "https://" + normalised;
  }

  let url: URL;
  try {
    url = new URL(normalised.startsWith("http") ? normalised : `https://youtube.com/${normalised}`);
  } catch {
    return { type: "handle", value: raw.replace(/^@/, "") };
  }

  const p = url.pathname;
  const channelMatch = p.match(/^\/channel\/(UC[\w-]+)/);
  if (channelMatch) return { type: "id", value: channelMatch[1] };

  const handleMatch = p.match(/^\/@([\w.-]+)/);
  if (handleMatch) return { type: "handle", value: handleMatch[1] };

  const userMatch = p.match(/^\/user\/([\w.-]+)/);
  if (userMatch) return { type: "username", value: userMatch[1] };

  const customMatch = p.match(/^\/c\/([\w.-]+)/);
  if (customMatch) return { type: "handle", value: customMatch[1] };

  return { type: "handle", value: p.replace(/^\//, "").replace(/^@/, "") };
}

async function fetchChannelInfo(
  channelUrl: string,
  apiKey: string
): Promise<{ id: string; name: string; subscribers: string; description: string; uploadsPlaylistId: string }> {
  const { type, value } = parseChannelUrl(channelUrl);

  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics,contentDetails");
  url.searchParams.set("key", apiKey);
  if (type === "id") url.searchParams.set("id", value);
  else if (type === "handle") url.searchParams.set("forHandle", value);
  else url.searchParams.set("forUsername", value);

  const data = await youtubeGet<{
    items?: {
      id: string;
      snippet: { title: string; description: string };
      statistics: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
      contentDetails: { relatedPlaylists: { uploads?: string } };
    }[];
  }>(url);

  const channel = data.items?.[0];
  if (!channel) throw new Error("Channel not found. Check the URL and try again.");

  const subscribers = channel.statistics.hiddenSubscriberCount
    ? "Hidden"
    : formatSubscribers(parseInt(channel.statistics.subscriberCount ?? "0", 10));

  return {
    id: channel.id,
    name: channel.snippet.title,
    subscribers,
    description: channel.snippet.description,
    uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads ?? "",
  };
}

async function fetchTopVideos(
  channelId: string,
  uploadsPlaylistId: string,
  apiKey: string
): Promise<{ videos: TopVideo[]; quotaUsed: number }> {
  let quotaUsed = QUOTA.search_list;

  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("channelId", channelId);
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("order", "viewCount");
  searchUrl.searchParams.set("maxResults", "10");
  searchUrl.searchParams.set("key", apiKey);

  const searchData = await youtubeGet<{ items?: { id: { videoId: string } }[] }>(searchUrl);
  let videoIds = (searchData.items ?? []).map(i => i.id.videoId);

  // search.list with type=video silently drops Shorts on some channels
  // (and returns nothing for channels with only livestreams or very new
  // uploads). Fall back to the uploads playlist, which lists every
  // upload regardless of format.
  if (!videoIds.length && uploadsPlaylistId) {
    const playlistUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    playlistUrl.searchParams.set("part", "contentDetails");
    playlistUrl.searchParams.set("playlistId", uploadsPlaylistId);
    playlistUrl.searchParams.set("maxResults", "50");
    playlistUrl.searchParams.set("key", apiKey);

    try {
      const playlistData = await youtubeGet<{
        items?: { contentDetails: { videoId: string } }[];
      }>(playlistUrl);
      quotaUsed += QUOTA.playlistItems_list;
      videoIds = (playlistData.items ?? []).map(i => i.contentDetails.videoId);
    } catch (err) {
      // Uploads playlist 404s when the channel has no public uploads at
      // all (or is terminated/region-blocked). Treat as "no videos" so
      // the caller surfaces a real reason instead of a 500.
      if (err instanceof YouTubeNotFoundError) {
        quotaUsed += QUOTA.playlistItems_list;
      } else {
        throw err;
      }
    }
  }

  if (!videoIds.length) return { videos: [], quotaUsed };

  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.searchParams.set("part", "snippet,statistics,contentDetails");
  videosUrl.searchParams.set("id", videoIds.join(","));
  videosUrl.searchParams.set("key", apiKey);

  const videosData = await youtubeGet<{
    items?: {
      id: string;
      snippet: { title: string; publishedAt?: string };
      statistics: { viewCount?: string };
      contentDetails: { duration: string };
    }[];
  }>(videosUrl);
  quotaUsed += QUOTA.videos_list;

  const videos = (videosData.items ?? []).map(v => ({
    videoId: v.id,
    title: v.snippet.title,
    viewCount: parseInt(v.statistics.viewCount ?? "0", 10) || 0,
    duration: v.contentDetails.duration,
    publishedAt: v.snippet.publishedAt,
  }));

  // The uploads-playlist path returns items in upload order, not view
  // order. Sort by viewCount desc and cap at 10 so downstream sees the
  // channel's strongest videos either way.
  videos.sort((a, b) => b.viewCount - a.viewCount);
  return { videos: videos.slice(0, 10), quotaUsed };
}

async function getCachedChannel(channelId: string): Promise<ChannelInfo | null> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("projects")
    .select("channel_info")
    .eq("channel_info->>channelId", channelId)
    .gte("channel_info->>lastCachedAt", cutoff)
    .limit(1)
    .single();

  if (!data?.channel_info) return null;
  return data.channel_info as ChannelInfo;
}

export async function resolveChannel(channelUrl: string): Promise<ChannelInfo> {
  const row = await getYouTubeKeyRow();

  let keys: string[] = [];
  if (row && row.keys.length > 0) {
    const start = row.current_index ?? 0;
    keys = [...row.keys.slice(start), ...row.keys.slice(0, start)];
  } else {
    const envKey = process.env.YOUTUBE_API_KEY;
    if (!envKey) throw new Error("No YouTube API keys configured");
    keys = [envKey];
  }

  let lastError: Error = new Error("No keys available");

  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i];
    const absoluteIndex = row ? ((row.current_index ?? 0) + i) % row.keys.length : 0;

    try {
      const channel = await fetchChannelInfo(channelUrl, apiKey);
      const cached = await getCachedChannel(channel.id);

      if (cached) {
        // Fire-and-forget quota tracking (channels.list only)
        if (row) recordQuotaUsage(row.id, absoluteIndex, QUOTA_CACHED_RESOLVE).catch(() => {});
        return cached;
      }

      const { videos: topVideos, quotaUsed } = await fetchTopVideos(channel.id, channel.uploadsPlaylistId, apiKey);

      // Fire-and-forget quota tracking (channels.list + whatever the top-videos path actually consumed)
      if (row) recordQuotaUsage(row.id, absoluteIndex, QUOTA.channels_list + quotaUsed).catch(() => {});

      return {
        channelId: channel.id,
        channelName: channel.name,
        subscribers: channel.subscribers,
        description: channel.description,
        topVideos,
        lastCachedAt: new Date().toISOString(),
      };
    } catch (err) {
      lastError = err as Error;
      if (err instanceof YouTubeQuotaError && row && i < keys.length - 1) {
        await advanceKey(row.id, absoluteIndex, row.keys.length);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}
