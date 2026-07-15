import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { r2KeyFromUrl, createPresignedDownload } from "@/lib/supabase/storage";

// Direct-download redirect for the assembled video. The Export button
// used to link the R2 public URL with a `download` attribute — which
// browsers ignore cross-origin, so the video opened inline in the tab
// instead of saving. This route 302s to a short-lived signed URL with
// Content-Disposition: attachment, so the browser downloads the file
// straight from storage (nothing streams through us).
//
// Two backends: current assemblies live on R2 (presigned S3 GET);
// pre-migration rows still point at Supabase Storage public URLs
// (signed via storage.createSignedUrl's download option).
//
// SSRF guard mirrors the voiceover download proxy: only objects under
// THIS project's path on our own storage can be signed.

export const dynamic = "force-dynamic";

const SUPA_PUBLIC_MARKER = "/storage/v1/object/public/";

export async function GET(req: Request, { params }: { params: { projectId: string } }) {
  try { await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;
  const url = new URL(req.url);
  const fileUrl = url.searchParams.get("url") ?? "";
  const filename = url.searchParams.get("filename") ?? "assembled.mp4";

  try {
    // Current path: object on our R2 bucket.
    const key = r2KeyFromUrl(fileUrl);
    if (key && key.includes(`/${projectId}/`)) {
      const signed = await createPresignedDownload(key, filename);
      return NextResponse.redirect(signed, 302);
    }

    // Legacy path: Supabase Storage public URL from before the R2
    // migration ("…/storage/v1/object/public/<bucket>/<path>").
    const supaBase = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
    if (supaBase && fileUrl.startsWith(`${supaBase}${SUPA_PUBLIC_MARKER}`)) {
      const rest = fileUrl.slice(`${supaBase}${SUPA_PUBLIC_MARKER}`.length);
      const slash = rest.indexOf("/");
      const bucket = rest.slice(0, slash);
      const path = decodeURIComponent(rest.slice(slash + 1));
      if (bucket && path.includes(`${projectId}/`)) {
        const { data, error } = await supabase.storage
          .from(bucket)
          .createSignedUrl(path, 600, { download: filename });
        if (error || !data?.signedUrl) throw new Error(error?.message ?? "Failed to sign download");
        return NextResponse.redirect(data.signedUrl, 302);
      }
    }

    return NextResponse.json({ error: "Invalid file URL" }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to sign download" },
      { status: 500 },
    );
  }
}
