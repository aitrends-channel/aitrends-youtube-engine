import type { ChannelInfo, TopVideo } from "@/lib/types";
import { getSettings } from "@/lib/settings";

const YT_API = "https://www.googleapis.com/youtube/v3";

function parseChannelUrl(url: string): { type: string; value: string } | null {
  try {
    const u = new URL(url.trim());
    const path = u.pathname;

    if (path.startsWith("/@")) {
      return { type: "handle", value: path.slice(2) };
    }
    if (path.startsWith("/channel/")) {
      return { type: "id", value: path.split("/channel/")[1].split("/")[0] };
    }
    if (path.startsWith("/c/")) {
      return { type: "custom", value: path.split("/c/")[1].split("/")[0] };
    }
    if (path.startsWith("/user/")) {
      return { type: "username", value: path.split("/user/")[1].split("/")[0] };
    }
    const bare = path.slice(1).split("/")[0];
    if (bare) return { type: "handle", value: bare };
  } catch {
    const clean = url.replace(/^@/, "").trim();
    if (clean) return { type: "handle", value: clean };
  }
  return null;
}

async function fetchChannelById(id: string, apiKey: string) {
  const res = await fetch(
    `${YT_API}/channels?part=snippet,statistics,contentDetails&id=${encodeURIComponent(id)}&key=${apiKey}`
  );
  const data = await res.json();
  return data.items?.[0] ?? null;
}

async function fetchChannelByHandle(handle: string, apiKey: string) {
  const res = await fetch(
    `${YT_API}/channels?part=snippet,statistics,contentDetails&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`
  );
  const data = await res.json();
  return data.items?.[0] ?? null;
}

async function fetchChannelByUsername(username: string, apiKey: string) {
  const res = await fetch(
    `${YT_API}/channels?part=snippet,statistics,contentDetails&forUsername=${encodeURIComponent(username)}&key=${apiKey}`
  );
  const data = await res.json();
  return data.items?.[0] ?? null;
}

async function fetchVideoStats(videoIds: string[], apiKey: string): Promise<TopVideo[]> {
  const statsRes = await fetch(
    `${YT_API}/videos?part=snippet,statistics,contentDetails&id=${videoIds.join(",")}&key=${apiKey}`
  );
  const statsData = await statsRes.json();
  return (statsData.items ?? []).map(
    (item: {
      id: string;
      snippet: { title: string };
      statistics: { viewCount: string };
      contentDetails: { duration: string };
    }) => ({
      videoId: item.id,
      title: item.snippet.title,
      viewCount: parseInt(item.statistics.viewCount ?? "0", 10),
      duration: item.contentDetails.duration,
    })
  );
}

async function getTopVideos(channelId: string, uploadsPlaylistId: string, apiKey: string, limit = 50): Promise<TopVideo[]> {
  // Derive fallback playlist ID from channel ID (UC... → UU...)
  const derivedPlaylistId = channelId.startsWith("UC") ? "UU" + channelId.slice(2) : "";
  const playlistIds = [...new Set([uploadsPlaylistId, derivedPlaylistId].filter(Boolean))];

  for (const playlistId of playlistIds) {
    const playlistRes = await fetch(
      `${YT_API}/playlistItems?part=contentDetails&playlistId=${playlistId}&maxResults=${limit}&key=${apiKey}`
    );
    const playlistData = await playlistRes.json();
    if (playlistData.error) continue;

    const videoIds: string[] = (playlistData.items ?? []).map(
      (item: { contentDetails: { videoId: string } }) => item.contentDetails.videoId
    );
    if (!videoIds.length) continue;

    const videos = await fetchVideoStats(videoIds, apiKey);
    return videos.sort((a, b) => b.viewCount - a.viewCount).slice(0, 5);
  }

  throw new Error("Could not fetch videos for this channel.");
}

export async function resolveChannel(channelUrl: string, userId: string): Promise<ChannelInfo> {
  const { youtube_api_key: apiKey } = await getSettings(userId);
  if (!apiKey) throw new Error("YouTube API key not configured. Add it in Settings.");

  const parsed = parseChannelUrl(channelUrl);
  if (!parsed) throw new Error("Could not parse channel URL");

  let channel: {
    id: string;
    snippet: { title: string; description: string; customUrl?: string };
    statistics: { subscriberCount: string };
    contentDetails: { relatedPlaylists: { uploads: string } };
  } | null = null;

  if (parsed.type === "id") {
    channel = await fetchChannelById(parsed.value, apiKey);
  } else if (parsed.type === "handle" || parsed.type === "custom") {
    channel = await fetchChannelByHandle(parsed.value, apiKey);
    if (!channel) channel = await fetchChannelByUsername(parsed.value, apiKey);
  } else if (parsed.type === "username") {
    channel = await fetchChannelByUsername(parsed.value, apiKey);
    if (!channel) channel = await fetchChannelByHandle(parsed.value, apiKey);
  }

  if (!channel) throw new Error("Channel not found. Check the URL and try again.");

  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads ?? "";
  const topVideos = await getTopVideos(channel.id, uploadsPlaylistId, apiKey);

  const subscriberCount = parseInt(channel.statistics.subscriberCount ?? "0", 10);
  const subscribers =
    subscriberCount >= 1_000_000
      ? `${(subscriberCount / 1_000_000).toFixed(1)}M`
      : subscriberCount >= 1_000
      ? `${(subscriberCount / 1_000).toFixed(0)}K`
      : String(subscriberCount);

  return {
    channelId: channel.id,
    channelName: channel.snippet.title,
    subscribers,
    description: channel.snippet.description,
    topVideos,
  };
}
