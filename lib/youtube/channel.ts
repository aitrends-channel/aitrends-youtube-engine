import type { ChannelInfo, TopVideo } from "@/lib/types";

const SUPADATA_BASE = "https://api.supadata.ai/v1";

function getApiKey(): string {
  const key = process.env.SUPADATA_API_KEY;
  if (!key) throw new Error("SUPADATA_API_KEY is not configured");
  return key;
}

async function supadataGet<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPADATA_BASE}${path}`, {
    headers: { "x-api-key": getApiKey() },
  });
  if (!res.ok) throw new Error(`Supadata request failed: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function secondsToISO(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `PT${m}M${s}S`;
}

function formatSubscribers(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}

export async function resolveChannel(channelUrl: string): Promise<ChannelInfo> {
  const channel = await supadataGet<{
    id: string;
    name: string;
    description: string;
    subscriberCount: number;
  }>(`/youtube/channel?id=${encodeURIComponent(channelUrl)}`);

  const { video_ids } = await supadataGet<{
    video_ids: string[];
    short_ids: string[];
    live_ids: string[];
  }>(`/youtube/channel/videos?id=${encodeURIComponent(channel.id)}&type=video&limit=10`);

  const videoDetails = await Promise.all(
    video_ids.slice(0, 10).map(async (id): Promise<TopVideo | null> => {
      try {
        const v = await supadataGet<{ id: string; title: string; viewCount: number; duration: number }>(
          `/youtube/video?id=${encodeURIComponent(id)}`
        );
        return { videoId: v.id, title: v.title, viewCount: v.viewCount, duration: secondsToISO(v.duration) };
      } catch {
        return null;
      }
    })
  );

  const topVideos = videoDetails
    .filter((v): v is TopVideo => v !== null)
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, 5);

  return {
    channelId: channel.id,
    channelName: channel.name,
    subscribers: formatSubscribers(channel.subscriberCount),
    description: channel.description,
    topVideos,
  };
}
