export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { listAi33Voices, resolveAi33Voice, isAi33Provider } from "@/lib/ai33/tts";
import { getRequiredUser } from "@/lib/supabase/auth";

// Free-voice catalog for the voiceover step's Free tab — one page of
// ai33's live English voices per request. Paid/ElevenLabs voices come
// from /api/kie/models?type=tts instead; this route is ai33 only.
//
// Auth-gated but NOT plan-gated: the page already hides the grid behind
// the ai33 cap from /api/free-usage, and generateAi33TTS re-checks the
// cap at synthesis time. Listing a voice costs nothing.
export async function GET(req: Request) {
  try { await getRequiredUser(); } catch (e) { return e as Response; }

  const { searchParams } = new URL(req.url);

  // ?id=ai33/… → resolve that one voice to its name/tags, for the
  // selected-voice banner when the project's saved voice isn't in the
  // page of the catalog the picker has loaded.
  const id = searchParams.get("id");
  if (id) {
    try {
      return NextResponse.json({ voice: await resolveAi33Voice(id) });
    } catch {
      return NextResponse.json({ voice: null });
    }
  }

  const genderParam = (searchParams.get("gender") ?? "").toLowerCase();
  const gender = genderParam === "female" ? "Female" : genderParam === "male" ? "Male" : undefined;
  const pageParam = Number(searchParams.get("page"));
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;
  const search = searchParams.get("search")?.trim() || undefined;
  // Anything unrecognized (including "all") means every provider.
  const providerParam = (searchParams.get("provider") ?? "").toLowerCase();
  const provider = isAi33Provider(providerParam) ? providerParam : undefined;

  try {
    const result = await listAi33Voices({ provider, gender, search, page });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list free voices";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
