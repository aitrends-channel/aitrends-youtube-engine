import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { promises as fs, createWriteStream } from "fs";
import path from "path";
import os from "os";
import { Readable } from "stream";
import { ReadableStream as NodeReadableStream } from "stream/web";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { uploadBuffer, userFolderFor } from "@/lib/supabase/storage";
import type { User } from "@supabase/supabase-js";

// fluent-ffmpeg + ffmpeg-static loaded via createRequire so the ESM
// Next.js bundle doesn't try to statically analyze the binary path.
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const ffmpeg = _require("fluent-ffmpeg") as typeof import("fluent-ffmpeg");
const ffmpegPath = _require("ffmpeg-static") as string | null;
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

export const maxDuration = 300;

// Server-side ffmpeg concat of every beat's voiceover into a single
// MP3, uploaded back to R2 for the preview to play as one URL. Mirrors
// what the assembler does in video-worker/src/routes/assemble.ts:692
// for the final video's audio track, so the preview sound is exactly
// what the user will get at assemble time — no swap latency between
// beats, no client-side decode delay.
//
// Caching: the storage path includes a hash of the ordered beat URLs.
// If a preview MP3 already exists at that path (R2 HEAD success), we
// short-circuit and return its URL — re-runs are O(1) until the
// underlying beat set changes.

interface BeatRow { beat_number: number; voiceover_url: string | null }

function hashUrls(urls: string[]): string {
  return createHash("sha1").update(urls.join("\n")).digest("hex").slice(0, 16);
}

