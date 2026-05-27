import { Supadata, SupadataError } from "@supadata/js";
import type { YoutubeBatchResults, TranscriptChunk } from "@supadata/js";
import { supabase } from "@/lib/supabase/client";

export interface SupadataTranscript {
  videoId: string;
  title: string;
  text: string;
  wordCount: number;
  success: boolean;
  error?: string;
}

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
    if (res.status === "failed") throw new Error("Transcript batch job failed");
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Transcript batch job timed out");
}

function extractText(content: string | TranscriptChunk[]): string {
  if (typeof content === "string") return content;
  return content.map(c => c.text).join(" ");
}

async function getCached(videoIds: string[]): Promise<Map<string, SupadataTranscript>> {
  const { data } = await supabase
    .from("transcript_cache")
    .select("video_id, title, text, word_count")
    .in("video_id", videoIds);

  const map = new Map<string, SupadataTranscript>();
  for (const row of data ?? []) {
    map.set(row.video_id, {
      videoId: row.video_id,
      title: row.title,
      text: row.text,
      wordCount: row.word_count,
      success: true,
    });
  }
  return map;
}

async function writeCache(transcripts: SupadataTranscript[]): Promise<void> {
  const rows = transcripts
    .filter(t => t.success && t.text.length > 0)
    .map(t => ({
      video_id: t.videoId,
      title: t.title,
      text: t.text,
      word_count: t.wordCount,
    }));

  if (rows.length > 0) {
    await supabase.from("transcript_cache").upsert(rows, { onConflict: "video_id" });
  }
}

export async function fetchTranscriptsViaSupadata(
  videos: { videoId: string; title: string }[]
): Promise<SupadataTranscript[]> {
  const videoIds = videos.map(v => v.videoId);
  const titleMap = Object.fromEntries(videos.map(v => [v.videoId, v.title]));

  // Check cache first
  const cached = await getCached(videoIds);
  const uncachedVideos = videos.filter(v => !cached.has(v.videoId));

  // All hits — no Supadata call needed
  if (uncachedVideos.length === 0) {
    return videoIds.map(id => cached.get(id)!);
  }

  // Fetch only uncached videos from Supadata
  const client = getClient();
  let fresh: SupadataTranscript[] = [];

  try {
    const batchJob = await client.youtube.transcript.batch({
      videoIds: uncachedVideos.map(v => v.videoId),
    });
    const batchResults = await pollBatch(client, batchJob.jobId);

    fresh = (batchResults.results ?? []).map(r => {
      const title = titleMap[r.videoId] ?? r.videoId;
      if (!r.transcript || r.errorCode) {
        return { videoId: r.videoId, title, text: "", wordCount: 0, success: false, error: r.errorCode ?? "No transcript available" };
      }
      const text = extractText(r.transcript.content).trim();
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      return { videoId: r.videoId, title, text, wordCount, success: true };
    });
  } catch (err) {
    if (err instanceof SupadataError && err.error === "limit-exceeded") {
      throw new Error("API quota exceeded. Please try again later or upgrade your Supadata plan.");
    }
    throw err;
  }

  // Store successful fetches in cache
  await writeCache(fresh);

  // Merge cached + fresh, preserving original order
  const freshMap = new Map(fresh.map(t => [t.videoId, t]));
  return videoIds.map(id => cached.get(id) ?? freshMap.get(id) ?? {
    videoId: id,
    title: titleMap[id] ?? id,
    text: "",
    wordCount: 0,
    success: false,
    error: "No transcript available",
  });
}
