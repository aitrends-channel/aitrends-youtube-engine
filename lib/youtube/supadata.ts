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

// YouTube auto-captions sprinkle SFX markers like [Music], [Applause],
// (laughter) into the transcript text. They're not the creator's words —
// leaving them in teaches the analyzer that "drop a [Music] cue" is part
// of the channel's style, which then shows up verbatim in generated
// scripts. Strip the known set on the way in.
const CAPTION_CUE = /[\[(]\s*(?:music|applause|laughter|laughs?|laughing|cheering|cheers?|inaudible|unintelligible|crosstalk|silence|pause|sigh|sighs|gasp|gasps|cough|coughs|grunt|grunts|chuckle|chuckles|breathing|footsteps|noise|background\s+(?:music|noise|chatter)|music\s+playing|sound\s+effects?|sfx|♪[^\])]*|[^\])]*♪)\s*[\])][.,!?]?/gi;

export function stripCaptionCues(text: string): string {
  return text
    .replace(CAPTION_CUE, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,!?;:])/g, "$1")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractText(content: string | TranscriptChunk[]): string {
  const raw = typeof content === "string" ? content : content.map(c => c.text).join(" ");
  return stripCaptionCues(raw);
}

// How long a known-failure stays cached before we re-try Supadata.
// Successes never expire — captions don't change. Failures expire so
// videos that get captions added later eventually get picked up again.
const NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function getCached(videoIds: string[]): Promise<Map<string, SupadataTranscript>> {
  const { data } = await supabase
    .from("transcript_cache")
    .select("video_id, title, text, word_count, success, error_code, cached_at")
    .in("video_id", videoIds);

  const map = new Map<string, SupadataTranscript>();
  const cutoff = Date.now() - NEGATIVE_CACHE_TTL_MS;
  for (const row of data ?? []) {
    if (row.success) {
      const cleaned = stripCaptionCues(row.text ?? "");
      map.set(row.video_id, {
        videoId: row.video_id,
        title: row.title,
        text: cleaned,
        wordCount: cleaned ? cleaned.split(/\s+/).filter(Boolean).length : (row.word_count ?? 0),
        success: true,
      });
    } else {
      const cachedAtMs = row.cached_at ? new Date(row.cached_at).getTime() : 0;
      if (cachedAtMs >= cutoff) {
        map.set(row.video_id, {
          videoId: row.video_id,
          title: row.title,
          text: "",
          wordCount: 0,
          success: false,
          error: row.error_code ?? "No transcript available",
        });
      }
      // else: stale negative entry — treat as cache miss, fall through to refetch.
    }
  }
  return map;
}

async function writeCache(transcripts: SupadataTranscript[]): Promise<void> {
  const now = new Date().toISOString();
  const rows = transcripts.map(t => t.success
    ? {
        video_id: t.videoId,
        title: t.title,
        text: t.text,
        word_count: t.wordCount,
        success: true,
        error_code: null,
        cached_at: now,
      }
    : {
        video_id: t.videoId,
        title: t.title,
        text: null,
        word_count: null,
        success: false,
        error_code: t.error ?? "No transcript available",
        cached_at: now,
      });

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

  // Store fresh results — both successes and failures — so we don't
  // re-bill Supadata for the same caption-less videos on every analysis.
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
