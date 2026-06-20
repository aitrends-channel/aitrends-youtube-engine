import { NextResponse } from "next/server";
import { resolveChannel } from "@/lib/youtube/channel";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { ContentType } from "@/lib/types";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 60;

function parseContentType(raw: unknown): ContentType | null {
  return raw === "long" || raw === "shorts" || raw === "both" ? raw : null;
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  void user; // auth-only — getRequiredUser throws on unauth, value unused

  try {
    const { channelUrl, contentType } = await req.json();
    if (!channelUrl?.trim()) {
      return NextResponse.json({ error: "Channel URL is required" }, { status: 400 });
    }
    // Mirror the channel-page gate on the server — never silently
    // default this since the wrong scope here would commit a wrong-
    // flavor pipeline (Shorts videos analyzed as long-form, etc).
    const scope = parseContentType(contentType);
    if (!scope) {
      return NextResponse.json({ error: "Content type is required (long, shorts, or both)" }, { status: 400 });
    }

    const channelInfo = await resolveChannel(channelUrl.trim(), scope);
    return NextResponse.json(channelInfo);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch channel";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
