import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";
import {
  cloneAi33Voice,
  deleteAi33Clone,
  Ai33TTSError,
  AI33_CLONE_MAX_BYTES,
} from "@/lib/ai33/tts";
import { listClonedVoices, clonedVoiceId } from "@/lib/cloned-voices";
import { uploadBuffer, userFolderFor } from "@/lib/supabase/storage";
import { resolveQuotaCap, QUOTA_UNLIMITED } from "@/lib/quota-config";
import { planSlugOf } from "@/lib/plans-gating";
import { isAdminUser } from "@/lib/admin";

// Every clone holds a slot on Heclus's shared ai33 account, so how many a
// user may keep is an admin allocation per plan (Config → Quotas), not a
// constant. 0 means cloning isn't included on that plan.
const cloneCapFor = (user: Parameters<typeof planSlugOf>[0]) =>
  resolveQuotaCap("voice_clones", planSlugOf(user), isAdminUser(user));

export const dynamic = "force-dynamic";

export async function GET() {
  let user;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const [voices, max] = await Promise.all([listClonedVoices(user.id), cloneCapFor(user)]);
    return NextResponse.json({
      voices: voices.map((v) => ({ ...v, voiceId: clonedVoiceId(v) })),
      max,
    });
  } catch (e) {
    // Surface it: a thrown query here used to reach the client as a bare
    // 500, which the picker rendered as "you have no clones".
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let user;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const form = await request.formData().catch(() => null);
  const name = String(form?.get("name") ?? "").trim();
  const audio = form?.get("audio");
  const removeBackground = String(form?.get("remove_background") ?? "") === "true";

  if (!name) return NextResponse.json({ error: "A voice name is required." }, { status: 400 });
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: "An audio sample is required." }, { status: 400 });
  }
  if (audio.size > AI33_CLONE_MAX_BYTES) {
    return NextResponse.json({ error: "That sample is over the 10MB limit." }, { status: 400 });
  }

  // Counted before the upstream call: a clone we can't attribute is a slot
  // burned on the shared account that no user can see or delete.
  const [existing, cap] = await Promise.all([listClonedVoices(user.id), cloneCapFor(user)]);
  // 0 = not included; -1 = unlimited. Only a positive cap is a count.
  if (cap === 0) {
    return NextResponse.json(
      { error: "Voice cloning isn't included on your plan." },
      { status: 403 },
    );
  }
  if (cap !== QUOTA_UNLIMITED && existing.length >= cap) {
    return NextResponse.json(
      { error: `You've used all ${cap} of your cloned voices. Delete one to make room.` },
      { status: 409 },
    );
  }

  let providerVoiceId: string;
  try {
    providerVoiceId = await cloneAi33Voice({
      name,
      audio,
      filename: (audio instanceof File && audio.name) || "sample.mp3",
      removeBackground,
    });
  } catch (e) {
    const status = e instanceof Ai33TTSError ? (e.status ?? 502) : 502;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }

  // Keep the source clip so the picker can preview the voice. Best-effort:
  // a clone without a preview still works, so an upload failure must not
  // strand a voice that already exists upstream.
  let sampleUrl: string | null = null;
  try {
    const ext = (audio instanceof File && audio.name.match(/\.([a-z0-9]+)$/i)?.[1]) || "mp3";
    sampleUrl = await uploadBuffer(
      `${userFolderFor(user)}/voice-samples/${providerVoiceId}.${ext}`,
      await audio.arrayBuffer(),
      audio.type || "audio/mpeg",
    );
  } catch (e) {
    console.warn("[voice-clone] sample upload failed:", e instanceof Error ? e.message : e);
  }

  const { data, error } = await supabase
    .from("cloned_voices")
    .insert({ user_id: user.id, provider: "ai33", provider_voice_id: providerVoiceId, name, sample_url: sampleUrl })
    .select("id, provider, provider_voice_id, name, sample_url, created_at")
    .single();

  // The voice exists upstream but we couldn't record who owns it — release
  // it rather than leave an unattributable clone holding a slot.
  if (error) {
    await deleteAi33Clone(providerVoiceId).catch((e) =>
      console.warn("[voice-clone] orphan cleanup failed:", e instanceof Error ? e.message : e),
    );
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ voice: { ...data, voiceId: clonedVoiceId(data) } });
}

export async function DELETE(request: Request) {
  let user;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  // Scoped to the caller, so one user can't delete another's clone off the
  // shared account.
  const { data: row, error: findErr } = await supabase
    .from("cloned_voices")
    .select("id, provider_voice_id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Voice not found." }, { status: 404 });

  try {
    await deleteAi33Clone(row.provider_voice_id);
  } catch (e) {
    const status = e instanceof Ai33TTSError ? (e.status ?? 502) : 502;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }

  const { error: delErr } = await supabase.from("cloned_voices").delete().eq("id", row.id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