async function r2HeadExists(publicUrl: string): Promise<boolean> {
  try {
    const res = await fetch(publicUrl, { method: "HEAD", cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const nodeStream = Readable.fromWeb(res.body as NodeReadableStream);
  const fileStream = createWriteStream(dest);
  await new Promise<void>((resolve, reject) => {
    nodeStream.pipe(fileStream).on("finish", () => resolve()).on("error", reject);
  });
}

// Retry wrapper — undici's "fetch failed" (transport-layer error) is
// almost always transient: DNS hiccup, socket reset, connection-pool
// exhaustion when many parallel downloads burst. Two quick retries
// clear the vast majority of cases. HTTP-status failures
// (`HTTP 4xx/5xx`) are not retried — those won't change on retry.
async function downloadToFileWithRetry(url: string, dest: string): Promise<void> {
  const delays = [500, 1500];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await downloadToFile(url, dest);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg);
      if (!transient || attempt === delays.length) throw e;
      console.warn(`[voiceover-concat] download attempt ${attempt + 1} failed (${msg}); retrying in ${delays[attempt]}ms`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

// Bounded parallelism — run `tasks` with at most `limit` in flight.
// Avoids the burst-of-30-parallel-fetches pattern that exhausts
// undici's connection pool and surfaces as "fetch failed".
async function runWithLimit<T>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

function concatWithFfmpeg(listFile: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile).inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c", "copy"])
      .output(outFile)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

// Trim leading + trailing silence from a single mp3, mirrors the
// worker's trimSilence helper. Re-encodes to libmp3lame 128k 44.1kHz
// so every trimmed file shares codec — downstream concat -c copy works.
function trimSilenceOne(inFile: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inFile)
      .audioFilters([
        "silenceremove=start_periods=1:start_silence=0:start_threshold=-50dB:detection=peak",
        "aformat=dblp",
        "areverse",
        "silenceremove=start_periods=1:start_silence=0:start_threshold=-50dB:detection=peak",
        "aformat=dblp",
        "areverse",
      ])
      .outputOptions(["-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100"])
      .output(outFile)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

export async function POST(req: Request, { params }: { params: { projectId: string } }) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const projectId = params.projectId;

  // Body is optional — older callers POST with no body. trimSilence
  // defaults to false so the original concat behavior is preserved.
  const body = await req.json().catch(() => ({})) as { trimSilence?: boolean };
  const trimSilence = !!body.trimSilence;

  // Ownership check.
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id, user_id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .single();
  if (projErr || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { data: rawBeats, error: beatsErr } = await supabase
    .from("project_beats")
    .select("beat_number, voiceover_url")
    .eq("project_id", projectId)
    .order("beat_number");
  if (beatsErr) {
    return NextResponse.json({ error: `Failed to load beats: ${beatsErr.message}` }, { status: 500 });
  }
  const beats = (rawBeats ?? []) as BeatRow[];
  const withAudio = beats.filter((b) => !!b.voiceover_url);
  if (withAudio.length === 0) {
    return NextResponse.json({ error: "No beat voiceovers to concatenate yet" }, { status: 409 });
  }

  const urls = withAudio.map((b) => b.voiceover_url!);
  const hash = hashUrls(urls);
  // The cache key includes the trim flag so original + trimmed
  // previews don't overwrite each other — both versions can live on
  // R2 side-by-side and the assemble page A/B preview can pull them
  // independently.
  const variant = trimSilence ? "trim" : "orig";
  const storagePath = `${userFolderFor(user)}/${projectId}/voiceover-preview-${hash}-${variant}.mp3`;
  const cachedUrl = `${process.env.R2_PUBLIC_URL?.replace(/\/$/, "")}/${storagePath}`;

  // Cache hit: same beat URLs + variant → same hash → file already in R2.
  if (await r2HeadExists(cachedUrl)) {
    console.log(`[voiceover-concat] project=${projectId} cache hit hash=${hash} variant=${variant} (${urls.length} beats)`);
    return NextResponse.json({ url: cachedUrl, cached: true, beats: urls.length, trimSilence });
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `vo-concat-${projectId}-`));
  const audioPaths: string[] = [];
  try {
    // Download all beats in parallel, capped at 6 concurrent. Order is
    // preserved by writing to audioPaths[i] (index, not completion).
    // Unbounded Promise.all here used to open one socket per beat at
    // once — 30+ simultaneous HTTPS fetches reliably tripped undici's
    // "fetch failed" under any network blip. 6 stays well under the
    // pool limit while keeping wall-clock essentially the same on
    // typical script sizes.
    await runWithLimit(withAudio, 6, async (b, i) => {
      const dest = path.join(tmpDir, `b${String(i).padStart(4, "0")}.mp3`);
      await downloadToFileWithRetry(b.voiceover_url!, dest);
      audioPaths[i] = dest;
    });

    // Optional silence-trim pass per beat. Runs in parallel for speed;
    // every output uses the same codec/sample rate (mp3 128k 44.1kHz)
    // so the downstream concat -c copy is still valid.
    const concatPaths = trimSilence
      ? await Promise.all(audioPaths.map(async (src, i) => {
          const dest = path.join(tmpDir, `t${String(i).padStart(4, "0")}.mp3`);
          await trimSilenceOne(src, dest);
          return dest;
        }))
      : audioPaths;

    const listPath = path.join(tmpDir, "concat.txt");
    await fs.writeFile(
      listPath,
      concatPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
    );
    const outPath = path.join(tmpDir, "preview.mp3");
    await concatWithFfmpeg(listPath, outPath);

    const buf = await fs.readFile(outPath);
    // Node's fs.readFile returns Buffer (NonSharedBuffer); uploadBuffer
    // expects ArrayBuffer. Slice into an ArrayBuffer view of the same
    // bytes so we don't double-allocate the file.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const publicUrl = await uploadBuffer(storagePath, ab, "audio/mpeg");
    console.log(`[voiceover-concat] project=${projectId} built hash=${hash} (${urls.length} beats, ${buf.byteLength} bytes)`);
    return NextResponse.json({ url: publicUrl, cached: false, beats: urls.length });
  } catch (e) {
    console.error(`[voiceover-concat] project=${projectId} failed:`, e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Concat failed" },
      { status: 500 },
    );
  } finally {
    // Clean up tmp files — best-effort, don't care if it fails.
    void fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
