import { YoutubeTranscript } from "youtube-transcript";
import type { TranscriptResult } from "@/lib/types";

const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

const INNERTUBE_CLIENTS = [
  {
    clientName: "WEB",
    clientVersion: "2.20240220.00.00",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  },
  {
    clientName: "TVHTML5",
    clientVersion: "7.20240220.19.00",
    userAgent:
      "Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/538.1 (KHTML, like Gecko) SamsungBrowser/2.6 TV Safari/538.1",
  },
];

async function fetchTranscriptFallback(videoId: string): Promise<string> {
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const res = await fetch(INNERTUBE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": client.userAgent },
        body: JSON.stringify({
          context: { client: { clientName: client.clientName, clientVersion: client.clientVersion } },
          videoId,
        }),
      });
      if (!res.ok) continue;

      const data = await res.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!Array.isArray(tracks) || tracks.length === 0) continue;

      const track = tracks.find((t: { languageCode: string }) => t.languageCode === "en") ?? tracks[0];
      if (!track?.baseUrl) continue;

      const tRes = await fetch(`${track.baseUrl}&fmt=json3`, {
        headers: { "User-Agent": client.userAgent },
      });
      if (!tRes.ok) continue;

      const tData = await tRes.json();
      const events: Array<{ segs?: Array<{ utf8?: string }> }> = tData?.events ?? [];
      const text = events
        .filter((e) => e.segs)
        .flatMap((e) => (e.segs ?? []).map((s) => s.utf8 ?? ""))
        .join(" ")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 0) return text;
    } catch {
      continue;
    }
  }
  throw new Error("No captions available");
}

export async function fetchTranscripts(
  videos: { videoId: string; title: string }[]
): Promise<TranscriptResult[]> {
  const results: TranscriptResult[] = [];

  for (const video of videos) {
    let text = "";
    try {
      const segments = await YoutubeTranscript.fetchTranscript(video.videoId);
      text = segments
        .map((s) => s.text.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    } catch {
      try {
        text = await fetchTranscriptFallback(video.videoId);
      } catch {
        results.push({
          videoId: video.videoId,
          title: video.title,
          text: "",
          success: false,
          error: "No captions available for this video. Please paste the transcript manually.",
        });
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
    }

    results.push({ videoId: video.videoId, title: video.title, text, success: true });
    await new Promise((r) => setTimeout(r, 300));
  }

  return results;
}
