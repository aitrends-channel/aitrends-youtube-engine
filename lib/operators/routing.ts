import { supabase } from "@/lib/supabase/client";
import { type Operator, OPERATOR_KIE, OPERATOR_POYO, OPERATOR_ANTHROPIC } from "./index";
import { isGenAIProModel } from "@/lib/genaipro/status";
import { getFundingModeById } from "@/lib/funding";

// Where new media work goes. Admin-set, global, with per-surface overrides.
//
// Migration 136. Same shape as lib/claude/routing.ts on purpose: a global
// default, an optional override map, resolved at call time, hardcoded fallback.
//
// The relationship with project_beats.image_operator matters and is easy to get
// backwards. This module answers "who should run the next task". The stamped
// column answers "who is running this one". A submit reads this; a poll or a
// webhook must never read it, or flipping the switch sends live tasks to a
// provider that has never heard of their ids.

/** Operators an admin can switch between. GenAIPro is deliberately absent: it
 *  is a free lane on its own wallet, not a general-purpose media provider. */
export const SWITCHABLE_OPERATORS = [OPERATOR_KIE, OPERATOR_POYO, OPERATOR_ANTHROPIC] as const;

/**
 * Which operators a given surface can actually run on.
 *
 * Anthropic serves chat and nothing else: it has no image or video catalog, so
 * a row offering it there would be a button that can only fail. The reverse
 * holds too, which is why this is a map rather than one global list, and why
 * the admin API validates against the surface rather than the union.
 */
export const OPERATORS_FOR_SURFACE: Record<MediaSurface, readonly Operator[]> = {
  chat: [OPERATOR_KIE, OPERATOR_POYO, OPERATOR_ANTHROPIC],
  image: [OPERATOR_KIE, OPERATOR_POYO],
  video: [OPERATOR_KIE, OPERATOR_POYO],
  tts: [],
  transcription: [],
};

/**
 * The provider-integration boundaries, which is the granularity a switch can
 * honestly offer. Splitting finer would let an admin route image_gen and
 * thumbnail_image differently when both are the same client and catalog.
 */
export const MEDIA_SURFACES = ["chat", "image", "video", "tts", "transcription"] as const;
export type MediaSurface = (typeof MEDIA_SURFACES)[number];

/**
 * Surfaces that actually read this switch.
 *
 * The gap between this and MEDIA_SURFACES is the honest state of the
 * migration, and it has to be enforced rather than documented. Only the image
 * paths call getMediaOperator today; chat still routes through
 * lib/claude/routing.ts, tts through lib/kie/tts.ts, and video through
 * video-worker's own client. An admin setting the switch to PoYo therefore
 * moves images and nothing else.
 *
 * Left unenforced, that is a setting which lies: the panel would report the
 * whole workflow on PoYo while three of five surfaces kept billing KIE. The
 * admin API refuses an override for anything not in this list, and reports the
 * list so the panel can say which surfaces a global change will actually move.
 *
 * Add a surface here in the same commit that makes something read it.
 */
export const IMPLEMENTED_SURFACES: readonly MediaSurface[] = ["image", "chat", "video"];

/**
 * Surfaces the switch will never move, by decision rather than by backlog.
 *
 * Voiceover stays on ElevenLabs whatever the operator is. Caption alignment
 * goes with it: it is ElevenLabs Scribe, it is the other half of the same audio
 * pipeline, and PoYo publishes no speech-to-text at all, so there is nothing to
 * switch to even if we wanted to.
 *
 * Distinct from a surface that is merely unimplemented. An admin should be told
 * "this never moves" rather than "not yet", and neither should be silently
 * accepted and stored.
 */
export const EXEMPT_SURFACES: readonly MediaSurface[] = ["tts", "transcription"];

export function isImplementedSurface(s: MediaSurface): boolean {
  return IMPLEMENTED_SURFACES.includes(s);
}

export function isExemptSurface(s: MediaSurface): boolean {
  return EXEMPT_SURFACES.includes(s);
}

function normalise(v: unknown): Operator | null {
  return (SWITCHABLE_OPERATORS as readonly string[]).includes(v as string) ? (v as Operator) : null;
}

/**
 * The operator for new work on this surface.
 *
 * Lookup order, mirroring getAnthropicRouting:
 *   1. the per-surface override, if set
 *   2. the global media_operator
 *   3. 'kie', which is what every deployment ran before the column existed
 *
 * Fails soft. An unreadable config must not stop a generation, and KIE is both
 * the safe answer and the current one.
 */
export async function getMediaOperator(surface?: MediaSurface): Promise<Operator> {
  try {
    const { data } = await supabase
      .from("product_config")
      .select("media_operator, media_operator_per_surface")
      .eq("service", "_global")
      .maybeSingle();

    if (surface) {
      const per = (data?.media_operator_per_surface ?? null) as Record<string, unknown> | null;
      const override = normalise(per?.[surface]);
      if (override) return override;
    }
    return normalise(data?.media_operator) ?? OPERATOR_KIE;
  } catch {
    return OPERATOR_KIE;
  }
}

/**
 * The operator for one user's new work.
 *
 * A BYO client is pinned to KIE whatever the switch says, and this is not a
 * courtesy. Their key is a KIE key; PoYo has no per-client path at all, so a
 * global flip to PoYo would either fail every BYO generation or quietly run it
 * on Heclus's account with no ledger row against the customer. The switch
 * governs work Heclus pays for, which is the same principle that exempts the
 * free lanes.
 *
 * Unreadable funding mode falls through to the admin's choice rather than
 * refusing, matching how getRoutingForUser handles the same read.
 */
export async function getMediaOperatorForUser(userId: string, surface?: MediaSurface): Promise<Operator> {
  try {
    if ((await getFundingModeById(userId)) !== "wallet") return OPERATOR_KIE;
  } catch {
    // Fall through: the admin default is still a valid answer.
  }
  return getMediaOperator(surface);
}

/** The raw override map, with no fallback applied, so the admin panel can show
 *  which surfaces are explicitly set against which inherit. */
export async function getMediaOperatorPerSurface(): Promise<Partial<Record<MediaSurface, Operator>>> {
  const { data } = await supabase
    .from("product_config")
    .select("media_operator_per_surface")
    .eq("service", "_global")
    .maybeSingle();
  const raw = (data?.media_operator_per_surface ?? null) as Record<string, unknown> | null;
  if (!raw) return {};
  const out: Partial<Record<MediaSurface, Operator>> = {};
  for (const s of MEDIA_SURFACES) {
    const v = normalise(raw[s]);
    if (v) out[s] = v;
  }
  return out;
}

/**
 * Whether this image model belongs to a free lane, and so ignores the switch.
 *
 * Free lanes are exempt by design. They run on a separate wallet (GenAIPro's
 * genai_credits) or on the customer's own key (the BYO Cloudflare tier), so
 * moving them onto the switched operator would convert free work into work
 * Heclus pays for, silently, the moment an admin flips a setting.
 *
 * Checked before the config is read at all, so a free-lane model resolves the
 * same way whatever the switch says.
 */
export function isFreeLaneImageModel(modelId: string | null | undefined): boolean {
  // Cloudflare's BYO tier is the only free image lane and is model-prefixed the
  // same way GenAIPro's video is.
  return !!modelId && modelId.toLowerCase().startsWith("cloudflare/");
}

/** Video's free lane: GenAIPro, on its own wallet and its own submit path. */
export function isFreeLaneVideoModel(modelId: string | null | undefined): boolean {
  return isGenAIProModel(modelId);
}
