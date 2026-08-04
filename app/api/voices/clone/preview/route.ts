import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import { generateAi33TTS, Ai33TTSError } from "@/lib/ai33/tts";
import { uploadBuffer, userFolderFor } from "@/lib/supabase/storage";
import { clonedVoiceId } from "@/lib/cloned-voices";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Preview for a cloned voice. Prefers the clip it was cloned from; clones
// made before samples were stored have none, so synthesize one short line
// and keep it — otherwise every play would spend the user's quota again.
const SAMPLE = "Hi — here's a quick sample of how this voice sounds narrating your script.";

export async function GET(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  // Scoped to the caller: a clone id is not permission to hear it.
  const { data: row, error } = await supabase
    .from("cloned_voices")
    .select("id, provider, provider_voice_id, sample_url")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Voice not found." }, { status: 404 });

  // Stream the stored clip rather than redirecting: the client fetches this
  // same-origin, and a cross-origin hop to R2 would trip CORS.
  if (row.sample_url) {
    const upstream = await fetch(row.sample_url).catch(() => null);
    if (upstream?.ok) {
      return new NextResponse(await upstream.arrayBuffer(), {
        headers: {
          "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
  }

  try {
    const { audio } = await generateAi33TTS(SAMPLE, clonedVoiceId(row), user.id);

    // Persist so this is paid for once, not per play. Best-effort.
    try {
      const url = await uploadBuffer(
        `${userFolderFor(user)}/voice-samples/${row.provider_voice_id}-preview.mp3`,
        audio,
        "audio/mpeg",
      );
      await supabase.from("cloned_voices").update({ sample_url: url }).eq("id", row.id);
    } catch (e) {
      console.warn("[clone-preview] cache failed:", e instanceof Error ? e.message : e);
    }

    return new NextResponse(Buffer.from(audio), {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600" },
    });
  } catch (err) {
    if (err instanceof Ai33TTSError) {
      return NextResponse.json({ error: err.message }, { status: err.status ?? 502 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
