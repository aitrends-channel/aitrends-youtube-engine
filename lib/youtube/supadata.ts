export interface SupadataTranscript {
  videoId: string;
  title: string;
  text: string;
  wordCount: number;
  success: boolean;
  error?: string;
}

const SUPADATA_BASE = "https://api.supadata.ai/v1";
const MAX_WORDS_PER_TRANSCRIPT = 1500;

export async function fetchTranscriptsViaSupadata(
  videos: { videoId: string; title: string }[]
): Promise<SupadataTranscript[]> {
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) throw new Error("SUPADATA_API_KEY is not configured");

  return Promise.all(
    videos.map(async (video): Promise<SupadataTranscript> => {
      try {
        const res = await fetch(
          `${SUPADATA_BASE}/youtube/transcript?videoId=${encodeURIComponent(video.videoId)}`,
          { headers: { "x-api-key": apiKey } }
        );

        if (!res.ok) {
          return { videoId: video.videoId, title: video.title, text: "", wordCount: 0, success: false, error: `HTTP ${res.status}` };
        }

        const data = await res.json();

        const rawText =
          typeof data.content === "string"
            ? data.content
            : Array.isArray(data.content)
            ? data.content.map((s: { text: string }) => s.text).join(" ")
            : "";

        const words = rawText.trim().split(/\s+/).filter(Boolean);
        const truncated = words.slice(0, MAX_WORDS_PER_TRANSCRIPT).join(" ");

        return {
          videoId: video.videoId,
          title: video.title,
          text: truncated,
          wordCount: words.length,
          success: true,
        };
      } catch (err) {
        return {
          videoId: video.videoId,
          title: video.title,
          text: "",
          wordCount: 0,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    })
  );
}
