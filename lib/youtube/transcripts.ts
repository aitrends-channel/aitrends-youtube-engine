import type { TranscriptResult } from "@/lib/types";

const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const FETCH_DELAY_MS = 600;

const CLIENTS = [
  {
    name: "WEB",
    version: "2.20240726.00.00",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  },
  {
    name: "ANDROID",
    version: "20.10.38",
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
  },
  {
    name: "TVHTML5",
    version: "7.20230405.08.00",
    ua: "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1",
  },
] as const;

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function parseTranscriptXml(xml: string): string {
  const segments: string[] = [];

  // srv3 format: <p t="ms" d="ms"><s>word</s>...</p>
  const pMatches = [...xml.matchAll(/<p\s+t="\d+"\s+d="\d+"[^>]*>([\s\S]*?)<\/p>/g)];
  if (pMatches.length > 0) {
    for (const m of pMatches) {
      const sTexts = [...m[1].matchAll(/<s[^>]*>([^<]*)<\/s>/g)].map((s) => s[1]);
      const text = decodeEntities(
        sTexts.length ? sTexts.join("") : m[1].replace(/<[^>]+>/g, "")
      ).trim();
      if (text) segments.push(text);
    }
    return segments.join(" ").replace(/\s+/g, " ").trim();
  }

  // Classic format: <text start="s" dur="s">content</text>
  for (const m of xml.matchAll(/<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g)) {
    const text = decodeEntities(m[3]).trim();
    if (text) segments.push(text);
  }
  return segments.join(" ").replace(/\s+/g, " ").trim();
}

async function tryClient(
  videoId: string,
  clientName: string,
  clientVersion: string,
  userAgent: string
): Promise<string | null> {
  try {
    const playerResp = await fetch(INNERTUBE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": userAgent,
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: JSON.stringify({
        context: { client: { clientName, clientVersion, hl: "en" } },
        videoId,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!playerResp.ok) return null;

    const data = await playerResp.json();
    const captionTracks: Array<{ languageCode: string; baseUrl: string }> =
      data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (!captionTracks.length) return null;

    const track =
      captionTracks.find((t) => t.languageCode === "en") ?? captionTracks[0];

    let captionUrl: URL;
    try {
      captionUrl = new URL(track.baseUrl);
    } catch {
      return null;
    }
    if (!captionUrl.hostname.endsWith(".youtube.com")) return null;

    const xmlResp = await fetch(captionUrl.toString(), {
      headers: { "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!xmlResp.ok) return null;
    return await xmlResp.text();
  } catch {
    return null;
  }
}

async function fetchSingleTranscript(videoId: string): Promise<string> {
  for (const client of CLIENTS) {
    const xml = await tryClient(videoId, client.name, client.version, client.ua);
    if (xml) {
      const text = parseTranscriptXml(xml);
      if (text) return text;
    }
  }
  throw new Error("No transcript could be retrieved for this video");
}

export async function fetchTranscripts(
  videos: { videoId: string; title: string }[]
): Promise<TranscriptResult[]> {
  const results: TranscriptResult[] = [];

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    if (i > 0) await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));

    try {
      const text = await fetchSingleTranscript(video.videoId);
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
