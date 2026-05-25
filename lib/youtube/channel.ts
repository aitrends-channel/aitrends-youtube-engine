import { Supadata, SupadataError } from "@supadata/js";
import type { YoutubeBatchResults } from "@supadata/js";
import type { ChannelInfo, TopVideo } from "@/lib/types";

function getClient(): Supadata {
  const key = process.env.SUPADATA_API_KEY;
  if (!key) throw new Error("SUPADATA_API_KEY is not configured");
  return new Supadata({ apiKey: key });
}

async function pollBatch(client: Supadata, jobId: string): Promise<YoutubeBatchResults> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await client.youtube.batch.getBatchResults(jobId);
    if (res.status === "completed") return res;
    if (res.status === "failed") throw new Error("Batch job failed");
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Batch job timed out");
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
  const client = getClient();

  try {
    // 1 call: channel info
    const channel = await client.youtube.channel({ id: channelUrl });

    // 1 call: 5 most recent video IDs
    const { videoIds = [] } = await client.youtube.channel.videos({
      id: channel.id,
      type: "video",
      limit: 5,
    });

    if (!videoIds.length) {
      return {
        channelId: channel.id,
        channelName: channel.name,
        subscribers: formatSubscribers(channel.subscriberCount),
        description: channel.description,
        topVideos: [],
      };
    }

    // 1 batch job: all 5 video details
    const batchJob = await client.youtube.video.batch({ videoIds });
    const batchResults = await pollBatch(client, batchJob.jobId);

    const topVideos: TopVideo[] = (batchResults.results ?? [])
      .filter(r => r.video != null)
      .map(r => ({
        videoId: r.videoId,
        title: r.video!.title,
        viewCount: r.video!.viewCount,
        duration: secondsToISO(r.video!.duration),
      }));

    return {
      channelId: channel.id,
      channelName: channel.name,
      subscribers: formatSubscribers(channel.subscriberCount),
      description: channel.description,
      topVideos,
    };
  } catch (err) {
    if (err instanceof SupadataError && err.error === "limit-exceeded") {
      throw new Error("API quota exceeded. Please try again later or upgrade your Supadata plan.");
    }
    throw err;
  }
}
