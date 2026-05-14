import { YoutubeTranscript } from "youtube-transcript";
import type { TranscriptResult } from "@/lib/types";

const FETCH_DELAY_MS = 600;

export async function fetchTranscripts(
  videos: { videoId: string; title: string }[]
): Promise<TranscriptResult[]> {
  const results: TranscriptResult[] = [];

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    if (i > 0) await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));

    try {
      const segments = await YoutubeTranscript.fetchTranscript(video.videoId);
      const text = segments
        .map((s) => s.text.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      results.push({ videoId: video.videoId, title: video.title, text, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch transcript";
      results.push({
        videoId: video.videoId,
        title: video.title,
        text: "",
        success: false,
        error: message,
      });
    }
  }

  return results;
}
