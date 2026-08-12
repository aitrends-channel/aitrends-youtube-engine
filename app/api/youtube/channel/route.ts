import { NextResponse } from "next/server";
import { resolveChannel } from "@/lib/youtube/channel";
import { checkChannelInput, channelInputMessage } from "@/lib/youtube/channel-input";
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
    // A video link is the commonest thing pasted into the channel field, and
    // parseChannelUrl would take "/watch" for a handle and ask YouTube about a
    // channel of that name. Refuse it here, in the words the modal uses, so
    // whichever surface called this can show something useful.
    const shape = checkChannelInput(channelUrl);
    if (!shape.ok && shape.problem) {
      const m = channelInputMessage(shape.problem);
      return NextResponse.json({ error: `${m.title}. ${m.hint}`, problem: shape.problem }, { status: 400 });
    }
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
