import type { ChannelInfo, ContentType, TopVideo } from "@/lib/types";
import { supabase } from "@/lib/supabase/client";

// YouTube Data API search.list videoDuration buckets:
//   long   = > 20 min
//   medium = 4-20 min
//   short  = < 4 min
//
// We map contentType:
//   "shorts" → videoDuration=short  (< 4 min, includes the Shorts product)
//   "long"   → videoDuration=any    (search.list already biases long-form;
//                                     the index drops Shorts so this is
//                                     "everything that isn't a Short" in
//                                     practice — what users mean by Long)
//   "both"   → videoDuration=any    (no filter)
function videoDurationFor(contentType: ContentType): "short" | "any" {
  return contentType === "shorts" ? "short" : "any";
}

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
  if (data?.error) {
    // Pull the endpoint (e.g. "search", "videos", "channels") off the
    // URL so the surfaced error tells us which call tripped. The full
    // params (with key) get logged once for debugging but not echoed
    // to the user.
    const endpoint = url.pathname.split("/").pop() ?? "unknown";
    console.warn(`[youtube] ${endpoint} failed`, {
      status: res.status,
      reason,
      message: data.error.message,
      // Strip the key from the logged URL so we don't leak it.
      url: url.toString().replace(/key=[^&]+/, "key=REDACTED"),
    });
    throw new Error(`YouTube API (${endpoint}): ${data.error.message ?? "unknown error"}`);
  }
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

// Single-pass top-10 fetch. search.list does the heavy lifting:
// `order=viewCount` ranks by views, `videoDuration` filters by the
// channel page's content-type pick. We then make one videos.list call
// to enrich the chosen 10 with duration/captions/publishedAt/viewCount
// (search.list returns only snippet + id, so the enrichment call is
// unavoidable but it's just 1 quota unit). No post-filter, no
// pagination through uploads. Total cost: 101 quota per fetch.
//
// uploadsPlaylistId is no longer used here — the previous fallback
// path was for empty search results, but with videoDuration buckets
// the empty case is a legitimate "channel has no videos of this type"
// signal the caller should surface, not paper over.
async function fetchTopVideos(
  channelId: string,
  _uploadsPlaylistId: string,
  apiKey: string,
  contentType: ContentType,
): Promise<{ videos: TopVideo[]; quotaUsed: number }> {
  let quotaUsed = 0;

  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("channelId", channelId);
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("order", "viewCount");
  searchUrl.searchParams.set("maxResults", "10");
  searchUrl.searchParams.set("videoDuration", videoDurationFor(contentType));
  searchUrl.searchParams.set("key", apiKey);

  const searchData = await youtubeGet<{ items?: { id: { videoId: string } }[] }>(searchUrl);
  quotaUsed += QUOTA.search_list;
  const ids = (searchData.items ?? []).map((i) => i.id.videoId).filter(Boolean);
  if (!ids.length) return { videos: [], quotaUsed };

  // Enrichment — only fields not available on search.list.snippet
  // (duration, caption flag, viewCount). 10 IDs fits in a single call.
  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.searchParams.set("part", "snippet,statistics,contentDetails");
  videosUrl.searchParams.set("id", ids.join(","));
  videosUrl.searchParams.set("key", apiKey);

  const videosData = await youtubeGet<{
    items?: {
      id: string;
      snippet: { title: string; publishedAt?: string };
      statistics: { viewCount?: string };
      contentDetails: { duration: string; caption?: string };
    }[];
  }>(videosUrl);
  quotaUsed += QUOTA.videos_list;

  const videos: TopVideo[] = (videosData.items ?? []).map((v) => ({
    videoId: v.id,
    title: v.snippet.title,
    viewCount: parseInt(v.statistics.viewCount ?? "0", 10) || 0,
    duration: v.contentDetails.duration,
    publishedAt: v.snippet.publishedAt,
    hasCaptions: v.contentDetails.caption === "true",
  }));

  // search.list already returns in viewCount order, but videos.list
  // doesn't preserve input order — re-sort so the channel's strongest
  // videos lead the table.
  videos.sort((a, b) => b.viewCount - a.viewCount);
  return { videos, quotaUsed };
}

async function getCachedChannel(channelId: string, contentType: ContentType): Promise<ChannelInfo | null> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // Partition the cache by contentType — a prior "long" run on this
  // channel must NOT serve a "shorts" request, otherwise the downstream
  // pipeline would see the wrong set of top videos. Old rows written
  // before contentType existed won't match this filter; they re-fetch
  // once and then start hitting the cache normally.
  const { data } = await supabase
    .from("projects")
    .select("channel_info")
    .eq("channel_info->>channelId", channelId)
    .eq("channel_info->>contentType", contentType)
    .gte("channel_info->>lastCachedAt", cutoff)
    .limit(1)
    .single();

  if (!data?.channel_info) return null;
  return data.channel_info as ChannelInfo;
}

export async function resolveChannel(channelUrl: string, contentType: ContentType): Promise<ChannelInfo> {
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
      const cached = await getCachedChannel(channel.id, contentType);

      if (cached) {
        // Fire-and-forget quota tracking (channels.list only)
        if (row) recordQuotaUsage(row.id, absoluteIndex, QUOTA_CACHED_RESOLVE).catch(() => {});
        return cached;
      }

      const { videos: topVideos, quotaUsed } = await fetchTopVideos(channel.id, channel.uploadsPlaylistId, apiKey, contentType);

      // Fire-and-forget quota tracking (channels.list + whatever the top-videos path actually consumed)
      if (row) recordQuotaUsage(row.id, absoluteIndex, QUOTA.channels_list + quotaUsed).catch(() => {});

      return {
        channelId: channel.id,
        channelName: channel.name,
        subscribers: channel.subscribers,
        description: channel.description,
        topVideos,
        contentType,
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
