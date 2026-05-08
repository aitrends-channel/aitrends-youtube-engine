import { YoutubeTranscript } from "youtube-transcript";
import type { TranscriptResult } from "@/lib/types";

export async function fetchTranscripts(
  videos: { videoId: string; title: string }[]
): Promise<TranscriptResult[]> {
  const results = await Promise.allSettled(
    videos.map(async (video): Promise<TranscriptResult> => {
      const segments = await YoutubeTranscript.fetchTranscript(video.videoId);
      const text = segments
        .map((s) => s.text.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      return { videoId: video.videoId, title: video.title, text, success: true };
    })
  );

  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    return {
      videoId: videos[i].videoId,
      title: videos[i].title,
      text: "",
      success: false,
      error: "No captions available for this video. Please paste the transcript manually.",
    };
  });
}
