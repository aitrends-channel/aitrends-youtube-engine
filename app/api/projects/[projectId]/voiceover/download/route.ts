import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";

// Same-origin download proxy for the concatenated voiceover MP3.
//
// The browser can't fetch the R2 public URL directly (cross-origin, no
// CORS headers) — that's the "Failed to fetch" the export button hit. It
// also can't force a download from a cross-origin URL via the `download`
// attribute. So we stream the file back through our own origin with a
// Content-Disposition attachment header: no CORS, and it saves as a file
// instead of playing inline.
//
// SSRF guard: we only proxy objects on our own R2 bucket that live under
// THIS project's path, so the `url` param can't be pointed at arbitrary
// hosts or other projects' files.

export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: { projectId: string } }) {
  try { await getRequiredUser(); } catch (e) { return e as Response; }

  const projectId = params.projectId;
  const fileUrl = new URL(req.url).searchParams.get("url") ?? "";
  const publicBase = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");

  if (!publicBase || !fileUrl.startsWith(`${publicBase}/`) || !fileUrl.includes(`/${projectId}/`)) {
    return NextResponse.json({ error: "Invalid file URL" }, { status: 400 });
  }

  const upstream = await fetch(fileUrl);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "Could not fetch the exported file" }, { status: 502 });
  }

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Disposition": 'attachment; filename="voiceover.mp3"',
      "Cache-Control": "no-store",
    },
  });
}
