import { YoutubeTranscript } from "youtube-transcript";
import { Innertube } from "youtubei.js";
import type { TranscriptResult } from "@/lib/types";

const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

// Clients ordered by reliability from datacenter IPs.
// Android/iOS clients bypass the poToken requirement that blocks WEB from servers.
interface InnertubeClient {
  clientName: string;
  clientVersion: string;
  userAgent: string;
  extraHeaders: Record<string, string>;
  extraContext: Record<string, unknown>;
}

const INNERTUBE_CLIENTS: InnertubeClient[] = [
  {
    clientName: "ANDROID",
    clientVersion: "19.44.38",
    userAgent: "com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip",
    extraHeaders: {
      "X-YouTube-Client-Name": "3",
      "X-YouTube-Client-Version": "19.44.38",
    },
    extraContext: { androidSdkVersion: 30, hl: "en", gl: "US" },
  },
  {
    clientName: "IOS",
    clientVersion: "19.45.4",
    userAgent: "com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)",
    extraHeaders: {
      "X-YouTube-Client-Name": "5",
      "X-YouTube-Client-Version": "19.45.4",
    },
    extraContext: { deviceModel: "iPhone16,2", hl: "en", gl: "US" },
  },
  {
    clientName: "TVHTML5",
    clientVersion: "7.20240220.19.00",
    userAgent: "Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/538.1 (KHTML, like Gecko) SamsungBrowser/2.6 TV Safari/538.1",
    extraHeaders: {},
    extraContext: {},
  },
  {
    clientName: "WEB",
    clientVersion: "2.20240220.00.00",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    extraHeaders: {},
    extraContext: {},
  },
];

async function fetchTranscriptFallback(videoId: string): Promise<string> {
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const res = await fetch(INNERTUBE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": client.userAgent,
          "Referer": "https://www.youtube.com/",
          "Origin": "https://www.youtube.com",
          "Accept-Language": "en-US,en;q=0.9",
          ...client.extraHeaders,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: client.clientName,
              clientVersion: client.clientVersion,
              userAgent: client.userAgent,
              ...client.extraContext,
            },
          },
          videoId,
        }),
      });

      if (!res.ok) {
        console.warn(`[transcript] ${client.clientName} player request failed: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const playability = data?.playabilityStatus?.status;
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

      if (!Array.isArray(tracks) || tracks.length === 0) {
        console.warn(`[transcript] ${client.clientName} no caption tracks (playability=${playability}, hasCaptions=${!!data?.captions})`);
        continue;
      }

      const track = tracks.find((t: { languageCode: string }) => t.languageCode === "en") ?? tracks[0];
      if (!track?.baseUrl) continue;

      const tRes = await fetch(`${track.baseUrl}&fmt=json3`, {
        headers: {
          "User-Agent": client.userAgent,
          "Referer": "https://www.youtube.com/",
        },
      });
      if (!tRes.ok) {
        console.warn(`[transcript] ${client.clientName} caption fetch failed: HTTP ${tRes.status}`);
        continue;
      }

      const tData = await tRes.json();
      const events: Array<{ segs?: Array<{ utf8?: string }> }> = tData?.events ?? [];
      const text = events
        .filter((e) => e.segs)
        .flatMap((e) => (e.segs ?? []).map((s) => s.utf8 ?? ""))
        .join(" ")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 0) {
        console.log(`[transcript] ${client.clientName} succeeded for ${videoId}`);
        return text;
      }
      console.warn(`[transcript] ${client.clientName} returned empty text`);
    } catch (err) {
      console.warn(`[transcript] ${client.clientName} threw: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }
  throw new Error("No captions available");
}



async function fetchTranscriptYoutubeJs(videoId: string): Promise<string> {
  const yt = await Innertube.create({ generate_session_locally: true });
  const info = await yt.getInfo(videoId);
  const transcriptInfo = await info.getTranscript();
  const segments = transcriptInfo.transcript.content?.body?.initial_segments ?? [];
  const text = segments
    .filter((s): s is typeof s & { snippet: { toString(): string } } => "snippet" in s)
    .map((s) => s.snippet.toString())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) throw new Error("No transcript text returned");
  return text;
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
    } catch (primaryErr) {
      console.warn(`[transcript] youtube-transcript library failed for ${video.videoId}: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}`);
      try {
        text = await fetchTranscriptFallback(video.videoId);
      } catch {
        try {
          text = await fetchTranscriptYoutubeJs(video.videoId);
          console.log(`[transcript] youtubei.js succeeded for ${video.videoId}`);
        } catch (ytjsErr) {
          console.warn(`[transcript] youtubei.js failed for ${video.videoId}: ${ytjsErr instanceof Error ? ytjsErr.message : String(ytjsErr)}`);
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
    }

    results.push({ videoId: video.videoId, title: video.title, text, success: true });
    await new Promise((r) => setTimeout(r, 300));
  }

  return results;
}
