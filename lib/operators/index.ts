// Which provider issued a task id.
//
// A task id only means something to the operator that issued it, so the operator
// is stamped on the beat at submit (migration 134) and read back at poll or
// webhook time rather than re-resolved. Re-resolving is the bug this exists to
// prevent: changing which operator new work prefers would otherwise redirect
// tasks already in flight to a provider that has never heard of them, and an
// orphaned task never settles, so its credit reservation is never released.
//
// Note this is not a hypothetical second lane being prepared for. video_job_id
// is already written by two different providers: video-worker submits to KIE,
// and lib/genaipro/pump.ts submits to GenAIPro on the free lane. Until this
// column existed, telling those apart meant matching on video_model_id, which
// works only because the free models happen to be named after the provider.

export const OPERATORS = ["kie", "genaipro", "poyo"] as const;
export type Operator = (typeof OPERATORS)[number];

/** The paid media lane: images and video through KIE. */
export const OPERATOR_KIE: Operator = "kie";

/** The free video lane, on Heclus's own GenAIPro account against the separate
 *  genai_credits wallet. Video only; it has no image path. */
export const OPERATOR_GENAIPRO: Operator = "genaipro";

/** The second paid media lane. Images today; PoYo serves video too, but video
 *  submission lives in video-worker and has no operator plumbing yet. */
export const OPERATOR_POYO: Operator = "poyo";

/** What a beat is assumed to have run on when nothing says otherwise: the column
 *  default, and what every row predating migration 134 gets. Correct for images,
 *  where KIE is the only submit path. For video the migration backfills the
 *  GenAIPro rows rather than leaving them on this. */
export const DEFAULT_OPERATOR: Operator = "kie";

/**
 * Narrow a value read back from the database.
 *
 * Falls back rather than throwing. A row written by a newer deploy must not
 * break an older one still serving traffic during a rollout, and a display that
 * throws on one unrecognised beat takes the whole project view with it. The
 * caller that cannot actually service the operator is the one that should
 * refuse, at the point it would otherwise poll the wrong provider.
 */
export function parseOperator(v: unknown): Operator {
  return (OPERATORS as readonly string[]).includes(v as string)
    ? (v as Operator)
    : DEFAULT_OPERATOR;
}
