import { Supadata, SupadataError } from "@supadata/js";
import type { YoutubeBatchResults, TranscriptChunk } from "@supadata/js";

export interface SupadataTranscript {
  videoId: string;
  title: string;
  text: string;
  wordCount: number;
  success: boolean;
  error?: string;
}

const MAX_WORDS_PER_TRANSCRIPT = 1500;

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

export async function fetchTranscriptsViaSupadata(
  videos: { videoId: string; title: string }[]
): Promise<SupadataTranscript[]> {
  const client = getClient();
  const titleMap = Object.fromEntries(videos.map(v => [v.videoId, v.title]));

  try {
    // 1 batch job: all transcripts
    const batchJob = await client.youtube.transcript.batch({
      videoIds: videos.map(v => v.videoId),
    });
    const batchResults = await pollBatch(client, batchJob.jobId);

    return (batchResults.results ?? []).map(r => {
      const title = titleMap[r.videoId] ?? r.videoId;
      if (!r.transcript || r.errorCode) {
        return { videoId: r.videoId, title, text: "", wordCount: 0, success: false, error: r.errorCode ?? "No transcript available" };
      }
      const rawText = extractText(r.transcript.content);
      const words = rawText.trim().split(/\s+/).filter(Boolean);
      const truncated = words.slice(0, MAX_WORDS_PER_TRANSCRIPT).join(" ");
      return { videoId: r.videoId, title, text: truncated, wordCount: words.length, success: true };
    });
  } catch (err) {
    if (err instanceof SupadataError && err.error === "limit-exceeded") {
      throw new Error("API quota exceeded. Please try again later or upgrade your Supadata plan.");
    }
    throw err;
  }
}
