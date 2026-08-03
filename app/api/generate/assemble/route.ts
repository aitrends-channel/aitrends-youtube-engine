import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { redis } from "@/lib/queue/client";
import { isProResolution, isProTier } from "@/lib/plans-gating";
import type { User } from "@supabase/supabase-js";
import { requireActiveSubscription } from "@/lib/subscription";
import { requireStorageHeadroom } from "@/lib/storage-quota";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const expired = requireActiveSubscription(user);
  if (expired) return expired;
  const noRoom = await requireStorageHeadroom(user);
  if (noRoom) return noRoom;

  const client = await createSupabaseServerClient();

  const body = await req.json().catch(() => ({})) as {
    projectId?: string;
    aspectRatio?: string;
    voiceoverType?: string;
    captionsEnabled?: boolean;
    captionsLanguage?: string;
    captionsStyle?: string;
    captionsSize?: string;
    captionsPosition?: string;
    // Opt-in flag set by the "Trim silences" button on the assemble
    // page. The worker only runs the per-beat silence trim when this
    // is true; a normal Assemble / Reassemble leaves audio untouched.
    trimSilenceEnabled?: boolean;
    // Optional background music: URL to a user-uploaded audio file
    // and a 0–1 volume (default 0.15). The worker downloads the file
    // and mixes it under the voiceover.
    backgroundMusicUrl?: string | null;
    backgroundMusicVolume?: number;
    // Render resolution preset (720p / 1080p / 1440p / 2160p). The
    // worker picks per-aspect-ratio dimensions from this; default
    // 1080p.
    resolution?: "720p" | "1080p" | "1440p" | "2160p";
    // Optional channel logo overlay. URL points at the user-uploaded
    // logo; logoX / logoY are top-left position as fractions of video
    // dimensions (0–1); logoSize is logo width as fraction of video
    // width (0–1).
    logoUrl?: string | null;
    logoX?: number;
    logoY?: number;
    logoSize?: number;
  };

  const { projectId, ...options } = body;
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  // Pro-tier gate. The Assemble UI hides 1440p / 2160p behind the
  // Pro plan and pops the SubscriptionModal when a non-Pro user
  // clicks one. This is the server-side enforcement for the same
  // rule — a hand-crafted POST from devtools (or anywhere else)
  // gets rejected with a 403 instead of silently spending the
  // 4K render budget on a Starter customer.
  if (isProResolution(options.resolution) && !isProTier(user)) {
    return NextResponse.json(
      {
        error: `${options.resolution} output is part of the Pro plan. Upgrade to render at this resolution.`,
        code: "PLAN_REQUIRED",
        requiredPlan: "pro",
      },
      { status: 403 },
    );
  }

  console.log(`[api/generate/assemble] ${projectId}: bgm=${JSON.stringify(options.backgroundMusicUrl)} vol=${JSON.stringify(options.backgroundMusicVolume)} logo=${JSON.stringify(options.logoUrl)} logoXY=${JSON.stringify(options.logoX)},${JSON.stringify(options.logoY)} logoSize=${JSON.stringify(options.logoSize)} keys=[${Object.keys(options).join(",")}]`);
  await redis.set(`assembly:${projectId}`, JSON.stringify(options), { ex: 7200 });

  // Also clear assembly_stop_requested — this endpoint is reached by
  // both fresh assemblies AND Resume. Without this, a leftover true
  // flag from a prior Stop would trip the worker's assertStopRequested
  // check the moment the new run begins.
  //
  // Persist BGM, logo, trim-silence, and the five caption knobs on the
  // project row so a refresh / Resume / return-visit hydrates them.
  // Redis still carries the same values for the worker handoff; the
  // row is the durable copy. Migration 051 added the trim/captions
  // columns; older projects with NULL values fall back to the
  // assemble page's React-side defaults on hydrate.
  const { error } = await client
    .from("projects")
    .update({
      assembly_status: "queued",
      assembly_progress: "Queued…",
      assembly_error: null,
      assembly_stop_requested: false,
      background_music_url: options.backgroundMusicUrl ?? null,
      background_music_volume: typeof options.backgroundMusicVolume === "number" ? options.backgroundMusicVolume : 0.15,
      logo_url: options.logoUrl ?? null,
      logo_x: typeof options.logoX === "number" ? options.logoX : 0.85,
      logo_y: typeof options.logoY === "number" ? options.logoY : 0.05,
      logo_size: typeof options.logoSize === "number" ? options.logoSize : 0.1,
      trim_silence_enabled: typeof options.trimSilenceEnabled === "boolean" ? options.trimSilenceEnabled : true,
      captions_enabled:     typeof options.captionsEnabled     === "boolean" ? options.captionsEnabled     : false,
      captions_language:    typeof options.captionsLanguage    === "string"  ? options.captionsLanguage    : "source",
      captions_style:       typeof options.captionsStyle       === "string"  ? options.captionsStyle       : "classic",
      captions_size:        typeof options.captionsSize        === "string"  ? options.captionsSize        : "medium",
      captions_position:    typeof options.captionsPosition    === "string"  ? options.captionsPosition    : "bottom",
    })
    .eq("id", projectId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ queued: true });
}
