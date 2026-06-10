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

export async function POST(_req: Request, { params }: { params: { projectId: string } }) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const projectId = params.projectId;

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
  const storagePath = `${userFolderFor(user)}/${projectId}/voiceover-preview-${hash}.mp3`;
  const cachedUrl = `${process.env.R2_PUBLIC_URL?.replace(/\/$/, "")}/${storagePath}`;

  // Cache hit: same beat URLs → same hash → file already in R2.
  if (await r2HeadExists(cachedUrl)) {
    console.log(`[voiceover-concat] project=${projectId} cache hit hash=${hash} (${urls.length} beats)`);
    return NextResponse.json({ url: cachedUrl, cached: true, beats: urls.length });
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `vo-concat-${projectId}-`));
  const audioPaths: string[] = [];
  try {
    // Download all beats in parallel — order is preserved by index, not
    // by completion time, so we can safely Promise.all here.
    await Promise.all(withAudio.map(async (b, i) => {
      const dest = path.join(tmpDir, `b${String(i).padStart(4, "0")}.mp3`);
      await downloadToFile(b.voiceover_url!, dest);
      audioPaths[i] = dest;
    }));

    const listPath = path.join(tmpDir, "concat.txt");
    await fs.writeFile(
      listPath,
      audioPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
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
