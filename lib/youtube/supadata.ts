import { Supadata, SupadataError } from "@supadata/js";
import type { YoutubeBatchResults, TranscriptChunk } from "@supadata/js";
import { supabase } from "@/lib/supabase/client";
import { getActiveProductKey } from "@/lib/claude/routing";

export interface SupadataTranscript {
  videoId: string;
  title: string;
  text: string;
  wordCount: number;
  success: boolean;
  error?: string;
}

async function getClient(): Promise<Supadata> {
  // Admin-managed key in product_config is the source of truth; env var
  // is a fallback for local dev / pre-DB setups (mirrors the admin
  // supadata-status route).
  const dbKey = await getActiveProductKey("supadata_api_key");
  const key = dbKey || process.env.SUPADATA_API_KEY;
  if (!key) throw new Error("SUPADATA_API_KEY is not configured");
  return new Supadata({ apiKey: key });
}

// Format a useful diagnostic from a failed YoutubeBatchResults so the
// thrown Error carries upstream stats + a sample of per-item errorCodes
// instead of the previous opaque "Transcript batch job failed". Without
// this the route's 500 body told us nothing about why the batch failed.
function describeBatchFailure(res: YoutubeBatchResults): string {
  const stats = res.stats ? `${res.stats.failed}/${res.stats.total} failed, ${res.stats.succeeded} succeeded` : "stats unavailable";
  const errors = (res.results ?? [])
    .filter(r => r.errorCode)
    .slice(0, 5)
    .map(r => `${r.videoId}=${r.errorCode}`);
  const sample = errors.length > 0 ? ` — sample: ${errors.join(", ")}` : "";
  return `Transcript batch job failed (${stats})${sample}`;
}

async function pollBatch(client: Supadata, jobId: string): Promise<YoutubeBatchResults> {
  // 280s sits ~20s under the transcripts route's maxDuration=300s so
  // this throws a clean "timed out" error before Vercel hard-kills the
  // function. Previously both were 60s, so Vercel always won the race
  // and the client saw FUNCTION_INVOCATION_TIMEOUT (plain text, not
  // JSON, which broke the error-mapper).
  const deadline = Date.now() + 280_000;
  const startedAt = Date.now();
  // Track each distinct status seen so on timeout we know whether the
  // job was queued the whole time (worker never picked it up) vs
  // active (working but slow). Two very different problems.
  const statusCounts: Record<string, number> = {};
  let lastStats: YoutubeBatchResults["stats"] | undefined;
  while (Date.now() < deadline) {
    const res = await client.youtube.batch.getBatchResults(jobId);
    statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
    if (res.stats) lastStats = res.stats;
    if (res.status === "completed") return res;
    if (res.status === "failed") {
      console.error("[supadata] batch failed:", { jobId, status: res.status, stats: res.stats, results: res.results });
      throw new Error(describeBatchFailure(res));
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  const elapsedS = Math.round((Date.now() - startedAt) / 1000);
  // Include status distribution + last seen stats so the timeout error
  // tells us whether the worker ever started on this batch.
  console.error("[supadata] batch timed out:", { jobId, elapsedS, statusCounts, lastStats });
  const statusSummary = Object.entries(statusCounts).map(([s, n]) => `${s}×${n}`).join(", ") || "no polls completed";
  const statsSummary = lastStats ? ` last stats: ${lastStats.succeeded}/${lastStats.total} done, ${lastStats.failed} failed` : "";
  throw new Error(`Transcript batch job timed out after ${elapsedS}s (jobId=${jobId}, polls=${statusSummary}${statsSummary})`);
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
  const client = await getClient();
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
    if (err instanceof SupadataError) {
      console.error("[supadata] SupadataError in batch flow:", {
        error: err.error,
        message: err.message,
        details: err.details,
        documentationUrl: err.documentationUrl,
      });
      if (err.error === "limit-exceeded") {
        throw new Error("API quota exceeded. Please try again later or upgrade your Supadata plan.");
      }
      // Surface the exact upstream code + message so the route's 500
      // body tells the caller what Supadata actually rejected.
      throw new Error(`Supadata ${err.error}: ${err.message || err.details || "no details"}`);
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
