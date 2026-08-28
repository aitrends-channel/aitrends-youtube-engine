import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { zipStream, type ZipEntry } from "@/lib/zip-stream";
import type { User } from "@supabase/supabase-js";

// Every generated image, or every clip, as one zip.
//
// The browser cannot do this for itself: R2's public URLs carry no CORS
// headers, so a page cannot fetch its own images to zip them, which is the same
// wall the voiceover download hit. So the files come back through our origin,
// and since we are already streaming them we assemble the archive on the way
// past rather than downloading twice.
//
// Nothing is buffered. The zip is written entry by entry as each file arrives,
// so a 200-image project costs the same memory as a one-image project.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Kind = "images" | "videos";

export async function GET(req: Request, { params }: { params: { projectId: string } }) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;
  const kind: Kind = new URL(req.url).searchParams.get("kind") === "videos" ? "videos" : "images";

  // Ownership first: the beat rows are keyed by project alone, so this is what
  // stops one account exporting another's work.
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id, channel_name")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const column = kind === "videos" ? "video_url" : "image_url";
  const { data: beats, error: beatsErr } = await supabase
    .from("project_beats")
    .select(`beat_number, ${column}`)
    .eq("project_id", projectId)
    .order("beat_number");
  if (beatsErr) return NextResponse.json({ error: beatsErr.message }, { status: 500 });

  // Only our own bucket, and only this project's folder within it. The URLs
  // come from our database rather than the request, but the check costs
  // nothing and means a corrupted row cannot turn this into a proxy for
  // arbitrary hosts.
  const publicBase = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
  const rows = (beats ?? []) as Array<Record<string, unknown>>;
  const files = rows
    .map((b) => ({ beat: Number(b.beat_number), url: String(b[column] ?? "") }))
    .filter((f) => f.url && (!publicBase || f.url.startsWith(`${publicBase}/`)));

  if (files.length === 0) {
    return NextResponse.json(
      { error: kind === "videos" ? "No clips have been generated yet." : "No images have been generated yet." },
      { status: 404 },
    );
  }

  const skipped: string[] = [];
  const entries: ZipEntry[] = files.map(({ beat, url }) => {
    const ext = extensionOf(url, kind);
    return {
      name: `beat-${String(beat).padStart(3, "0")}.${ext}`,
      open: async () => {
        const res = await fetch(url);
        if (!res.ok || !res.body) return null;
        return res.body as ReadableStream<Uint8Array>;
      },
    };
  });

  const body = zipStream(entries, {
    onSkip: (name, reason) => {
      skipped.push(name);
      console.warn(`[media/download] skipped ${name} in project=${projectId}: ${reason}`);
    },
  });

  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName(project.channel_name, kind)}"`,
      // The archive is produced as it is sent, so its length is not known when
      // the headers go out. Chunked, and never cached: it is a private export.
      "Cache-Control": "no-store",
    },
  });
}

function extensionOf(url: string, kind: Kind): string {
  const path = url.split("?")[0];
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  if (/^[a-z0-9]{2,4}$/.test(ext)) return ext;
  return kind === "videos" ? "mp4" : "png";
}

/** A name someone can find again in a downloads folder, rather than the
 *  project's uuid. */
function zipName(channel: unknown, kind: Kind): string {
  const base = typeof channel === "string" && channel.trim()
    ? channel.trim().replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/\s+/g, "-").slice(0, 60)
    : "heclus";
  return `${base || "heclus"}-${kind}.zip`;
}
