// What a provider says a clip costs, for models we have never run.
//
// The credit chip on a video model is built from ledger history: the cheapest
// second that model has actually billed us. That is the best number there is,
// because it is what happened rather than what was advertised. It is also
// absent for every model nobody has generated with yet, which reads in the
// picker as a bug rather than as "we do not know".
//
// So: history first, this table second. A figure from here is a FLOOR, not a
// price. Both providers charge by resolution and duration and publish ranges
// wide enough to matter — PoYo lists Kling 2.6 at 65 to 240 credits a clip —
// so the number here is the cheapest option the model offers and the chip says
// "from". The exact figure still comes from the estimator once a resolution and
// duration are chosen, which is what the wallet is actually gated on.
//
// TRANSCRIBED BY HAND, and therefore rotting from the day it was written. The
// PoYo image catalog beside it has already been wrong on four models. Each
// entry carries the date it was copied so a stale one is visible rather than
// merely old. Neither provider offers a rate endpoint: PoYo has no models route
// at all, and kie.ai/pricing refuses automated fetches.

import { seedFloor } from "@/lib/pricing/seed-prices";
import type { SeedProvider } from "@/lib/pricing/seed-types";

/** Where a seeded figure came from, for the `copied` field. */
const SEED_SOURCE = "seed-prices";

export type RateUnit = "clip" | "sec";

export interface VideoRate {
  /** True when the model charges one figure whatever the resolution, so the
   *  chip can state it rather than hedge with "from". */
  exact?: boolean;
  /** Every seeded resolution, when the seed table has them. */
  byResolution?: Record<string, number>;
  /** Cheapest published figure across the resolutions we offer for this model. */
  from: number;
  unit: RateUnit;
  /** When this was read off the provider's pricing page. */
  copied: string;
  /** Anything about the mapping a reader should not have to rediscover. */
  note?: string;
}

/**
 * Keyed by the id in our own picker, not the provider's, so a lookup is one
 * step and a version substitution is written down where it is used.
 */
export const KIE_VIDEO_RATES: Record<string, VideoRate> = {
  veo3: {
    from: 250, unit: "clip", copied: "2026-08-28",
    note: "KIE prices this as Veo 3.1 Quality: 250 at 720p, 255 at 1080p. Our label still says Veo 3.",
  },
  veo3_fast: {
    from: 60, unit: "clip", copied: "2026-08-28",
    note: "KIE prices this as Veo 3.1 Fast: 60 at 720p, 65 at 1080p.",
  },
  "omni-flash": {
    from: 63, unit: "clip", copied: "2026-08-28",
    note: "KIE lists it as google/gemini-omni-flash-1-1: 63 at 4s, up to 252 at 4k with video input.",
  },
};

/**
 * PoYo's published rates, from poyo.ai/pricing.
 *
 * Only the models we actually offer, keyed by our picker's id. Where PoYo
 * quotes per second, the figure is per second and the chip says so; where it
 * quotes per clip, the floor is the shortest, cheapest clip.
 */
export const POYO_VIDEO_RATES: Record<string, VideoRate> = {
  "bytedance/seedance-2": { from: 9, unit: "sec", copied: "2026-08-28", note: "480p 9-20/s, 720p 25-40/s, 1080p 62-90/s." },
  "bytedance/seedance-1.5-pro": { from: 9, unit: "clip", copied: "2026-08-28", note: "9-100 per clip across 4-12s." },
  "kling-2.6/image-to-video": { from: 65, unit: "clip", copied: "2026-08-28", note: "65-240 per clip across 5-10s. Wide: the floor is a poor guide here." },
  "grok-imagine/image-to-video": { from: 30, unit: "clip", copied: "2026-08-28", note: "30-40 per clip." },
  "hailuo/02-image-to-video-pro": { from: 7, unit: "sec", copied: "2026-08-28", note: "7/s, or 65 per clip on the fixed-price path." },
  "sora-2-image-to-video": { from: 48, unit: "sec", copied: "2026-08-28", note: "48/s at 720p, 112/s at 1080p." },
  runway: { from: 75, unit: "clip", copied: "2026-08-28", note: "Gen-4.5, 75-150 per clip across 5-10s." },
  "seedance-2-mini": { from: 6, unit: "sec", copied: "2026-08-28", note: "480p 6-10/s, 720p 12.5-24/s." },
  "omni-flash": { from: 120, unit: "clip", copied: "2026-08-28", note: "120-450 per clip across 4-10s." },
};

/**
 * The published figure for a model on the operator serving it.
 *
 * The seed table first, because it is the same data kept in one place and per
 * resolution rather than one cheapest number, and because the estimator prices
 * from it: a chip quoting a different source than the wallet charges is worse
 * than no chip. The tables above answer only for a model it has no row for.
 *
 * Never crosses operators. This used to fall back to the KIE table when PoYo
 * was serving and had no entry, which quoted kie_credits at a PoYo user. The
 * two are different currencies at different rates, so the number was not high
 * or low, it was in the wrong unit. An operator with no figure for a model now
 * returns null and the chip stays empty, which is the honest answer.
 */
export function publishedVideoRate(modelId: string, operator: string | null | undefined): VideoRate | null {
  const provider: SeedProvider = operator === "poyo" ? "poyo" : "kie";
  const seeded = seedFloor(provider, "video", modelId);
  if (seeded) {
    return {
      from: seeded.value, unit: "sec", copied: SEED_SOURCE,
      exact: !seeded.isFloor, byResolution: seeded.byResolution,
    };
  }
  const table = provider === "poyo" ? POYO_VIDEO_RATES : KIE_VIDEO_RATES;
  return table[modelId] ?? null;
}
